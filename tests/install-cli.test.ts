import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// The install session must never touch a real tmux server in unit tests.
const fakeSessions: Array<{ flow: any; events: any; started: boolean; cancelled: boolean }> = [];
vi.mock("../src/login-manager.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/login-manager.js")>();
  class FakeLoginSession {
    state = "starting";
    flow: any; events: any;
    constructor(flow: any, _tmux: any, events: any) {
      this.flow = flow; this.events = events;
      fakeSessions.push({ flow, events, started: false, cancelled: false });
    }
    async start() { fakeSessions[fakeSessions.length - 1].started = true; }
    async cancel() {
      fakeSessions[fakeSessions.length - 1].cancelled = true;
      await this.events.onDone({ ok: false, detail: "cancelled" });
    }
  }
  return { ...real, LoginSession: FakeLoginSession };
});
// The already-installed guard must not depend on what this machine has on PATH.
const installedBinaries = new Set<string>();
vi.mock("../src/instance-lifecycle.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/instance-lifecycle.js")>();
  return { ...real, checkBinaryInstalled: (binary: string) => installedBinaries.has(binary) };
});

import { FleetManager } from "../src/fleet-manager.js";
import { setLocale, t } from "../src/locale.js";

/** The part of a captured notifyAlert payload these tests read. */
type Alert = { choices: { id: string }[] };
const alertAt = (notifyAlert: { mock: { calls: unknown[][] } }, i = 0): Alert =>
  notifyAlert.mock.calls[i][1] as Alert;

