import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { BACKEND_INSTALLATION_INFO } from "../src/instance-lifecycle.js";
import { LOGIN_FLOWS } from "../src/login-flows.js";

/**
 * A bare `/install-cli` printed a usage line the admin then had to retype,
 * while bare `/login` already opened a chooser. This makes them match.
 *
 * Built on postNonceButtonPrompt — the mechanism `/login` uses — rather than
 * the `/model` selection coordinator, so it inherits #682's canonical-address
 * binding and answers correctly in a Telegram General topic.
 */
const dirs: string[] = [];
function makeFleet(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-installmenu-"));
  dirs.push(dir);
  const notifyAlert = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "g1", threadId: "t1" });
  const sendText = vi.fn().mockResolvedValue(undefined);
  const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
  const adapter = { id: "telegram", type: "telegram", notifyAlert, sendText, editMessageRemoveButtons } as any;
  const fm = new FleetManager(dir) as any;
  fm.fleetConfig = { defaults: {}, channel: { group_id: "g1" }, instances: {} };
  fm.adapters.set(adapter.id, adapter);
  fm.adapter = adapter;
  fm.isFleetAdmin = vi.fn(() => true);
  fm.startInstallSession = vi.fn(async (b: string) => `installing:${b}`);
  Object.assign(fm, over);
  return { fm, adapter, notifyAlert, sendText, editMessageRemoveButtons, dir };
}
const chat = (a: any, threadId?: string) => ({ adapter: a, adapterId: "telegram", chatId: "g1", threadId });

describe("bare /install-cli offers a backend chooser", () => {
  it("lists the installable backends and omits deprecated gemini-cli", async () => {
    const { fm, adapter, notifyAlert } = makeFleet();
    await fm.promptInstallBackends(chat(adapter, "t1"));

    const alert = notifyAlert.mock.calls[0][1];
    const offered = alert.choices.map((c: any) => c.id.split(":").pop());
    expect(offered).toEqual(
      Object.keys(BACKEND_INSTALLATION_INFO).filter(b => b !== "gemini-cli"),
    );
    expect(offered).toContain("opencode");   // install-only backend, still offered
    expect(offered).not.toContain("gemini-cli");
    expect(offered).toHaveLength(6);
  });

  it("keeps every callback id inside Telegram's 64-byte callback_data cap", async () => {
    // Only 5 bytes of headroom today: "install-select:" (15) + 32 hex + ":"
    // leaves 16 for the backend name, and the longest is 11. A name of 17+
    // characters would push past 64 and Telegram would reject the button
    // silently — no error, just a menu that does nothing.
    const { fm, adapter, notifyAlert } = makeFleet();
    await fm.promptInstallBackends(chat(adapter, "t1"));
    for (const c of notifyAlert.mock.calls[0][1].choices) {
      expect(Buffer.byteLength(c.id, "utf8"), `callback_data too long: ${c.id}`).toBeLessThanOrEqual(64);
    }
  });

  it("does NOT filter to backends the fleet already runs", async () => {
    // Installing is how you get a backend you do not have; filtering by
    // configured backends would hide the only entry the admin came for.
    const { fm, adapter, notifyAlert } = makeFleet();
    fm.fleetConfig.instances = { only: { backend: "claude-code" } };
    await fm.promptInstallBackends(chat(adapter, "t1"));
    expect(notifyAlert.mock.calls[0][1].choices).toHaveLength(6);
  });

  it("login keeps its own 5-backend list, with no opencode", () => {
    // The two menus are deliberately different sets.
    const loginBackends = Object.keys(LOGIN_FLOWS);
    expect(loginBackends).toHaveLength(5);
    expect(loginBackends).not.toContain("opencode");
    expect(Object.keys(BACKEND_INSTALLATION_INFO)).toContain("opencode");
  });

  it("a chosen button starts that backend's install", async () => {
    const { fm, adapter, notifyAlert } = makeFleet();
    await fm.promptInstallBackends(chat(adapter, "t1"));
    const pick = notifyAlert.mock.calls[0][1].choices.find((c: any) => c.id.endsWith(":codex"));

    const handled = await fm.handleInstallBackendSelect(
      { callbackData: pick.id, chatId: "g1", threadId: "t1", messageId: "m1", userId: "admin" },
      "telegram", adapter,
    );

    expect(handled).toBe(true);
    expect(fm.startInstallSession).toHaveBeenCalledWith("codex", expect.objectContaining({ chatId: "g1" }));
  });

  it("answers in a Telegram General topic (#682 canonical binding)", async () => {
    // Telegram represents General as topic "1" on input but omits
    // message_thread_id on the wire and in callback queries. The nonce is bound
    // to what the provider actually returned, so the callback still matches.
    const { fm, adapter, notifyAlert } = makeFleet();
    notifyAlert.mockResolvedValue({ messageId: "m1", chatId: "g1", threadId: undefined });

    await fm.promptInstallBackends(chat(adapter, "1"));   // logical General
    const pick = notifyAlert.mock.calls[0][1].choices.find((c: any) => c.id.endsWith(":codex"));

    const handled = await fm.handleInstallBackendSelect(
      { callbackData: pick.id, chatId: "g1", threadId: undefined, messageId: "m1", userId: "admin" },
      "telegram", adapter,
    );

    expect(handled).toBe(true);
    expect(fm.startInstallSession).toHaveBeenCalledWith("codex", expect.anything());
  });

  it("rejects a callback from a different chat", async () => {
    const { fm, adapter, notifyAlert } = makeFleet();
    await fm.promptInstallBackends(chat(adapter, "t1"));
    const pick = notifyAlert.mock.calls[0][1].choices.find((c: any) => c.id.endsWith(":codex"));

    await fm.handleInstallBackendSelect(
      { callbackData: pick.id, chatId: "SOMEWHERE-ELSE", threadId: "t1", messageId: "m1", userId: "admin" },
      "telegram", adapter,
    );
    expect(fm.startInstallSession).not.toHaveBeenCalled();
  });
});

