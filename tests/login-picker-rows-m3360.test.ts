import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";
import { buttonRows } from "../src/channel/adapters/discord.js";
import { setLocale, t } from "../src/locale.js";

const names = ["Antigravity", "Claude", "Codex", "Grok", "Kiro", "Muse", "OpenCode"];
const backends = ["antigravity", "claude-code", "codex", "grok", "kiro-cli", "muse", "opencode"];
type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
const roots: string[] = [], adapters: TelegramAdapter[] = [];
afterEach(() => {
  for (const a of adapters.splice(0)) { (a as any).httpAgent.destroy(); (a as any).httpsAgent.destroy(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  setLocale("en"); vi.restoreAllMocks();
});
async function picker(lang: "en" | "zh-TW") {
  setLocale(lang);
  const root = mkdtempSync(join(tmpdir(), "agend-login-picker-")); roots.push(root);
  const adapter = new TelegramAdapter({ id: "telegram", botToken: `123456:${"a".repeat(35)}`, accessManager: {} as never, inboxDir: root });
  adapters.push(adapter);
  const send = vi.spyOn(adapter.getBot().api, "sendMessage").mockResolvedValue({ message_id: 7 } as never);
  const fm = new FleetManager(root) as any;
  fm.fleetConfig = { name: "Example Fleet", defaults: {}, channel: { group_id: "-100123" }, instances: {} };
  vi.spyOn(fm, "configuredBackendInstanceNames").mockReturnValue([]);
  vi.spyOn(fm, "probeInstalledBackends").mockResolvedValue(new Set());
  await fm.promptLoginBackends({ adapter, adapterId: "telegram", chatId: "-100123", threadId: "42" });
  expect(send).toHaveBeenCalledOnce();
  const [chatId, text, opts] = send.mock.calls[0]!;
  return { adapter, send, chatId, text, rows: (opts!.reply_markup as Keyboard).inline_keyboard };
}
it.each(["en", "zh-TW"] as const)("wraps the real Telegram login payload two per row without changing callback data (%s)", async lang => {
  const { rows, chatId } = await picker(lang);
  expect(rows.map(row => row.length)).toEqual([2, 2, 2, 1]);
  expect(chatId).toBe(-100123);
  const ids = rows.flat().map(button => button.callback_data);
  expect(ids.map(id => id.split(":").at(-1))).toEqual(backends);
  const nonce = ids[0]!.split(":")[1];
  expect(nonce).toMatch(/^[a-f0-9]{32}$/);
  expect(ids).toEqual(backends.map(backend => `login:${nonce}:${backend}`));
  expect(ids.every(id => Buffer.byteLength(id) <= 64)).toBe(true);
});
it.each(["en", "zh-TW"] as const)("uses readable names on buttons and retains status details in the reply (%s)", async lang => {
  const { rows, text } = await picker(lang);
  expect(rows.flat().map(button => button.text)).toEqual(names);
  for (const name of names) expect(text).toContain(`${name} · ${t("login.status_not_installed")}`);
  expect(text).toContain(t("login.status_install_then_auth"));
  expect(text).toContain(`OpenCode · ${t("login.status_not_installed")} · ${t("login.status_install")}`);
});
it.each(["en", "zh-TW"] as const)("keeps Discord at five per row with the same full labels and callback values (%s)", async lang => {
  const { rows } = await picker(lang), choices = rows.flat().map(button => ({ id: button.callback_data, label: button.text }));
  const discord = buttonRows(choices).map(row => row.toJSON());
  expect(discord.map(row => row.components.length)).toEqual([5, 2]);
  expect(discord.flatMap(row => row.components).map(value => {
    const button = value as { custom_id: string; label: string };
    return { id: button.custom_id, label: button.label };
  })).toEqual(choices);
});
it("leaves other alert keyboards unchanged", async () => {
  const { adapter, send } = await picker("en"); send.mockClear();
  const choices = ["one", "two", "three"].map(id => ({ id, label: id }));
  await adapter.notifyAlert("-100123", { type: "clear_confirm", instanceName: "general", message: "Example confirmation", choices });
  const keyboard = (send.mock.calls[0]![2]!.reply_markup as Keyboard).inline_keyboard;
  expect(keyboard).toEqual([choices.map(choice => ({ text: choice.label, callback_data: choice.id }))]);
});