describe("the install /login runs for a missing CLI (#1131: one entry point)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `install-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    fakeSessions.length = 0;
    installedBinaries.clear();
  });
  afterEach(() => {
    setLocale("en");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: {}, instances: {} } as any;
    const notifyAlert = vi.fn(async (chatId: string, _alert: unknown, opts?: { threadId?: string }) => ({
      messageId: "prompt-1", chatId, threadId: opts?.threadId,
    }));
    const sendText = vi.fn().mockResolvedValue({ messageId: "m1" });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "discord", type: "discord", notifyAlert, sendText, editMessageRemoveButtons } as any;
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);
    const chat = { adapter, adapterId: "discord", chatId: "chat", threadId: "topic", userId: "admin" };
    return { fm, adapter, notifyAlert, sendText, chat };
  }

  it("/login of a CLI that is missing installs it, then signs in", async () => {
    const { fm, sendText, chat } = setup();
    const verify = vi.spyOn(fm as any, "locateBinaryOnLoginShell").mockReturnValue("/usr/local/bin/codex");
    const started = await fm.startLoginSession("codex", chat);
    expect(started).toBe(t("install.started", "codex"));
    expect(fakeSessions).toHaveLength(1);
    expect(fakeSessions[0].flow.command).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | sh");
    expect(fakeSessions[0].started).toBe(true);

    // The installed CLI is on PATH now: the sign-in that follows is a login.
    installedBinaries.add("codex");
    const signIn = vi.spyOn(fm as any, "launchSignIn").mockResolvedValue("login-started");
    await fakeSessions[0].events.onDone({ ok: true, detail: "clean exit" });
    expect(verify).toHaveBeenCalledWith("codex");
    expect(sendText.mock.calls.map(call => call[1])).toEqual([t("install.success", "codex", "codex"), "login-started"]);
    expect(signIn).toHaveBeenCalledWith("codex", expect.objectContaining({ chatId: "chat", threadId: "topic", userId: "admin" }), {});
  });

  it("an install whose binary is still not visible signs in once, never installs again", async () => {
    const { fm, chat } = setup();
    vi.spyOn(fm as any, "locateBinaryOnLoginShell").mockReturnValue("/usr/local/bin/codex");
    vi.spyOn(fm as any, "adoptBinaryDirectory").mockImplementation(() => {});
    await fm.startLoginSession("codex", chat);
    // installedBinaries stays empty: the fleet still cannot see codex.
    const signIn = vi.spyOn(fm as any, "launchSignIn").mockResolvedValue("login-started");
    const install = vi.spyOn(fm, "startInstallSession");
    await fakeSessions[0].events.onDone({ ok: true, detail: "clean exit" });
    expect(signIn).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(fakeSessions).toHaveLength(1);
  });

  it("a confirmed sign-in (the go button) never installs, even if the binary is missing (#1136 review)", async () => {
    const { fm, adapter, chat } = setup();
    const signIn = vi.spyOn(fm as any, "launchSignIn").mockResolvedValue("signing in");
    const install = vi.spyOn(fm, "startInstallSession");
    // A real nonce-armed confirmation, as the login controller posts it; codex is not on PATH.
    await (fm as any).postNonceButtonPrompt({
      prefix: "login-confirm:", alertType: "login", instanceName: "codex", adapter, adapterId: "discord",
      chatId: "chat", threadId: "topic", message: "Sign in?", choices: [{ action: "go", label: "Go" }], expiredText: "expired",
    });
    const nonce = [...(fm as any).pendingNonceButtons.keys()][0];
    await (fm as any).handleLoginConfirm({ callbackData: `login-confirm:${nonce}:go`, chatId: "chat", threadId: "topic", messageId: "prompt-1", userId: "admin" }, "discord", adapter);
    expect(install).not.toHaveBeenCalled();
    expect(fakeSessions).toHaveLength(0);
    expect(signIn).toHaveBeenCalledWith("codex", expect.objectContaining({ chatId: "chat" }), expect.objectContaining({ skipAuthCheck: true }));
  });

  it("/login cancel between a finished install and its sign-in stops the sign-in (#1136 review)", async () => {
    const { fm, sendText, chat } = setup();
    vi.spyOn(fm as any, "locateBinaryOnLoginShell").mockReturnValue("/usr/local/bin/codex");
    const signIn = vi.spyOn(fm as any, "launchSignIn").mockResolvedValue("signing in");
    await fm.startInstallSession("codex", chat);
    let release!: () => void;
    sendText.mockImplementationOnce(() => new Promise(r => { release = () => r({ messageId: "s" }); }));
    const done = fakeSessions[0].events.onDone({ ok: true, detail: "clean exit" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(await fm.cancelLoginSession()).toBe(t("login.cancelled", "codex"));
    release();
    await done;
    expect(signIn).not.toHaveBeenCalled();
    // Nothing left to cancel afterwards.
    expect(await fm.cancelLoginSession()).toBe(t("login.no_session"));
  });

  it("/login of an installed CLI signs in without installing", async () => {
    const { fm, chat } = setup();
    installedBinaries.add("codex");
    const signIn = vi.spyOn(fm as any, "launchSignIn").mockResolvedValue("login-started");
    expect(await fm.startLoginSession("codex", chat)).toBe("login-started");
    expect(fakeSessions).toHaveLength(0);
    expect(signIn).toHaveBeenCalledOnce();
  });

  it("a sign-in that cannot start after the install is reported after the success line", async () => {
    const { fm, sendText, chat } = setup();
    vi.spyOn(fm as any, "locateBinaryOnLoginShell").mockReturnValue("/usr/local/bin/codex");
    await fm.startInstallSession("codex", chat);
    installedBinaries.add("codex");
    vi.spyOn(fm as any, "launchSignIn").mockRejectedValue(new Error("tmux gone"));
    await fakeSessions[0].events.onDone({ ok: true, detail: "clean exit" });
    expect(sendText.mock.calls.map(call => call[1])).toEqual([
      t("install.success", "codex", "codex"),
      t("login.failed", "codex", "tmux gone"),
    ]);
  });

  it("reports a PATH-verification failure instead of offering login", async () => {
    const { fm, notifyAlert, sendText, chat } = setup();
    vi.spyOn(fm as any, "locateBinaryOnLoginShell").mockReturnValue(null);
    // Found nowhere: not by a login shell, and not in grok's own installer
    // directory either (#1092) — this host may have a real ~/.grok/bin/grok.
    vi.spyOn(fm as any, "locateInInstallerBinDirs").mockReturnValue(null);
    const signIn = vi.spyOn(fm as any, "launchSignIn");
    await fm.startInstallSession("grok", chat);
    await fakeSessions[0].events.onDone({ ok: true, detail: "clean exit" });
    expect(notifyAlert).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(String(sendText.mock.calls.at(-1)![1])).toContain("PATH");
  });

  it("opencode installs without a login offer (no login flow exists)", async () => {
    const { fm, notifyAlert, sendText, chat } = setup();
    vi.spyOn(fm as any, "locateBinaryOnLoginShell").mockReturnValue("/usr/local/bin/opencode");
    const signIn = vi.spyOn(fm as any, "launchSignIn");
    await fm.startLoginSession("opencode", chat);
    expect(fakeSessions[0].flow.command).toContain("opencode.ai/install");
    await fakeSessions[0].events.onDone({ ok: true, detail: "clean exit" });
    expect(notifyAlert).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(String(sendText.mock.calls.at(-1)![1])).toContain("opencode");
  });

  it("guards: already installed, unknown backend, busy slots", async () => {
    const { fm, chat } = setup();
    installedBinaries.add("claude");
    expect(await fm.startInstallSession("claude", chat)).toContain("already");
    expect(await fm.startInstallSession("notreal", chat)).toContain("notreal");

    // A web login holds the fleet-wide window; install must yield.
    const loginClaim = (fm as any).loginWindow.tryClaim("web", "codex");
    expect(await fm.startInstallSession("grok", chat)).toContain("codex");
    (fm as any).loginWindow.release(loginClaim);

    await fm.startInstallSession("grok", chat);
    expect(await fm.startInstallSession("codex", chat)).toBe((await import("../src/locale.js")).t("install.busy"));
    // And the reverse: an install blocks /login.
    expect(await fm.startLoginSession("codex", chat)).toContain("install");
  });

  it("cancel ends the session with a single message", async () => {
    const { fm, sendText, chat } = setup();
    await fm.startInstallSession("grok", chat);
    const reply = await fm.cancelInstallSession();
    expect(reply).toContain("grok");
    expect(fakeSessions[0].cancelled).toBe(true);
    // onDone(cancelled) must not send a duplicate.
    expect(sendText).not.toHaveBeenCalled();
    expect(await fm.cancelInstallSession()).not.toContain("grok");
  });

  it("/login cancel stops an install /login started", async () => {
    const { fm, chat } = setup();
    await fm.startLoginSession("grok", chat);
    expect(await fm.cancelLoginSession()).toBe(t("install.cancelled", "grok"));
    expect(fakeSessions[0].cancelled).toBe(true);
  });
});

