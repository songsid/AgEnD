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
    async submitInput() { return true; }
    async selectMenuOption() { return true; }
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

describe("/install-cli", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `install-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    fakeSessions.length = 0;
    installedBinaries.clear();
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  function setup() {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: {}, instances: {} } as any;
    const notifyAlert = vi.fn().mockResolvedValue({ messageId: "prompt-1" });
    const sendText = vi.fn().mockResolvedValue({ messageId: "m1" });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "discord", type: "discord", notifyAlert, sendText, editMessageRemoveButtons } as any;
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);
    const chat = { adapter, adapterId: "discord", chatId: "chat", threadId: "topic" };
    return { fm, adapter, notifyAlert, sendText, chat };
  }

  it("runs the shared install command in a session and offers login on success", async () => {
    const { fm, notifyAlert, chat } = setup();
    const verify = vi.spyOn(fm as any, "verifyBinaryOnLoginShell").mockReturnValue(true);
    const started = await fm.startInstallSession("codex", chat);
    expect(started).toContain("codex");
    expect(fakeSessions).toHaveLength(1);
    expect(fakeSessions[0].flow.command).toBe("npm i -g @openai/codex");
    expect(fakeSessions[0].started).toBe(true);

    await fakeSessions[0].events.onDone({ ok: true, detail: "clean exit" });
    expect(verify).toHaveBeenCalledWith("codex");
    expect(notifyAlert).toHaveBeenCalledTimes(1);
    const ids = notifyAlert.mock.calls[0][1].choices.map((c: { id: string }) => c.id);
    expect(ids[0]).toMatch(/^install-login:[0-9a-f]{32}:go$/);
  });

  it("reports a PATH-verification failure instead of offering login", async () => {
    const { fm, notifyAlert, sendText, chat } = setup();
    vi.spyOn(fm as any, "verifyBinaryOnLoginShell").mockReturnValue(false);
    await fm.startInstallSession("grok", chat);
    await fakeSessions[0].events.onDone({ ok: true, detail: "clean exit" });
    expect(notifyAlert).not.toHaveBeenCalled();
    expect(String(sendText.mock.calls.at(-1)![1])).toContain("PATH");
  });

  it("opencode installs without a login offer (no login flow exists)", async () => {
    const { fm, notifyAlert, sendText, chat } = setup();
    vi.spyOn(fm as any, "verifyBinaryOnLoginShell").mockReturnValue(true);
    await fm.startInstallSession("opencode", chat);
    expect(fakeSessions[0].flow.command).toContain("opencode.ai/install");
    await fakeSessions[0].events.onDone({ ok: true, detail: "clean exit" });
    expect(notifyAlert).not.toHaveBeenCalled();
    expect(String(sendText.mock.calls.at(-1)![1])).toContain("opencode");
  });

  it("guards: already installed, unknown backend, busy slots", async () => {
    const { fm, chat } = setup();
    installedBinaries.add("claude");
    expect(await fm.startInstallSession("claude", chat)).toContain("already");
    expect(await fm.startInstallSession("notreal", chat)).toContain("notreal");

    (fm as any).activeLogin = { backend: "codex" };
    expect(await fm.startInstallSession("grok", chat)).toContain("codex");
    (fm as any).activeLogin = null;

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

  it("the sign-in button chains into the login flow", async () => {
    const { fm, notifyAlert, adapter, chat } = setup();
    vi.spyOn(fm as any, "verifyBinaryOnLoginShell").mockReturnValue(true);
    const login = vi.spyOn(fm, "startLoginSession").mockResolvedValue("login-started");
    await fm.startInstallSession("codex", chat);
    await fakeSessions[0].events.onDone({ ok: true, detail: "clean exit" });
    const goId = notifyAlert.mock.calls[0][1].choices[0].id as string;
    const click = { chatId: "chat", threadId: "topic", messageId: "prompt-1", userId: "admin", callbackData: goId } as any;
    expect(await (fm as any).handleInstallLoginConfirm(click, "discord", adapter)).toBe(true);
    expect(login).toHaveBeenCalledWith("codex", expect.objectContaining({ chatId: "chat" }));
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

  it("denies non-admin /login and /install-cli slashes", async () => {
    const { fm, adapter, respond } = setup();
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(false);
    await (fm as any).handleLoginSlash({ userId: "u", channelId: "c", respond }, "discord", adapter);
    await (fm as any).handleInstallCliSlash({ userId: "u", channelId: "c", respond }, "discord", adapter);
    expect(respond).toHaveBeenCalledTimes(2);
    for (const call of respond.mock.calls) expect(String(call[0])).toContain("Permission");
  });

  it("routes /login slash options to the right session methods", async () => {
    const { fm, adapter, respond } = setup();
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);
    const cancel = vi.spyOn(fm, "cancelLoginSession").mockResolvedValue("cancelled");
    const input = vi.spyOn(fm, "loginSubmitInput").mockResolvedValue("pasted");
    const start = vi.spyOn(fm, "startLoginSession").mockResolvedValue("started");
    const chooser = vi.spyOn(fm, "promptLoginBackends").mockResolvedValue(undefined);

    await (fm as any).handleLoginSlash({ userId: "a", channelId: "c", options: { cancel: true }, respond }, "discord", adapter);
    expect(cancel).toHaveBeenCalled();
    await (fm as any).handleLoginSlash({ userId: "a", channelId: "c", options: { code: "AB-12" }, respond }, "discord", adapter);
    expect(input).toHaveBeenCalledWith("AB-12");
    await (fm as any).handleLoginSlash({ userId: "a", channelId: "c", options: { backend: "codex" }, respond }, "discord", adapter);
    expect(start).toHaveBeenCalledWith("codex", expect.objectContaining({ chatId: "c" }));
    await (fm as any).handleLoginSlash({ userId: "a", channelId: "c", respond }, "discord", adapter);
    expect(chooser).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(4);
  });

  it("routes /install-cli slash options", async () => {
    const { fm, adapter, respond } = setup();
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);
    const start = vi.spyOn(fm, "startInstallSession").mockResolvedValue("installing");
    const cancel = vi.spyOn(fm, "cancelInstallSession").mockResolvedValue("cancelled");
    await (fm as any).handleInstallCliSlash({ userId: "a", channelId: "c", options: { backend: "grok" }, respond }, "discord", adapter);
    expect(start).toHaveBeenCalledWith("grok", expect.objectContaining({ chatId: "c" }));
    await (fm as any).handleInstallCliSlash({ userId: "a", channelId: "c", options: { cancel: true }, respond }, "discord", adapter);
    expect(cancel).toHaveBeenCalled();
    await (fm as any).handleInstallCliSlash({ userId: "a", channelId: "c", respond }, "discord", adapter);
    expect(String(respond.mock.calls.at(-1)![0])).toContain("/install-cli");
  });
});

describe("discord registration includes the new commands", () => {
  it("registers /login and /install-cli with backend choices", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(__dirname, "../src/channel/adapters/discord.ts"), "utf8");
    expect(src).toContain('name: "login", description: "🔒 " + t("slash.login")');
    expect(src).toContain('name: "install-cli", description: "🔒 " + t("slash.install_cli")');
    expect(src).toContain('{ name: "opencode", value: "opencode" }');
  });
});
