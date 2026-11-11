/**
 * AGEND-181 PR1, server side: thinking is read only for an admin session on the local dashboard (decided at the route,
 * enforced by the parser not being asked — never filtered by the page); `web.log_thinking` (default on) and its
 * Settings contract; the ledger keeps the transcript's anchor for each row across a restart; the launch settings ask
 * Claude Code for thinking summaries only while the Log and thinking are both on.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebRequest } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { bindGuestRequest, guestMessage } from "../src/web-guest-access.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { LogService, type LogServiceDeps } from "../src/log-service.js";
import { parseWebSettingsBody } from "../src/web-settings-patch.js";
import { settingsChangeDiff } from "../src/settings-change.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { WebChatHistory } from "../src/web-chat-history.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";

vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "agend-181-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const TOKEN = "a".repeat(48), origin = "https://fixture.example";
/** GET /ui/steps through the real route as an admin, a read-only session, a guest, or the public link. */
function ask(opts: { tier?: "admin" | "read" | "guest"; gateway?: boolean; query?: string } = {}): Promise<{ status: number; q: any }> {
  const { tier = "admin", gateway = false, query = "instance=w&thinking=1" } = opts;
  const sessions = new WebSessionStore();
  const sid = sessions.create({ tier, surface: gateway ? "gateway" : "local", label: "t", tokenEpoch: tokenEpoch(TOKEN), ...(gateway ? { exposureId: "e1" } : {}), ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "1" } } : {}) }).sessionId as string;
  const req = Object.assign(new EventEmitter(), { method: "GET", url: `/ui/steps?${query}`, headers: { host: gateway ? "fixture.example" : "127.0.0.1:19280", cookie: `${gateway ? "__Host-agend_session" : "agend_session"}=${sid}` } });
  if (gateway) bindGatewayRequest(req as never, { surface: "gateway", exposureId: "e1", expectedOrigin: origin, isCurrent: () => true });
  if (tier === "guest") bindGuestRequest(req as never, { owner: { adapterId: "discord", userId: "1" }, scope: () => new Set(["w"]), current: () => true } as never);
  return new Promise((resolve) => {
    let q: unknown, status = 0;
    const res = { destroyed: false, setHeader() {}, writeHead(n: number) { status = n; return res; }, end() { resolve({ status, q }); } };
    const ctx = { webToken: TOKEN, webSessions: sessions, fleetConfig: { instances: {} }, logger: { info() {}, warn() {}, error() {}, debug() {} },
      logSteps: async (_n: string, query: unknown) => { q = query; return { enabled: true, steps: [] }; } };
    handleWebRequest(req as never, res as never, new URL(req.url, "http://127.0.0.1:19280"), ctx as never);
  });
}

describe("thinking is for an admin session on the local dashboard only (server side)", () => {
  it("admin, local, asked: the service is told thinking is allowed", async () => {
    const r = await ask();
    expect(r.q).toMatchObject({ thinking: true });
  });
  it.each([
    ["not asked", { query: "instance=w" }],
    ["a read-only session", { tier: "read" as const }],
    ["a guest", { tier: "guest" as const }],
    ["the public link", { gateway: true }],
  ])("never: %s", async (_name, opts) => {
    const r = await ask(opts);
    if (r.status === 200) expect(r.q).not.toHaveProperty("thinking");
    else expect(r.q).toBeUndefined();   // refused before the service
  });
});

describe("the service: no parser is asked for thinking unless the request is allowed AND web.log_thinking is not off", () => {
  const rec = (o: unknown) => JSON.stringify(o) + "\n";
  const transcript = () => {
    const f = join(temp(), "t.jsonl");
    writeFileSync(f, rec({ type: "user", promptId: "p1", message: { role: "user", content: "go" } })
      + rec({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "ok" }] } }));
    return f;
  };
  const svc = (over: Partial<LogServiceDeps> = {}, path = transcript()) => new LogService({
    enabled: () => true, known: () => true, source: () => ({ backend: "claude-code", path, format: "claude" }), events: () => [], emit() {}, ...over,
  });
  const kinds = (a: any) => a.steps.map((s: any) => s.kind);
  it("allowed and on: thinking steps, and the answer says so", async () => {
    const a: any = await svc().steps("w", { thinking: true });
    expect(kinds(a)).toContain("thinking");
    expect(a.thinking).toBe(true);
  });
  it("not allowed (the route did not say so): none, in the first read, a read after the cursor, and an older page", async () => {
    const f = transcript();
    const s = svc({}, f);
    const first: any = await s.steps("w", {});
    expect(kinds(first)).not.toContain("thinking");
    expect(first.thinking).toBe(false);
    expect(JSON.stringify(first)).not.toContain("private reasoning");
    expect(JSON.stringify(await s.steps("w", { after: 0, key: first.key }))).not.toContain("private reasoning");
    expect(JSON.stringify(await s.steps("w", { before: first.after, key: first.key }))).not.toContain("private reasoning");
  });
  it("web.log_thinking off: none even for an allowed request", async () => {
    const a: any = await svc({ thinking: () => false }).steps("w", { thinking: true });
    expect(kinds(a)).not.toContain("thinking");
    expect(a.thinking).toBe(false);
  });
  it("the page learns the instance's cwd and the server's home, for display only", async () => {
    const a: any = await svc({ cwd: () => "/work/proj" }).steps("w", {});
    expect(a.cwd).toBe("/work/proj");
    expect(typeof a.home).toBe("string");
  });
});