describe("slash helpers", () => {
  function setup() {
    const fm = new FleetManager(join(tmpdir(), `slash-${Date.now()}`));
    fm.fleetConfig = { defaults: {}, instances: {} } as any;
    const adapter = { id: "discord", type: "discord", sendText: vi.fn().mockResolvedValue({ messageId: "m" }) } as any;
    const respond = vi.fn().mockResolvedValue(undefined);
    return { fm, adapter, respond };
  }

  it("denies a non-admin /login slash", async () => {
    const { fm, adapter, respond } = setup();
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(false);
    await (fm as any).handleLoginSlash({ userId: "u", channelId: "c", respond }, "discord", adapter);
    expect(respond).toHaveBeenCalledOnce();
    expect(String(respond.mock.calls[0]![0])).toContain("Permission");
  });

  it("routes /login slash options to the right session methods", async () => {
    const { fm, adapter, respond } = setup();
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);
    const cancel = vi.spyOn(fm, "cancelLoginSession").mockResolvedValue("cancelled");
    const start = vi.spyOn(fm, "startLoginSession").mockResolvedValue("started");
    const chooser = vi.spyOn(fm, "promptLoginBackends").mockResolvedValue(undefined);

    await (fm as any).handleLoginSlash({ userId: "a", channelId: "c", options: { cancel: true }, respond }, "discord", adapter);
    expect(cancel).toHaveBeenCalled();
    // `code` and `reinstall` are no longer options (#1137): ignored if a stale client sends them.
    await (fm as any).handleLoginSlash({ userId: "a", channelId: "c", options: { code: "AB-12" }, respond }, "discord", adapter);
    expect(start).not.toHaveBeenCalled();
    expect(chooser).toHaveBeenCalledTimes(1);                  // …it is just the bare /login
    await (fm as any).handleLoginSlash({ userId: "a", channelId: "c", options: { backend: "codex" }, respond }, "discord", adapter);
    expect(start).toHaveBeenCalledWith("codex", expect.objectContaining({ chatId: "c" }));
    await (fm as any).handleLoginSlash({ userId: "a", channelId: "c", respond }, "discord", adapter);
    expect(chooser).toHaveBeenCalled();
    await (fm as any).handleLoginSlash({ userId: "a", channelId: "c", options: { backend: "grok", reinstall: true }, respond }, "discord", adapter);
    expect(start).toHaveBeenLastCalledWith("grok", expect.objectContaining({ chatId: "c" }));
    expect(respond).toHaveBeenCalledTimes(5);
  });

});

describe("discord registration includes the new commands", () => {
  it("registers one /login (with opencode among its backends) and no /install-cli", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(__dirname, "../src/channel/adapters/discord.ts"), "utf8");
    // The lock emoji is generated from the command table (src/command-table.ts), not typed here.
    expect(src).toContain('name: "login", description: withFleetLabel(slashLock("login") + t("slash.login"), this.fleetLabel)');
    expect(src).not.toContain('name: "install-cli"');
    // Only backend and cancel (#1137).
    expect(src).not.toContain('slash.option.login_reinstall');
    expect(src).not.toContain('slash.option.login_code');
    expect(src).toContain('{ name: "opencode", value: "opencode" }');
  });

  it("sources the Beta marker from the shared locale descriptions", () => {
    try {
      setLocale("en");
      expect(t("slash.login")).toBe("Sign in or install a CLI backend remotely (beta)");
      setLocale("zh-TW");
      expect(t("slash.login")).toBe("遠端登入或安裝 CLI Backend（Beta）");
    } finally {
      setLocale("en");
    }
  });
});
