/**
 * #1699 part 2: `/login claude-code <profile>` signs a credential profile in from chat — the backend's own login in the
 * browser terminal, with the profile's variable on the pre-check and on the command, the same canonical path a launch
 * uses; the profile survives every button; only that login's instances are recovered. No profile: exactly as before.
 *
 * The real LoginController (fake terminal session/listener, as login-controller.test), the real TopicCommands parser,
 * FleetManager's real button/slash/offer/recovery methods over plain fakes. Scratch AGEND_HOME/HOME; nothing runs a CLI.
 */
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginController, type LoginChat, type LoginControllerDeps } from "../src/login-controller.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import type { WebTerminalEvents, WebTerminalResult, WebTerminalSpec } from "../src/web-terminal.js";
import { credentialProfileHome } from "../src/backend/credential-profile.js";
import { FleetManager } from "../src/fleet-manager.js";

let root: string, agendHome: string, home: string;
const saved = { AGEND_HOME: process.env.AGEND_HOME, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-login-1699-"));
  agendHome = join(root, "agend"); home = join(root, "home");
  mkdirSync(agendHome, { recursive: true }); mkdirSync(join(home, ".claude"), { recursive: true });
  process.env.AGEND_HOME = agendHome; process.env.HOME = home; delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});
const profileHome = (p: string) => credentialProfileHome(agendHome, "claude-code", p);

class FakeSession extends EventEmitter {
  constructor(readonly spec: WebTerminalSpec, readonly events: WebTerminalEvents) { super(); }
  async start(): Promise<void> {}
  peekAccessToken(): string | null { return "ABCDEFGHJKMNPQRSTVWX"; }
  async cancel(detail = "cancelled"): Promise<void> { await this.finish({ ok: false, reason: "cancel", detail }); }
  async finish(result: WebTerminalResult): Promise<void> { this.emit("finished", result); await this.events.onDone(result); }
}
class FakeHttp {
  constructor(readonly session: FakeSession) {}
  async listen() { return { port: 40001, url: `http://localhost:40001/t/${"ab".repeat(16)}/` }; }
  async close() {}
}
function adapter() {
  return { id: "telegram", type: "telegram", sendText: vi.fn(async () => ({ messageId: "m1", chatId: "chat" })),
    sendDirect: vi.fn(async () => ({ messageId: "d1", chatId: "u1" })) } as unknown as LoginChat["adapter"] & { sendText: ReturnType<typeof vi.fn> };
}
function make() {
  const sessions: FakeSession[] = [];
  const buttons: Array<Parameters<LoginControllerDeps["postButtons"]>[0]> = [];
  const checks: Array<Record<string, string> | undefined> = [];
  const recover = vi.fn(async (..._a: unknown[]) => ({ woken: [] as string[], restarted: [] as string[], pending: [] as string[] }));
  const lock = new LoginWindowLock();
  const deps: LoginControllerDeps = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fleetConfig: () => ({ defaults: {}, instances: {}, hostname: "localhost" }) as never,
    isFleetAdmin: () => true,
    eventLog: () => null,
    recoverBackendInstances: recover as never,
    postButtons: async o => { buttons.push(o); },
    claimWindow: b => lock.tryClaim("web", b), releaseWindow: c => { lock.release(c); },
    isClaimCurrent: c => lock.isCurrent(c), windowBusyMessage: () => lock.busyMessage(),
    checkAuth: async (_check, env) => { checks.push(env); return "invalid"; },
    createSession: (spec, ev) => { const s = new FakeSession(spec, ev); sessions.push(s); return s as never; },
    createHttp: s => new FakeHttp(s as unknown as FakeSession) as never,
  };
  return { controller: new LoginController(deps), sessions, buttons, checks, recover, lock };
}
const chat = (a = adapter()): LoginChat => ({ adapter: a, adapterId: "telegram", chatId: "chat", threadId: "topic", userId: "admin-1" });