describe("/install-cli text command routing", () => {
  function makeCommands(over: Record<string, unknown> = {}) {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "telegram", type: "telegram", sendText } as any;
    const ctx = {
      adapter,
      adapters: new Map([["telegram", adapter]]),
      fleetConfig: { defaults: {}, instances: {} },
      isFleetAdmin: vi.fn(() => true),
      promptInstallBackends: vi.fn(async () => {}),
      startInstallSession: vi.fn(async (b: string) => `installing:${b}`),
      cancelInstallSession: vi.fn(async () => "cancelled"),
      ...over,
    } as any;
    return { commands: new TopicCommands(ctx) as any, ctx, sendText };
  }
  const msg = (text: string) => ({
    text, chatId: "chat", threadId: "topic", userId: "u1", adapterId: "telegram", username: "admin",
  }) as any;

  it("bare /install-cli opens the chooser instead of printing usage", async () => {
    const { commands, ctx, sendText } = makeCommands();
    await commands.handleInstallCliCommand(msg("/install-cli"));
    expect(ctx.promptInstallBackends).toHaveBeenCalledTimes(1);
    expect(ctx.startInstallSession).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("an explicit backend still runs directly, with no chooser", async () => {
    const { commands, ctx } = makeCommands();
    await commands.handleInstallCliCommand(msg("/install-cli codex"));
    expect(ctx.startInstallSession).toHaveBeenCalledWith("codex", expect.anything());
    expect(ctx.promptInstallBackends).not.toHaveBeenCalled();
  });

  it("gemini-cli still installs when typed in full, though the menu hides it", async () => {
    const { commands, ctx } = makeCommands();
    await commands.handleInstallCliCommand(msg("/install-cli gemini-cli"));
    expect(ctx.startInstallSession).toHaveBeenCalledWith("gemini-cli", expect.anything());
  });

  it("denies a non-admin without posting a chooser", async () => {
    const { commands, ctx, sendText } = makeCommands({ isFleetAdmin: vi.fn(() => false) });
    await commands.handleInstallCliCommand(msg("/install-cli"));
    expect(ctx.promptInstallBackends).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0][1]).toContain("Permission denied");
  });

  it("a multi-word argument is still a usage error, not a chooser", async () => {
    const { commands, ctx, sendText } = makeCommands();
    await commands.handleInstallCliCommand(msg("/install-cli two words"));
    expect(ctx.promptInstallBackends).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0][1]).toMatch(/Usage|用法/);
  });
});
