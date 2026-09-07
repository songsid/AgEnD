import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Legacy relay sessions must never touch a real tmux server in unit tests.
const relaySessions: Array<{ flow: any; cancelled: string[] }> = [];
let onRelayStart: (() => Promise<void>) | null = null;
vi.mock("../src/login-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/login-manager.js")>();
  class FakeLoginSession {
    state = "starting";
    record: { flow: any; cancelled: string[] };
    constructor(readonly flow: any, _tmux: any, readonly events: any) { this.record = { flow, cancelled: [] }; relaySessions.push(this.record); }
    async start() { if (onRelayStart) await onRelayStart(); }
    async cancel(detail = "cancelled") { this.state = "done"; this.record.cancelled.push(detail); await this.events.onDone({ ok: false, detail }); }
    async submitInput() { return true; }
    async selectMenuOption() { return true; }
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
 * FleetManager side of PR-B: `login.mode` dispatch, and the fleet-wide
 * single-window rule across web login, relay login and install.
 */
describe("/login mode dispatch and exclusivity", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `login-web-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    relaySessions.length = 0;
    onRelayStart = null;
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "logged out" }));   // pre-check: invalid → straight to login
  });
  afterEach(() => {
    setAuthCheckRunnerForTests(null);
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(mode?: "web" | "relay") {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: {}, instances: {}, login: mode ? { mode } : undefined } as any;
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);
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

  it("default (no login section) is web mode: the controller starts, no relay session is created", async () => {
    const { fm, chat } = setup();
    const start = vi.spyOn(LoginController.prototype, "start").mockResolvedValue("web-started");
    expect(await fm.startLoginSession("codex", chat)).toBe("web-started");
    expect(start).toHaveBeenCalledWith("codex", expect.objectContaining({ userId: "admin" }), expect.anything());
    expect(relaySessions).toHaveLength(0);
  });

  it("login.mode: relay keeps the legacy path: a relay LoginSession is created and the controller is never asked", async () => {
    const { fm, chat } = setup("relay");
    const start = vi.spyOn(LoginController.prototype, "start");
    const text = await fm.startLoginSession("codex", chat);
    expect(text).toBe(t("login.started", "codex"));
    expect(relaySessions).toHaveLength(1);
    expect(relaySessions[0].flow.backend).toBe("codex");
    expect(start).not.toHaveBeenCalled();
  });

  it("while a web login is active: install is refused, /login code is redirected, /login cancel reaches the controller", async () => {
    const { fm, chat } = setup("web");
    vi.spyOn(LoginController.prototype, "start").mockResolvedValue("web-started");
    vi.spyOn(LoginController.prototype, "isActive").mockReturnValue(true);
    vi.spyOn(LoginController.prototype, "activeBackend", "get").mockReturnValue("codex");
    const cancel = vi.spyOn(LoginController.prototype, "cancel").mockResolvedValue("web-cancelled");
    await fm.startLoginSession("codex", chat);
    (fm as any).loginWindow.tryClaim("web", "codex");                             // what the real start() does before its first await
    expect(await fm.startInstallSession("grok", chat)).toBe(t("login.busy", "codex"));
    expect(await fm.loginSubmitInput("XYZ")).toBe(t("login.web_code_not_needed"));
    expect(await fm.cancelLoginSession()).toBe("web-cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("in relay mode a held window (web login) blocks the legacy launcher (one window fleet-wide)", async () => {
    const { fm, chat } = setup("relay");
    const claim = (fm as any).loginWindow.tryClaim("web", "kiro-cli");
    expect(claim).not.toBeNull();
    expect(await fm.startLoginSession("codex", chat)).toBe(t("login.busy", "kiro-cli"));
    expect(relaySessions).toHaveLength(0);
    (fm as any).loginWindow.release(claim);
    expect(await fm.startLoginSession("codex", chat)).toBe(t("login.started", "codex"));
  });

  it("B1: relay login racing install — both check-then-await — exactly one wins the window", async () => {
    const { fm, chat } = setup("relay");
    let releaseAuth!: (v: { code: number; output: string }) => void;
    setAuthCheckRunnerForTests(() => new Promise(r => { releaseAuth = r; }));   // relay pre-check parks here
    const relay = fm.startLoginSession("codex", chat);
    const install = fm.startInstallSession("grok", chat);                        // arrives while relay awaits its pre-check
    releaseAuth({ code: 1, output: "logged out" });
    const [relayText, installText] = await Promise.all([relay, install]);
    expect(relayText).toBe(t("login.started", "codex"));
    expect(installText).toBe(t("login.busy", "codex"));
    expect(relaySessions).toHaveLength(1);
  });

  it("B1: the relay pre-check that ends in a confirmation prompt releases the window", async () => {
    const { fm, chat } = setup("relay");
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: "logged in" }));   // valid → buttons, no session
    expect(await fm.startLoginSession("codex", chat)).toBeNull();
    expect((fm as any).loginWindow.isHeld).toBe(false);
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "logged out" }));
    expect(await fm.startInstallSession("grok", chat)).toBe(t("install.started", "grok"));
  });

  it("B1 (round 2): a rejected ensureSession releases the relay and install claims — the next start can claim", async () => {
    const { fm, chat } = setup("relay");
    const ensure = vi.spyOn(TmuxManager, "ensureSession").mockRejectedValueOnce(new Error("tmux server unavailable"));
    expect(await fm.startLoginSession("codex", chat)).toBe(t("login.failed", "codex", "tmux server unavailable"));
    expect((fm as any).loginWindow.isHeld).toBe(false);
    ensure.mockRejectedValueOnce(new Error("tmux server unavailable"));
    expect(await fm.startInstallSession("grok", chat)).toBe(t("install.failed", "grok", "tmux server unavailable"));
    expect((fm as any).loginWindow.isHeld).toBe(false);
    ensure.mockResolvedValue(undefined);
    expect(await fm.startInstallSession("grok", chat)).toBe(t("install.started", "grok"));
  });

  it("B2 (round 2): a relay start parked in its pre-check does not launch after shutdown", async () => {
    const { fm, chat, adapter } = setup("relay");
    let releaseAuth!: (v: { code: number; output: string }) => void;
    setAuthCheckRunnerForTests(() => new Promise(r => { releaseAuth = r; }));
    const ensure = vi.spyOn(TmuxManager, "ensureSession").mockResolvedValue(undefined);
    const pending = fm.startLoginSession("codex", chat);                    // claim held, awaiting the probe
    await (fm as any).shutdownLoginWindows();                                // fleet stops meanwhile
    releaseAuth({ code: 1, output: "logged out" });
    expect(await pending).toBe(t("login.web_shutting_down"));
    expect(ensure).not.toHaveBeenCalled();
    expect(relaySessions).toHaveLength(0);
    expect((fm as any).loginWindow.isHeld).toBe(false);
    expect(adapter.notifyAlert).not.toHaveBeenCalled();                      // no confirmation buttons either
    // closed lock refuses new windows until reopened by start()
    expect(await fm.startInstallSession("grok", chat)).toBe(t("login.web_shutting_down"));
    (fm as any).loginWindow.reopen();
    expect(await fm.startInstallSession("grok", chat)).toBe(t("install.started", "grok"));
  });

  it("B1 (round 3): shutdown landing during a relay session.start cancels it and frees the window", async () => {
    const { fm, chat } = setup("relay");
    vi.spyOn(TmuxManager, "ensureSession").mockResolvedValue(undefined);
    onRelayStart = async () => { await (fm as any).shutdownLoginWindows(); };
    expect(await fm.startLoginSession("codex", chat)).toBe(t("login.web_shutting_down"));
    expect(relaySessions[0].cancelled).toEqual(["cancelled"]);
    expect((fm as any).activeLogin).toBeNull();
    expect((fm as any).loginWindow.isHeld).toBe(false);
  });

  it("N1: legacy windows cancelled by shutdown stay quiet — no 'failed — fleet shutdown' message", async () => {
    const { fm, chat, adapter } = setup("relay");
    await fm.startInstallSession("grok", chat);
    const before = adapter.sendText.mock.calls.length;
    await (fm as any).shutdownLoginWindows();
    expect(adapter.sendText.mock.calls.length).toBe(before);
  });

  it("B3: stopAll shuts the web login controller down and cancels relay/install windows before adapters go", async () => {
    const { fm, chat } = setup("relay");
    const shutdown = vi.spyOn(LoginController.prototype, "shutdown").mockResolvedValue(undefined);
    (fm as any).webLogin;                                                        // controller exists
    await fm.startInstallSession("grok", chat);
    const cancelled: string[] = [];
    const inst = (fm as any).activeInstall;
    inst.session.cancel = async (why: string) => { cancelled.push(why); };
    await (fm as any).shutdownLoginWindows();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(cancelled).toEqual(["cancelled"]);                                 // the silent detail both legacy onDone handlers respect
    expect((fm as any).loginWindow.isClosed).toBe(true);
  });
});
