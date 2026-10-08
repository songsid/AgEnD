import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Install sessions must never touch a real tmux server in unit tests.
const installSessions: Array<{ flow: any; cancelled: string[]; events?: any }> = [];
// #1361: same leak as install-cli.test.ts — TmuxManager.socketName is null
// until setSocketName, so ensureSession went to the live default server.
// Pin a private socket AND stub tmux behind an -L guard.
const TMUX_SOCKET = "agend-test-login-web";
const tmuxGuard = vi.hoisted(() => ({ withoutL: [] as string[][] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const sessions = new Set<string>();
  const fakeChild = { stdin: { on() {}, end() {} } };
  const fakeExecFile = (file: string, args: unknown, opts: unknown, cb: unknown) => {
    const callback = (typeof opts === "function" ? opts : cb) as ((...a: any[]) => void) | undefined;
    if (file !== "tmux") return (real.execFile as any)(file, args, opts, cb);
    const argv: string[] = Array.isArray(args) ? args : [];
    if (argv[0] !== "-L" || typeof argv[1] !== "string" || argv[1].length === 0) {
      tmuxGuard.withoutL.push(argv);
      const err = new Error(`tmux without socket isolation: tmux ${argv.join(" ")}`);
      if (callback) { queueMicrotask(() => callback(err)); return fakeChild; }
      throw err;
    }
    const rest = argv.slice(2);
    const flag = (name: string) => { const i = rest.indexOf(name); return i === -1 ? undefined : rest[i + 1]; };
    const done = () => {
      if (!callback) return;
      const sub = rest[0];
      if (sub === "has-session") {
        const name = flag("-t") ?? "";
        if (sessions.has(name)) { callback(null, "", ""); return; }
        const err = Object.assign(new Error(`can't find session: ${name}`),
          { code: 1, stdout: "", stderr: `can't find session: ${name}` });
        callback(err);
        return;
      }
      if (sub === "new-session") { const name = flag("-s"); if (name) sessions.add(name); callback(null, "", ""); return; }
      if (sub === "kill-session") { const name = flag("-t"); if (name) sessions.delete(name); callback(null, "", ""); return; }
      if (sub === "kill-server") { sessions.clear(); callback(null, "", ""); return; }
      callback(null, "", "");
    };
    queueMicrotask(done);
    return fakeChild;
  };
  return { ...real, execFile: fakeExecFile };
});
let onInstallStart: (() => Promise<void>) | null = null;
vi.mock("../src/login-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/login-manager.js")>();
  class FakeLoginSession {
    state = "starting";
    record: { flow: any; cancelled: string[]; events?: any };
    constructor(readonly flow: any, _tmux: any, readonly events: any) { this.record = { flow, cancelled: [], events }; installSessions.push(this.record); }
    async start() { if (onInstallStart) await onInstallStart(); }
    async cancel(detail = "cancelled") { this.state = "done"; this.record.cancelled.push(detail); await this.events.onDone({ ok: false, detail }); }
  }
  return { ...real, LoginSession: FakeLoginSession };
});
vi.mock("../src/instance-lifecycle.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/instance-lifecycle.js")>();
  return { ...real, checkBinaryInstalled: () => false };
});
import { FleetManager } from "../src/fleet-manager.js";
import { LoginController } from "../src/login-controller.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";
import { t } from "../src/locale.js";

/**
 * FleetManager side of PR-B: the fleet-wide single-window rule across web
 * login and install, and the shutdown teardown of both.
 */