describe("#1699 part 2: the controller signs a profile in", () => {
  it("no profile: the command and the pre-check are exactly as before", async () => {
    const r = make();
    await r.controller.start("claude-code", chat());
    expect(r.checks).toEqual([undefined]);
    expect(r.buttons[0]!.profile).toBeUndefined();
    await r.controller.start("claude-code", chat(), { skipAuthCheck: true });
    expect(r.sessions[0]!.spec.command).toBe("claude auth login");
    expect(existsSync(join(agendHome, "credential-profiles")), "no profile directory").toBe(false);
  });

  it("a profile: pre-check with its variable, buttons carry it, the command is its exact line, the home is prepared", async () => {
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "mine");
    const r = make();
    const a = adapter();
    expect(await r.controller.start("claude-code", chat(a), { profile: "work" })).toBeNull();
    expect(r.checks).toEqual([{ CLAUDE_CONFIG_DIR: profileHome("work") }]);
    expect(r.buttons[0]!.profile).toBe("work");
    expect(r.buttons[0]!.message).toContain("claude-code profile `work`");
    expect(lstatSync(join(profileHome("work"), "CLAUDE.md")).isSymbolicLink(), "prepared as a launch prepares it").toBe(true);

    const started = await r.controller.start("claude-code", chat(a), { skipAuthCheck: true, profile: "work" });
    expect(started).toContain("claude-code profile `work`");
    expect(r.sessions[0]!.spec.command).toBe(`CLAUDE_CONFIG_DIR='${profileHome("work")}' claude auth login`);
    expect(String(a.sendText.mock.calls.map(c => c[1]).join("\n"))).toContain(`CLAUDE_CONFIG_DIR='${profileHome("work")}' claude auth login`);
  });

  it("success recovers that login only; a default login recovers the default one", async () => {
    const r = make();
    await r.controller.start("claude-code", chat(), { skipAuthCheck: true, profile: "work" });
    await r.sessions[0]!.finish({ ok: true } as WebTerminalResult);
    expect(r.recover).toHaveBeenLastCalledWith("claude-code", "work");
    await r.controller.start("claude-code", chat(), { skipAuthCheck: true });
    await r.sessions[1]!.finish({ ok: true } as WebTerminalResult);
    expect(r.recover).toHaveBeenLastCalledWith("claude-code");
  });

  it("an invalid name is refused before anything is claimed or created", async () => {
    const r = make();
    for (const bad of ["../escape", "a b", "", "-x"]) {
      expect(await r.controller.start("claude-code", chat(), { profile: bad })).toContain("is not a credential profile name");
    }
    expect(r.sessions).toEqual([]); expect(r.buttons).toEqual([]);
    expect(r.lock.tryClaim("web", "claude-code"), "nothing left claimed").not.toBeNull();
    expect(existsSync(join(agendHome, "credential-profiles"))).toBe(false);
  });

  it("kiro-cli and codex profiles: the exact host command, nothing started from chat", async () => {
    const r = make();
    const kiro = await r.controller.start("kiro-cli", chat(), { profile: "work" });
    expect(kiro).toContain(`XDG_DATA_HOME=${JSON.stringify(credentialProfileHome(agendHome, "kiro-cli", "work"))} kiro-cli login`);
    const codex = await r.controller.start("codex", chat(), { profile: "work" });
    expect(codex).toContain(`CODEX_HOME=${JSON.stringify(credentialProfileHome(agendHome, "codex", "work"))} codex login`);
    expect(r.sessions).toEqual([]); expect(r.buttons).toEqual([]); expect(r.checks).toEqual([]);
  });
});

