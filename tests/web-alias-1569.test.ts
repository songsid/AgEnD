/**
 * #1569: `/web` is `/dashboard` under a shorter name. One command-table row, two names: the same permission gate, the
 * same scopes (fleet-admin everywhere, Telegram General-only), the same disabled state, the same refusals and the same
 * subcommand (`/web revoke`). Each case below runs `/dashboard` and `/web` in fresh, identical fleets (the real
 * FleetManager, TopicCommands and command table; no process, CLI or tunnel) and compares everything the user sees.
 * Design baseline: #1569 issuecomment-6098688416.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { COMMANDS, COMMAND_ALIASES, canonicalCommand, commandSpec, slashLock, telegramMenu } from "../src/command-table.js";
import { setLocale, t } from "../src/locale.js";

const dirs: string[] = [];
const fleets: FleetManager[] = [];
beforeEach(() => { setLocale("en"); });
afterEach(() => {
  for (const fm of fleets.splice(0)) { const s = fm as any; for (const e of s.pendingNonceButtons.values()) clearTimeout(e.timer); fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A fleet whose owning bot lists `admins` as its fleet admins (empty: the command is "disabled"). */
function fleet(platform: "telegram" | "discord", admins: string[] = ["admin"]) {
  const dir = mkdtempSync(join(tmpdir(), "agend-1569-")); dirs.push(dir);
  const fm = new FleetManager(dir), s = fm as any; fleets.push(fm);
  const adapter = { id: "owner", type: platform,
    sendText: vi.fn(async (chat: string, _text: string, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "out" })),
    notifyAlert: vi.fn(async (chat: string, _alert: any, opts?: any) => ({ chatId: chat, threadId: opts?.threadId, messageId: "menu" })),
    sendDirect: vi.fn(async (user: string) => ({ chatId: user, messageId: "dm" })),
    editMessageRemoveButtons: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const owner = { id: "owner", type: platform, group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: admins } };
  fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner], instances: {
    general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" },
    worker: { working_directory: dir, topic_id: "T1", channel_id: "owner" },
  } } as never;
  fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("owner", adapter); s.adapter = adapter;
  s.worlds.set("owner", { adapter, groupId: "G", channelConfig: owner, accessManager: { isAllowed: () => true }, stop: async () => {} });
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false };
  writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 }); s.initializeWebSessions();
  vi.spyOn(fm, "getDashboardAccess").mockReturnValue({ ready: true, token: "c".repeat(48) });
  const revoke = vi.spyOn(fm, "revokeWebSessions");
  return { fm, s, adapter, revoke };
}

/** Everything a person sees, minus the per-run nonce/code. */
const seen = (calls: unknown[][]) => JSON.parse(JSON.stringify(calls).replace(/[0-9a-f]{32}/g, "NONCE").replace(/[A-Z0-9]{4}-[A-Z0-9]{4}/g, "CODE"));

async function slash(command: string, user: string, admins?: string[], action?: string, channel = "T0") {
  const f = fleet("discord", admins);
  const respond = vi.fn(async (_text: string) => "reply"), respondButtons = vi.fn(async (_text: string, _choices: unknown) => "menu-msg");
  await f.s.dispatchSlash({ command, guildId: "G", channelId: channel, userId: user, username: user, options: action ? { action } : {}, respond, respondButtons }, "owner", f.adapter);
  return { replies: seen(respond.mock.calls), menus: seen(respondButtons.mock.calls), dms: seen(f.adapter.sendDirect.mock.calls),
    posts: seen(f.adapter.sendText.mock.calls), revoked: f.revoke.mock.calls.length, armed: f.s.pendingNonceButtons.size };
}

async function typed(text: string, user: string, admins?: string[], thread = "T0") {
  const f = fleet("telegram", admins);
  const msg = { source: "telegram", adapterId: "owner", chatId: "G", threadId: thread, userId: user, username: user, text, messageId: "in", timestamp: new Date() };
  const handled = thread === "T0" ? await f.s.topicCommands.handleGeneralCommand(msg) : await f.s.topicCommands.handleInstanceCommand(msg, "worker");
  return { handled, posts: seen(f.adapter.sendText.mock.calls), menus: seen(f.adapter.notifyAlert.mock.calls),
    dms: seen(f.adapter.sendDirect.mock.calls), revoked: f.revoke.mock.calls.length, armed: f.s.pendingNonceButtons.size };
}

