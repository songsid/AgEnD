import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Legacy relay sessions must never touch a real tmux server in unit tests.
const relaySessions: Array<{ flow: any }> = [];
vi.mock("../src/login-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/login-manager.js")>();
  class FakeLoginSession {
    state = "starting";
    constructor(readonly flow: any, _tmux: any, readonly events: any) { relaySessions.push({ flow }); }
    async start() {}
    async cancel() { await this.events.onDone({ ok: false, detail: "cancelled" }); }
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
    expect(await fm.startInstallSession("grok", chat)).toBe(t("login.busy", "codex"));
    expect(await fm.loginSubmitInput("XYZ")).toBe(t("login.web_code_not_needed"));
    expect(await fm.cancelLoginSession()).toBe("web-cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("in relay mode an active web login still blocks the legacy launcher (one window fleet-wide)", async () => {
    const { fm, chat } = setup("relay");
    vi.spyOn(LoginController.prototype, "isActive").mockReturnValue(true);
    vi.spyOn(LoginController.prototype, "activeBackend", "get").mockReturnValue("kiro-cli");
    // Force the controller to exist (it is created lazily on first web-mode use).
    (fm as any).webLogin;
    expect(await fm.startLoginSession("codex", chat)).toBe(t("login.busy", "kiro-cli"));
    expect(relaySessions).toHaveLength(0);
  });
});