describe("#1699 part 2: the chat surfaces carry the profile", () => {
  async function typed(text: string) {
    const { TopicCommands } = await import("../src/topic-commands.js");
    const startLoginSession = vi.fn(async (..._args: unknown[]) => "started");
    const a = adapter();
    const ctx: any = { isFleetAdmin: () => true, startLoginSession, promptLoginBackends: vi.fn(async () => undefined), cancelLoginSession: vi.fn(async () => "x"),
      fleetConfig: { instances: {}, defaults: {} } };
    const cmds: any = new TopicCommands(ctx);
    cmds.getReplyAdapter = () => a;
    await cmds.handleLoginCommand({ text, chatId: "c", threadId: "t", userId: "u", adapterId: "telegram" });
    return { startLoginSession, sent: a.sendText.mock.calls.map(c => String(c[1])) };
  }

  it("typed: `/login claude-code work` and the `claude` alias pass the profile; one word passes none", async () => {
    expect((await typed("/login claude-code work")).startLoginSession.mock.calls[0]!.slice(2)).toEqual([{ profile: "work" }]);
    expect((await typed("/login claude work")).startLoginSession.mock.calls[0]![0]).toBe("claude");
    expect((await typed("/login claude-code")).startLoginSession.mock.calls[0]!.length, "no third argument").toBe(2);
  });

  it("typed: three words, or a profile after a word that is no backend (`/login reinstall codex`, `/login constructor x`), is usage", async () => {
    for (const text of ["/login claude-code work extra", "/login reinstall codex", "/login constructor x"]) {
      const r = await typed(text);
      expect(r.startLoginSession, text).not.toHaveBeenCalled();
      expect(r.sent.at(-1), text).toContain("Usage");
    }
  });

  const fm = () => {
    const f: any = Object.create(FleetManager.prototype);
    f.startLoginSession = vi.fn(async () => "started");
    f.isFleetAdmin = () => true;
    return f;
  };

  it("Discord: the slash `profile` option reaches the login; without it, nothing extra", async () => {
    const f = fm();
    const respond = vi.fn(async () => {});
    await f.handleLoginSlash({ userId: "u", channelId: "c", options: { backend: "claude-code", profile: " work " }, respond }, "discord", adapter());
    expect(f.startLoginSession.mock.calls[0].slice(2)).toEqual([{ profile: "work" }]);
    await f.handleLoginSlash({ userId: "u", channelId: "c", options: { backend: "claude-code" }, respond }, "discord", adapter());
    expect(f.startLoginSession.mock.calls[1].length).toBe(2);
  });

  it("a confirm click and a re-login button keep the profile (never the default login)", async () => {
    const f = fm();
    const entry = { instanceName: "claude-code", loginProfile: "work", adapter: adapter(), adapterId: "telegram", chatId: "c", threadId: "t", messageId: "m" };
    f.consumeNonceCallback = () => ({ entry, action: "go" });
    f.retireNonceButtons = vi.fn(async () => {}); f.postPromptOutcome = vi.fn(async () => {});
    await f.handleLoginConfirm({ userId: "u", messageId: "m" }, "telegram");
    expect(f.startLoginSession.mock.calls[0][2]).toMatchObject({ skipAuthCheck: true, profile: "work" });
    expect(f.retireNonceButtons.mock.calls[0][2]).toContain("claude-code profile `work`");

    f.consumeNonceCallback = () => ({ entry, action: "claude-code" });
    await f.handleLoginBackendSelect({ userId: "u", messageId: "m" }, "telegram");
    expect(f.startLoginSession.mock.calls[1].slice(2)).toEqual([{ profile: "work" }]);
  });

  it("the auth alert's button: posted with the profile for claude-code, not at all for a kiro profile", async () => {
    const f = fm();
    f.getInstanceAdapterId = () => "telegram"; f.getAdapterForInstance = () => adapter(); f.getGroupIdForInstance = () => "g";
    f.fleetConfig = { instances: { w: { topic_id: 7 } } };
    f.postNonceButtonPrompt = vi.fn(async () => "nonce");
    await f.offerBackendLogin("w", "claude-code", "work");
    expect(f.postNonceButtonPrompt.mock.calls[0][0]).toMatchObject({ extra: { loginProfile: "work" }, message: expect.stringContaining("claude-code profile `work`") });
    await f.offerBackendLogin("w", "kiro-cli", "work");
    expect(f.postNonceButtonPrompt).toHaveBeenCalledTimes(1);
    await f.offerBackendLogin("w", "claude-code");
    expect(f.postNonceButtonPrompt.mock.calls[1][0].extra).toBeUndefined();
  });

  /** The real startLoginSession with the installer and the sign-in as seams (#1711 r1). */
  const routed = (installed: boolean) => {
    const f: any = Object.create(FleetManager.prototype);
    f.isCliInstalled = () => installed;
    f.startInstallSession = vi.fn(async () => "installing");
    f.launchSignIn = vi.fn(async () => "signing in");
    f.recordLoginFlow = () => {};
    return f;
  };

  it("#1711 P2-1: a profile is admitted BEFORE the install-first routing: nothing is installed for a refused one", async () => {
    for (const [backend, profile, says] of [
      ["claude-code", "../escape", "is not a credential profile name"],
      ["kiro-cli", "work", "kiro-cli login"],
      ["codex", "work", "codex login"],
    ] as const) {
      const f = routed(false);
      const text = await f.startLoginSession(backend, chat(), { profile });
      expect(f.startInstallSession, `${backend} ${profile}`).not.toHaveBeenCalled();
      expect(f.launchSignIn).not.toHaveBeenCalled();
      expect(text).toContain(says);
    }
    const ok = routed(false);
    await ok.startLoginSession("claude", chat(), { profile: "work" });
    expect(ok.startInstallSession, "control: a valid claude profile still installs first").toHaveBeenCalledWith("claude-code", expect.anything(), { profile: "work" });
  });

  it("#1711 P2-2: a supplied Discord profile is never dropped — without a backend, or blank", async () => {
    const respond = vi.fn(async (_t: string) => {});
    const f = routed(true);
    f.isFleetAdmin = () => true;
    f.promptLoginBackends = vi.fn(async () => undefined);
    await f.handleLoginSlash({ userId: "u", channelId: "c", options: { profile: "work" }, respond }, "discord", adapter());
    expect(f.promptLoginBackends, "not the default login's picker").not.toHaveBeenCalled();
    expect(String(respond.mock.calls.at(-1)![0])).toContain("needs its backend");
    await f.handleLoginSlash({ userId: "u", channelId: "c", options: { backend: "claude-code", profile: "   " }, respond }, "discord", adapter());
    expect(f.launchSignIn, "a blank profile is not the default login").not.toHaveBeenCalled();
    expect(String(respond.mock.calls.at(-1)![0])).toContain("is not a credential profile name");
    await f.handleLoginSlash({ userId: "u", channelId: "c", options: {}, respond }, "discord", adapter());
    expect(f.promptLoginBackends, "control: bare /login opens the picker").toHaveBeenCalledTimes(1);
  });

  it("the fleet's wiring of the controller: buttons carry the profile into their nonce entry; recovery gets it", async () => {
    const f: any = Object.create(FleetManager.prototype);
    f.logger = { debug() {}, info() {}, warn() {}, error() {} };
    f.postNonceButtonPromptOrThrow = vi.fn(async () => {});
    f.recoverBackendInstances = vi.fn(async () => ({ woken: [], restarted: [], pending: [] }));
    const deps = (f.webLogin as any).deps as LoginControllerDeps;
    const base = { prefix: "login-confirm:", instanceName: "claude-code", chat: chat(), message: "m", choices: [], expiredText: "x" };
    await deps.postButtons({ ...base, profile: "work" });
    expect(f.postNonceButtonPromptOrThrow.mock.calls[0][0].extra).toEqual({ loginProfile: "work" });
    await deps.postButtons(base);
    expect(f.postNonceButtonPromptOrThrow.mock.calls[1][0].extra).toBeUndefined();
    await deps.recoverBackendInstances("claude-code", "work");
    expect(f.recoverBackendInstances).toHaveBeenLastCalledWith("claude-code", undefined, "work");
    await deps.recoverBackendInstances("claude-code");
    expect(f.recoverBackendInstances).toHaveBeenLastCalledWith("claude-code", undefined, null);
  });

  it("recovery after a login touches only the instances on that login", async () => {
    const f: any = Object.create(FleetManager.prototype);
    f.fleetConfig = { defaults: {}, instances: {
      plain: { backend: "claude-code" },
      work1: { backend: "claude-code", backend_options: { "claude-code": { credential_profile: "work" } } },
      other: { backend: "claude-code", backend_options: { "claude-code": { credential_profile: "other" } } },
      cx: { backend: "codex" },
    } };
    f.lifecycle = { daemons: new Map() };
    f.configuredBackendInstanceNames = () => Object.keys(f.fleetConfig.instances);
    f.backendNameOf = (n: string) => f.fleetConfig.instances[n].backend;
    f.getInstanceStatus = () => "running";
    f.restartSingleInstance = vi.fn(async () => {});
    expect((await f.recoverBackendInstances("claude-code", undefined, "work")).restarted).toEqual(["work1"]);
    expect((await f.recoverBackendInstances("claude-code")).restarted, "the default login: only its own").toEqual(["plain"]);
  });
});
