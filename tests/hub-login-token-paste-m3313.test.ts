import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginController, PASTED_TOKEN_MASK, type LoginControllerDeps, type LoginChat } from "../src/login-controller.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { FleetManager } from "../src/fleet-manager.js";
import { t } from "../src/locale.js";
import type { WebTerminalEvents, WebTerminalResult, WebTerminalSpec } from "../src/web-terminal.js";

/**
 * M-3313 (#4145 for the Hub; Fable on #4152): a live /login access token pasted into a Hub room or a 1:1 Hub question
 * reached the agent as it was. Now what the Fleet hands the agent (a Hub question — room or 1:1 — and a room
 * notification) has it hidden, by the same exact match as a chat's; the live one is taken back and a new one sent
 * privately, and the chat the sign-in was started from is told (AgEnD has no reply of its own in a Hub room). The Hub's
 * own copy of the post is beyond the Fleet (encrypted, until its retention deletes it): the token in it no longer works.
 */
const TOKENS = ["ABCDEFGHJKMNPQRSTVWX", "QQQQQQQQQQQQQQQQQQQ2", "ZZZZZZZZZZZZZZZZZZZ3"];

class FakeSession extends EventEmitter {
  state: "created" | "running" | "finished" = "created";
  private n = 0;
  token: string | null = TOKENS[0];
  constructor(readonly spec: WebTerminalSpec, readonly events: WebTerminalEvents) { super(); }
  async start(): Promise<void> { this.state = "running"; }
  peekAccessToken(): string | null { return this.token; }
  rotateAccessToken(): boolean {
    if (this.state !== "running" || this.token === null) return false;
    this.token = TOKENS[++this.n];
    return true;
  }
  async cancel(detail = "cancelled"): Promise<void> { await this.finish({ ok: false, reason: "cancel", detail }); }
  async finish(result: WebTerminalResult): Promise<void> {
    this.state = "finished"; this.token = null; this.emit("finished", result); await this.events.onDone(result);
  }
}
class FakeHttp {
  constructor(readonly session: FakeSession, readonly opts: { hostname?: string }) {}
  async listen(): Promise<{ port: number; url: string }> { return { port: 40001, url: `http://${this.opts.hostname ?? "localhost"}:40001/t/${"ab".repeat(16)}/` }; }
  async close(): Promise<void> { /* closed */ }
}

function adapterOf(type: "discord" | "telegram", opts: { directFails?: boolean } = {}) {
  return {
    id: type, type,
    sendText: vi.fn(async () => ({ messageId: "m1", chatId: "chat" })),
    sendDirect: vi.fn(async () => { if (opts.directFails) throw new Error("Cannot send messages to this user"); return { messageId: "d1", chatId: "u1" }; }),
  } as unknown as LoginChat["adapter"] & { sendText: ReturnType<typeof vi.fn>; sendDirect: ReturnType<typeof vi.fn> };
}

function controllerFor() {
  const sessions: FakeSession[] = [];
  const audits: string[] = [];
  const lock = new LoginWindowLock();
  const deps: LoginControllerDeps = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    fleetConfig: () => ({ defaults: {}, instances: {}, hostname: "fleet.example" }) as never,
    isFleetAdmin: () => true,
    eventLog: () => ({ insert: (_i: string, type: string, payload?: Record<string, unknown>) => { audits.push(`${type} ${JSON.stringify(payload ?? {})}`); } }) as never,
    recoverBackendInstances: async () => ({ woken: [], restarted: [], pending: [] }),
    postButtons: async () => {},
    claimWindow: backend => lock.tryClaim("web", backend),
    releaseWindow: c => { lock.release(c); },
    isClaimCurrent: c => lock.isCurrent(c),
    windowBusyMessage: backend => lock.busyMessage(backend),
    windowHolder: backend => lock.holderFor(backend),
    checkAuth: async () => "invalid",
    createSession: (spec, ev) => { const s = new FakeSession(spec, ev); sessions.push(s); return s as never; },
    createHttp: (s, _l, o) => new FakeHttp(s as unknown as FakeSession, o) as never,
  };
  return { controller: new LoginController(deps), sessions, audits };
}
const chatOf = (adapter: LoginChat["adapter"]): LoginChat => ({ adapter, adapterId: adapter.type, chatId: "chat", threadId: "topic", userId: "admin-1" });
const QUESTION = `Room "Ops" — Sam asked:\nhere is my code ${TOKENS[0]} can you sign me in?\nEarlier: Sam: hi`;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

