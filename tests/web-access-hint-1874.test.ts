/**
 * #1874: `web.access` is not a setting — fleet admins (who may run /web, /update, /doctor) are the channel's
 * `access.allowed_users`. The validator warns on any unknown key under `web` (that one by name), and the "disabled"
 * replies name the real key, in the form the operator wrote: `channel:` or a `channels:` entry.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateFleetConfig } from "../src/config-validator.js";
import { setLocale, t } from "../src/locale.js";
import { TopicCommands } from "../src/topic-commands.js";
import { FleetManager as FM } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => { setLocale("en"); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const base = { channel: { type: "discord", bot_token_env: "T", group_id: "G", access: { mode: "locked", allowed_users: [] } }, instances: {} };

describe("the validator warns on unknown keys under web (#1874)", () => {
  it("web.access: a warning that names where fleet admins really go — not an error", () => {
    const r = validateFleetConfig({ ...base, web: { access: { mode: "locked", allowed_users: ["1"] } } });
    expect(r.valid).toBe(true);
    expect(r.warnings.filter(w => w.path.startsWith("web"))).toEqual([
      { path: "web.access", message: "web.access is not a setting; fleet admins come from channel(s).access.allowed_users — ignored" }]);
  });
  it("any other unknown key: a warning listing the known ones; known keys: none", () => {
    const r = validateFleetConfig({ ...base, web: { log_tab: true, view_acess: "session" } });
    expect(r.valid).toBe(true);
    expect(r.warnings.filter(w => w.path.startsWith("web"))).toEqual([{ path: "web.view_acess", message: expect.stringMatching(/^unknown key \(known: public_link, .*view_access.*\) — ignored$/) }]);
    const known = validateFleetConfig({ ...base, web: { public_link: { allow_public: true }, echo_to_channel: true, usage_panel: true, log_tab: true, provider_secrets: false,
      allowed_hosts: ["a.example"], view_access: "open", notify_login: true, session: {}, preview: true, preview_port: 19281, preview_on_public_link: false } });
    expect(known.warnings.filter(w => w.path.startsWith("web"))).toEqual([]);
  });
});

describe("the disabled replies name the channel's access.allowed_users (#1874)", () => {
  function fleet(yaml: string) {
    const dir = mkdtempSync(join(tmpdir(), "agend-1874-")); dirs.push(dir);
    writeFileSync(join(dir, "fleet.yaml"), yaml);
    const fm = new FM(dir) as any;
    fm.loadConfig(join(dir, "fleet.yaml"));
    return fm;
  }
  it("a `channel:` fleet: channel.access.allowed_users", () => {
    const fm = fleet("channel:\n  type: discord\n  bot_token_env: T\n  group_id: G\n  access:\n    mode: locked\n    allowed_users: []\nweb:\n  access:\n    allowed_users: ['1']\ninstances: {}\n");
    expect([fm.hasFleetAdmins(), fm.adminListKey(), fm.adminListKey("discord")]).toEqual([false, "channel.access.allowed_users", "channel.access.allowed_users"]);
  });
  it("a `channels:` fleet: the entry, by its id — or its type when it has none", () => {
    const fm = fleet("channels:\n  - id: main\n    type: discord\n    bot_token_env: T\n    group_id: G\n  - type: telegram\n    bot_token_env: T2\n    group_id: '-1'\ninstances: {}\n");
    expect([fm.adminListKey(), fm.adminListKey("main"), fm.adminListKey("telegram")]).toEqual([
      "channels[id: main].access.allowed_users", "channels[id: main].access.allowed_users", "channels[type: telegram].access.allowed_users"]);
  });
  it("the /update slash handler's own check names it too (a direct call, behind the command table)", async () => {
    const fm = fleet("channel:\n  type: discord\n  bot_token_env: T\n  group_id: G\n  access:\n    mode: locked\n    allowed_users: []\ninstances: {}\n");
    const respond = vi.fn().mockResolvedValue(undefined);
    await fm.handleUpdateSlash({ userId: "u", respond }, "discord");
    expect(respond.mock.calls.map((c: unknown[]) => c[0])).toEqual([t("update.disabled", "channel.access.allowed_users")]);
  });
  it("EN and zh-TW: /web and /update say the bot has no fleet admins and where the list is", () => {
    const key = "channels[id: main].access.allowed_users";
    expect([t("dashboard.disabled", key), t("update.disabled", key)]).toEqual([
      `⛔ /web disabled — this bot has no fleet admins: ${key} in fleet.yaml is empty.`,
      `⛔ /update disabled — this bot has no fleet admins: ${key} in fleet.yaml is empty.`]);
    setLocale("zh-TW");
    expect([t("dashboard.disabled", key), t("update.disabled", key)]).toEqual([
      `⛔ /web 已停用：這個 bot 沒有 Fleet 管理員（fleet.yaml 的 ${key} 是空的）。`,
      `⛔ /update 已停用：這個 bot 沒有 Fleet 管理員（fleet.yaml 的 ${key} 是空的）。`]);
  });
});

describe("the handlers' own checks say it too (behind the command table: a direct call, #1874)", () => {
  it.each([["/web", "handleDashboardCommand", "dashboard.disabled"], ["/update", "handleUpdateCommand", "update.disabled"]] as const)("%s", async (text, handler, key) => {
    const sendText = vi.fn().mockResolvedValue({ messageId: "m", chatId: "c" });
    const keys: Array<string | undefined> = [];
    const commands = new TopicCommands({ adapter: { sendText }, adapters: new Map(), fleetConfig: { defaults: {}, instances: {} },
      hasFleetAdmins: () => false, isFleetAdmin: () => false, adminListKey: (id?: string) => { keys.push(id); return "channel.access.allowed_users"; } } as never);
    await (commands as any)[handler]({ chatId: "c", threadId: "t", userId: "u", adapterId: "discord", text, source: "discord" });
    expect([sendText.mock.calls.map(c => c[1]), keys]).toEqual([[t(key, "channel.access.allowed_users")], ["discord"]]);
  });
});
