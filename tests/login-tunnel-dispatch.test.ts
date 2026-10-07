import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { FleetManager } from "../src/fleet-manager.js";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";

/**
 * The public-link consent travels as the button's own action and nothing else carries it:
 * go-tunnel / go-relogin-tunnel mean "yes, a public link", go / go-relogin mean "local only".
 * The controller re-checks the config and the flow when the click arrives; this pins the
 * routing between the button and the controller.
 */
type Alert = { choices: { id: string; label?: string }[] };

describe("login confirmation buttons → controller options", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `login-tunnel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    setAuthCheckRunnerForTests(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(allowPublic: boolean) {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: {}, instances: {}, web_terminal: { tunnel: { allow_public: allowPublic } } } as never;
    const notifyAlert = vi.fn(async (chatId: string, _alert: unknown, opts?: { threadId?: string }) => ({ messageId: "prompt-1", chatId, threadId: opts?.threadId }));
    const adapter = { id: "discord", type: "discord", notifyAlert, sendText: vi.fn().mockResolvedValue({ messageId: "m1" }), editMessageRemoveButtons: vi.fn().mockResolvedValue(undefined) } as never;
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);    // Sign-in paths under test: the CLIs count as installed whatever this host
    // has on PATH (CI has none — /login would install first, #1131).
    vi.spyOn(fm, "isCliInstalled").mockResolvedValue(true);
    const start = vi.spyOn((fm as unknown as { webLogin: { start: (...a: unknown[]) => Promise<string | null> } }).webLogin, "start").mockResolvedValue(null);
    const chat = { adapter, adapterId: "discord", chatId: "chat", threadId: "topic", userId: "admin" };
    return { fm, adapter, notifyAlert, start, chat };
  }

  const click = (callbackData: string) => ({ chatId: "chat", threadId: "topic", messageId: "prompt-1", userId: "admin", callbackData }) as never;
  const actionOf = (id: string) => id.split(":")[2];

  async function posted(allowPublic: boolean, tokenValid: boolean) {
    const s = setup(allowPublic);
    setAuthCheckRunnerForTests(async () => tokenValid ? { code: 0, output: '{"account":{}}' } : { code: 1, output: "Not logged in" });
    const real = (s.fm as unknown as { webLogin: { start: (...a: unknown[]) => Promise<string | null> } }).webLogin;
    s.start.mockRestore();
    await real.start("kiro-cli", s.chat);
    const alert = s.notifyAlert.mock.calls[0]![1] as Alert;
    const start = vi.spyOn(real, "start").mockResolvedValue(null);
    return { ...s, start, alert };
  }

  it("offers the three actions, in this order, only when the config allows it", async () => {
    expect((await posted(true, false)).alert.choices.map(c => actionOf(c.id))).toEqual(["go-tunnel", "go", "cancel"]);
    expect((await posted(false, false)).alert.choices.map(c => actionOf(c.id))).toEqual(["go", "cancel"]);
    expect((await posted(true, true)).alert.choices.map(c => actionOf(c.id))).toEqual(["go-relogin-tunnel", "go-relogin", "cancel"]);
  });

  it.each([
    [false, "go-tunnel", { skipAuthCheck: true, tokenPresent: false, tunnel: true }],
    [false, "go", { skipAuthCheck: true, tokenPresent: false, tunnel: false }],
    [true, "go-relogin-tunnel", { skipAuthCheck: true, tokenPresent: true, tunnel: true }],
    [true, "go-relogin", { skipAuthCheck: true, tokenPresent: true, tunnel: false }],
  ])("token held=%s, %s → %j", async (tokenValid, action, expected) => {
    const { fm, alert, start, adapter } = await posted(true, tokenValid);
    const id = alert.choices.find(c => actionOf(c.id) === action)!.id;
    expect(await (fm as unknown as { handleLoginConfirm: (...a: unknown[]) => Promise<boolean> }).handleLoginConfirm(click(id), "discord", adapter)).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toBe("kiro-cli");
    expect(start.mock.calls[0]![2]).toEqual(expected);
  });

  it("cancel starts nothing", async () => {
    const { fm, alert, start, adapter } = await posted(true, false);
    const id = alert.choices.find(c => actionOf(c.id) === "cancel")!.id;
    await (fm as unknown as { handleLoginConfirm: (...a: unknown[]) => Promise<boolean> }).handleLoginConfirm(click(id), "discord", adapter);
    expect(start).not.toHaveBeenCalled();
  });
});