async function rig(signIn = true) {
  const dir = mkdtempSync(join(tmpdir(), "agend-m3313-")); dirs.push(dir);
  const fm: any = new FleetManager(dir);
  fm.fleetConfig = { instances: {} };
  vi.spyOn(fm, "hubAgentConfig").mockReturnValue({ backend: "claude-code" });
  const delivered = vi.spyOn(fm, "deliverToInstance").mockImplementation(async (_a: any, _p: any, opts: any) => { await opts.beforeInput?.(); return true; });
  const lines: string[] = [];
  for (const level of ["info", "warn", "debug", "error"] as const) vi.spyOn(fm.logger, level).mockImplementation(((...a: unknown[]) => { lines.push(JSON.stringify(a)); }) as never);
  const login = controllerFor();
  fm.loginController = login.controller;
  const chat = adapterOf("telegram");
  if (signIn) await login.controller.start("claude-code", chatOf(chat), { skipAuthCheck: true });
  chat.sendText.mockClear(); chat.sendDirect.mockClear();
  return { fm, delivered, lines, login, chat, stop: () => fm.stormWindow?.shutdown?.() };
}
const question = (text: string, room = true) => ({ agent: "worker", correlationId: room ? `hub-room-${randomUUID()}` : `hub-${randomUUID()}`, text,
  contactLimit: false, stillCurrent: () => true, beforeInput: async () => true });

describe("a sign-in token in a Hub question", () => {
  it.each([["a room ask", true], ["a 1:1 ask", false]])("%s: hidden from the agent; taken back; a new one privately; the sign-in's chat told", async (_n, room) => {
    const r = await rig();
    try {
      expect(await r.fm.deliverHubQuestion(question(QUESTION, room))).toBe(true);
      const content = String((r.delivered.mock.calls[0][1] as any).content);
      expect(content).not.toMatch(new RegExp(`${TOKENS[0]}|${TOKENS[1]}`, "i"));
      expect(content).toContain(PASTED_TOKEN_MASK);
      expect(content).toContain("can you sign me in?");
      await vi.waitFor(() => expect(r.login.sessions[0].peekAccessToken()).toBe(TOKENS[1]));
      await vi.waitFor(() => expect(r.chat.sendText).toHaveBeenCalledWith("chat", t("login.token_pasted_hub", "claude-code"), { threadId: "topic" }));
      expect(String(r.chat.sendDirect.mock.calls[0][1])).toContain(TOKENS[1]);
      expect(r.lines.join("\n")).not.toMatch(new RegExp(`${TOKENS[0]}|${TOKENS[1]}`, "i"));
    } finally { r.stop(); }
  });
  it("a room notification (a reply to the agent's post, a reminder) is hidden too", async () => {
    const r = await rig();
    try {
      expect(await r.fm.deliverHubRoomNotification({ agent: "worker", id: randomUUID(), kind: "answer-reminder", text: `Sam replied: ${TOKENS[0].toLowerCase()}`,
        beforeInput: async () => true, stillCurrent: () => true })).toBe(true);
      expect(String((r.delivered.mock.calls[0][1] as any).content)).toBe(`Sam replied: ${PASTED_TOKEN_MASK}`);
      await vi.waitFor(() => expect(r.login.sessions[0].peekAccessToken()).toBe(TOKENS[1]));
    } finally { r.stop(); }
  });
  it("a second copy is hidden but not taken back again; a question without the token, or with no sign-in running, is untouched", async () => {
    const r = await rig();
    try {
      await r.fm.deliverHubQuestion(question(QUESTION));
      await vi.waitFor(() => expect(r.login.sessions[0].peekAccessToken()).toBe(TOKENS[1]));
      await r.fm.deliverHubQuestion(question(QUESTION));
      expect(String((r.delivered.mock.calls[1][1] as any).content)).not.toContain(TOKENS[0]);
      expect(r.login.sessions[0].peekAccessToken()).toBe(TOKENS[1]);
      await r.fm.deliverHubQuestion(question("What is the plan?"));
      expect((r.delivered.mock.calls[2][1] as any).content).toBe("What is the plan?");
    } finally { r.stop(); }
    const idle = await rig(false);
    try {
      await idle.fm.deliverHubQuestion(question(QUESTION));
      expect((idle.delivered.mock.calls[0][1] as any).content).toBe(QUESTION);
    } finally { idle.stop(); }
  });
});