describe("/login dispatch and exclusivity", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `login-web-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    installSessions.length = 0;
    onInstallStart = null;
    tmuxGuard.withoutL.length = 0;
    TmuxManager.setSocketName(TMUX_SOCKET);
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "logged out" }));   // pre-check: invalid → straight to login
  });
  afterEach(() => {
    expect(tmuxGuard.withoutL, "tmux without -L socket isolation").toEqual([]);
    TmuxManager.setSocketName(null);
    setAuthCheckRunnerForTests(null);
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(login?: { mode: "relay" }) {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: {}, instances: {}, login } as any;
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);
    // These are sign-in paths: the CLIs count as installed (on a host without
    // them, /login would install first — covered in login-one-entry-1131).
    vi.spyOn(fm, "isCliInstalled").mockReturnValue(true);
    const adapter = {
      id: "discord", type: "discord",
      sendText: vi.fn().mockResolvedValue({ messageId: "m1" }),
      sendDirect: vi.fn().mockResolvedValue({ messageId: "d1" }),
      notifyAlert: vi.fn(async (chatId: string) => ({ messageId: "p1", chatId })),
      editMessageRemoveButtons: vi.fn().mockResolvedValue(undefined),
    } as any;
    const chat = { adapter, adapterId: "discord", chatId: "chat", threadId: "topic", userId: "admin" };
    return { fm, adapter, chat };
  }

  it("/login signs in through the web controller; no login window session is created by the sign-in itself", async () => {
    const { fm, chat } = setup();
    const start = vi.spyOn(LoginController.prototype, "start").mockResolvedValue("web-started");
    expect(await fm.startLoginSession("codex", chat)).toBe("web-started");
    expect(start).toHaveBeenCalledWith("codex", expect.objectContaining({ userId: "admin" }), expect.anything());
    expect(installSessions).toHaveLength(0);
  });

  it("login.mode: relay (removed, #1139) is accepted and ignored: the same web path, one warning", async () => {
    const { fm, chat } = setup({ mode: "relay" });
    const start = vi.spyOn(LoginController.prototype, "start").mockResolvedValue("web-started");
    expect(await fm.startLoginSession("codex", chat)).toBe("web-started");
    expect(start).toHaveBeenCalledTimes(1);
    expect(installSessions).toHaveLength(0);
  });

  it("the removed login.mode: relay logs ONE warning per process, however often the config is reloaded; web / no mode say nothing", () => {
    const configPath = join(tmpDir, "fleet.yaml");
    const fm = new FleetManager(tmpDir);
    const warn = vi.spyOn((fm as any).logger, "warn").mockImplementation((() => {}) as never);
    writeFileSync(configPath, "defaults: {}\ninstances: {}\nlogin:\n  mode: web\n");
    fm.loadConfig(configPath);
    expect(warn).not.toHaveBeenCalled();
    writeFileSync(configPath, "defaults: {}\ninstances: {}\nlogin:\n  mode: relay\n");
    fm.loadConfig(configPath);
    fm.loadConfig(configPath);
    const mentions = warn.mock.calls.filter(call => String(call[0]).includes("login.mode: relay"));
    expect(mentions).toHaveLength(1);
    expect(String(mentions[0]![0])).toContain("web terminal");
  });

  it("a login-menu: button from before the upgrade gets the expired-prompt treatment, not silence", async () => {
    const { fm, adapter } = setup();
    const claimed = vi.spyOn(fm as any, "consumeNonceCallback").mockImplementation(((prefix: string) => prefix === "login-menu:" ? { entry: {}, action: "0" } : null) as never);
    const handled = (fm as any).handleRetiredPromptButton({ callbackData: "login-menu:abc:0", userId: "admin", chatId: "chat" }, "discord", adapter);
    expect(handled).toBe(true);
    expect(claimed.mock.calls.map(call => call[0])).toContain("login-menu:");
  });

  it("while a web login is active: install is refused and /login cancel reaches the controller", async () => {
    const { fm, chat } = setup();
    vi.spyOn(LoginController.prototype, "start").mockResolvedValue("web-started");
    vi.spyOn(LoginController.prototype, "isActive").mockReturnValue(true);
    vi.spyOn(LoginController.prototype, "activeBackend", "get").mockReturnValue("codex");
    const cancel = vi.spyOn(LoginController.prototype, "cancel").mockResolvedValue("web-cancelled");
    await fm.startLoginSession("codex", chat);
    (fm as any).loginWindow.tryClaim("web", "codex");                             // what the real start() does before its first await
    expect(await fm.startInstallSession("grok", chat)).toBe(t("login.busy", "codex"));
    expect(await fm.cancelLoginSession()).toBe("web-cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("B1 (round 2): a rejected ensureSession releases the install claim — the next start can claim", async () => {
    const { fm, chat } = setup();
    const ensure = vi.spyOn(TmuxManager, "ensureSession").mockRejectedValueOnce(new Error("tmux server unavailable"));
    expect(await fm.startInstallSession("grok", chat)).toBe(t("install.failed", "grok", "tmux server unavailable"));
    expect((fm as any).loginWindow.isHeld).toBe(false);
    ensure.mockResolvedValue(undefined);
    expect(await fm.startInstallSession("grok", chat)).toBe(t("install.started", "grok"));
  });

  it("B1 (round 6): the shutdown deadline is loud and releases nothing — a teardown still running at 60 s is still awaited, at 120 s it is reported", async () => {
    vi.useFakeTimers();
    try {
      const { fm } = setup();
      let release!: () => void;
      vi.spyOn(LoginController.prototype, "shutdown").mockImplementation(() => new Promise<void>(r => { release = r; }));
      (fm as any).webLogin;
      const errors: string[] = [];
      vi.spyOn((fm as any).logger, "error").mockImplementation(((_o: unknown, msg?: string) => { errors.push(String(msg)); }) as never);
      const inserted: string[] = [];
      (fm as any).eventLog = { insert: (_i: string, type: string) => { inserted.push(type); } };
      let settled = false;
      const p = (fm as any).shutdownLoginWindows().then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);                                            // no early "done"
      await vi.advanceTimersByTimeAsync(60_001);
      await p;
      expect(errors.some(m => m.includes("shutdown deadline"))).toBe(true);
      expect(inserted).toContain("login_window_shutdown_deadline");
      expect((fm as any).loginWindow.isClosed).toBe(true);                   // still closed: nothing re-claimable
      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("M1 (round 7): a teardown that completes quickly leaves no armed deadline — 130 s later there is no error and no event", async () => {
    vi.useFakeTimers();
    try {
      const { fm } = setup();
      vi.spyOn(LoginController.prototype, "shutdown").mockResolvedValue(undefined);
      (fm as any).webLogin;
      const errors: string[] = [];
      vi.spyOn((fm as any).logger, "error").mockImplementation(((_o: unknown, msg?: string) => { errors.push(String(msg)); }) as never);
      const inserted: string[] = [];
      (fm as any).eventLog = { insert: (_i: string, type: string) => { inserted.push(type); } };
      await (fm as any).shutdownLoginWindows();
      await vi.advanceTimersByTimeAsync(130_000);
      expect(errors).toEqual([]);
      expect(inserted).not.toContain("login_window_shutdown_deadline");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Antigravity declines — no silent fallback, no session", async () => {
    const { fm, chat } = setup();
    const text = await fm.startLoginSession("agy", chat);
    expect(text).toBe(t("login.remote_unsupported_agent_cli", "antigravity", "agy"));
    expect(installSessions).toHaveLength(0);
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });

  it("N1: install windows cancelled by shutdown stay quiet — no 'failed — fleet shutdown' message", async () => {
    const { fm, chat, adapter } = setup();
    await fm.startInstallSession("grok", chat);
    const before = adapter.sendText.mock.calls.length;
    await (fm as any).shutdownLoginWindows();
    expect(adapter.sendText.mock.calls.length).toBe(before);
  });

  it("B3: stopAll shuts the web login controller down and cancels install windows before adapters go", async () => {
    const { fm, chat } = setup();
    const shutdown = vi.spyOn(LoginController.prototype, "shutdown").mockResolvedValue(undefined);
    (fm as any).webLogin;                                                        // controller exists
    await fm.startInstallSession("grok", chat);
    const cancelled: string[] = [];
    const inst = (fm as any).activeInstall;
    inst.session.cancel = async (why: string) => { cancelled.push(why); };
    await (fm as any).shutdownLoginWindows();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(cancelled).toEqual(["cancelled"]);                                 // the silent detail the install onDone handler respects
    expect((fm as any).loginWindow.isClosed).toBe(true);
  });
});