describe("#1569: the command table — one row, two names", () => {
  it("/web resolves to the /dashboard row itself (gate, scopes, disabled state, refusals), not a copy", () => {
    expect(canonicalCommand("web")).toBe("dashboard");
    expect(commandSpec("web")).toBe(commandSpec("dashboard"));
    expect(slashLock("web")).toBe(slashLock("dashboard"));
    expect(commandSpec("web")!.denied).toEqual(["not_authorized"]);
    expect(commandSpec("web")!.disabled).toEqual(["dashboard.disabled"]);
  });

  it("an alias never shadows a real command, and always names one", () => {
    for (const [alias, target] of Object.entries(COMMAND_ALIASES)) {
      expect(COMMANDS.some(c => c.name === alias), `/${alias} is not itself a command`).toBe(false);
      expect(COMMANDS.some(c => c.name === target), `/${alias} names a real command`).toBe(true);
    }
    expect(canonicalCommand("status")).toBe("status");
    expect(canonicalCommand("constructor"), "only own keys are aliases").toBe("constructor");
  });

  it("the Telegram fleet menu offers /web right after /dashboard, with the same lock and its own description", () => {
    const menu = telegramMenu("fleet");
    const at = menu.findIndex(e => e.name === "dashboard");
    expect(menu[at + 1]).toEqual({ name: "web", lock: menu[at]!.lock });
    expect(t("slash.web")).toContain("/dashboard");
    setLocale("zh-TW"); expect(t("slash.web")).toContain("/dashboard");
  });
});

describe("#1569: Discord /web does exactly what /dashboard does", () => {
  it.each([
    ["a fleet admin (the menu)", "admin", undefined, undefined],
    ["a member (the refusal)", "member", undefined, undefined],
    ["no fleet admins configured (disabled)", "admin", [] as string[], undefined],
    ["a fleet admin's revoke", "admin", undefined, "revoke"],
    ["a member's revoke (refused)", "member", undefined, "revoke"],
  ])("%s", async (_n, user, admins, action) => {
    const dashboard = await slash("dashboard", user, admins, action);
    const web = await slash("web", user, admins, action);
    expect(web).toEqual(dashboard);
    // …and it is the real outcome, not two identical nothings:
    if (user === "member") expect(web.replies).toEqual([[t("not_authorized")]]);
    else if (admins && admins.length === 0) expect(web.replies).toEqual([[t("dashboard.disabled")]]);
    else if (action === "revoke") expect(web.revoked).toBe(1);
    else expect(web.menus.length + web.dms.length).toBeGreaterThan(0);
  });
});

describe("#1569: Telegram /web does exactly what /dashboard does", () => {
  it.each([
    ["General, a fleet admin (the menu)", "", "admin", undefined, "T0"],
    ["General, a member (the refusal)", "", "member", undefined, "T0"],
    ["General, no fleet admins (disabled)", "", "admin", [] as string[], "T0"],
    ["General, a fleet admin's revoke", " revoke", "admin", undefined, "T0"],
    ["an instance topic (General-only: pointed to General)", "", "admin", undefined, "T1"],
  ])("%s", async (_n, args, user, admins, thread) => {
    const dashboard = await typed(`/dashboard${args}`, user, admins, thread);
    const web = await typed(`/web${args}`, user, admins, thread);
    expect(web).toEqual(dashboard);
    expect(web.handled, "a command, not text for the agent").toBe(true);
    if (thread === "T1") expect(JSON.stringify(web.posts)).toContain(JSON.stringify(t("cmd.use_in_general", "/dashboard")).slice(1, -1));
    else if (user === "member") expect(JSON.stringify(web.posts)).toContain(JSON.stringify(t("not_authorized")).slice(1, -1));
    else if (admins && admins.length === 0) expect(JSON.stringify(web.posts)).toContain(JSON.stringify(t("dashboard.disabled")).slice(1, -1));
    else if (args === " revoke") expect(web.revoked).toBe(1);
    else expect(web.armed, "the menu was posted").toBe(1);
  });

  it("only /web and /web <args>: /webhook, /website and /web@other-forms that are not the command stay text", async () => {
    for (const text of ["/webhook", "/website", "/webx revoke"]) expect((await typed(text, "admin")).handled, text).toBe(false);
    expect((await typed("/web@agend_bot", "admin")).armed).toBe(1);
  });
});