describe("web.log_thinking in Settings: a boolean, default on; turning it back on is confirmed", () => {
  it("parsed, validated, and judged by direction", () => {
    expect(parseWebSettingsBody({ log_thinking: false })).toMatchObject({ logThinking: false });
    expect(parseWebSettingsBody({ log_thinking: "no" })).toEqual({ error: "log_thinking must be a boolean" });
    expect(validateFleetConfig({ instances: {}, web: { log_thinking: 1 } } as any).errors.map(e => e.path)).toContain("web.log_thinking");
    expect(validateFleetConfig({ instances: {}, web: { log_thinking: false } } as any).errors.map(e => e.path)).not.toContain("web.log_thinking");
    const diff = (a: unknown, b: unknown) => settingsChangeDiff({ fleet: { web: a } }, { fleet: { web: b } }, { operation: "PUT /api/settings/fleet/web" });
    expect(diff({ log_thinking: false }, { log_thinking: true })?.section).toBe("access");   // off → on: looser
    expect(diff({}, { log_thinking: true })).toBeNull();                                      // unset is already on
    expect(diff({}, { log_thinking: false })).toBeNull();                                     // turning it off never needs a confirmation
  });
});

describe("the ledger keeps each row's transcript anchor across a restart", () => {
  it("a person's message is anchored by its message id, an agent reply by what its reply call returned", () => {
    const h = new WebChatHistory({ boot: "aa" });
    const u = h.record({ instance: "w", sender: "web-user", text: "hi", ts: "2026-11-11T06:00:00Z", messageId: "web-1" });
    const a = h.record({ instance: "w", sender: "w", text: "hello", ts: "2026-11-11T06:00:01Z", role: "agent", anchor: "web-2" });
    const p = h.record({ instance: "w", sender: "tg-user", text: "from telegram", ts: "2026-11-11T06:00:02Z", anchor: "12345" });
    expect([u.anchor, a.anchor, p.anchor]).toEqual(["web-1", "web-2", "12345"]);
    expect(h.record({ instance: "w", sender: "w", text: "x", ts: "2026-11-11T06:00:03Z", anchor: "bad id with spaces" }).anchor).toBeUndefined();
  });
  it("kept on disk and restored (while `messageId` stays out of the file, as before)", () => {
    const stored: any[][] = [];
    const store = { schedule: (_n: string, snap: () => any[]) => { stored.push(snap()); }, remove: async () => {} };
    const h = new WebChatHistory({ boot: "aa", store: store as never });
    h.record({ instance: "w", sender: "web-user", text: "hi", ts: "2026-11-11T06:00:00Z", messageId: "web-1" });
    h.record({ instance: "w", sender: "w", text: "hello", ts: "2026-11-11T06:00:01Z", role: "agent", anchor: "web-2" });
    const rows = stored.at(-1)!;
    expect(rows.map((r) => r.anchor)).toEqual(["web-1", "web-2"]);
    expect(rows.some((r) => "messageId" in r)).toBe(false);
    const again = new WebChatHistory({ boot: "bb" });
    again.restore("w", JSON.parse(JSON.stringify(rows)));
    expect(again.list("w", 10).map((m) => m.anchor)).toEqual(["web-1", "web-2"]);
    expect(again.list("w", 10).every((m) => m.messageId === undefined)).toBe(true);
  });
  it("a guest is not given anyone else's anchor", () => {
    const guest = { owner: { adapterId: "discord", userId: "1" } } as never;
    const row = { boot: "aa", id: 1, instance: "w", role: "user", sender: "x", text: "t", ts: "t", anchor: "web-9", from: "discord:2", channel: true } as never;
    expect(guestMessage(row, guest)).not.toHaveProperty("anchor");
  });
});

describe("the launch settings ask Claude Code for thinking summaries only while asked to", () => {
  const written = (over: Record<string, unknown>) => {
    const dir = temp();
    new ClaudeCodeBackend(dir).writeConfig({ workingDirectory: dir, instanceDir: dir, instanceName: "w", mcpServers: {}, ...over } as never);
    return JSON.parse(readFileSync(join(dir, "claude-settings.json"), "utf8"));
  };
  it("on: showThinkingSummaries; otherwise nothing is written for it", () => {
    expect(written({ thinkingSummaries: true }).showThinkingSummaries).toBe(true);
    expect(written({})).not.toHaveProperty("showThinkingSummaries");
    expect(written({ thinkingSummaries: false })).not.toHaveProperty("showThinkingSummaries");
  });
});
