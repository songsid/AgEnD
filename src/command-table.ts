/**
 * The command table: for every command AgEnD answers, WHERE it applies and WHO may use it.
 *
 * Before this there was no single place to look. A slash command's lock emoji was typed by hand into its
 * description, its gate lived in whichever of two copied handlers dispatched it, and the same command had a
 * different gate in a fleet channel, a ClassicBot channel and as typed text. The audit of #1148 found `/compact`
 * labelled 🔒 and open to everyone, `/stop` open on Discord and admin-only on Telegram, `/save` judged by the wrong
 * kind of admin — all of them the same mistake: the rule and the label were allowed to disagree.
 *
 * This file is pure data plus one pure function, so it can be read, and tested cell by cell, without a client.
 *
 * It sits BEHIND the door in src/slash-authz.ts and never in front of it. The door decides whether the caller may
 * speak here at all (not a DM, an acceptable guild, the access policy of the channel's owner, fail closed). Only
 * then does this ask whether the command applies in this kind of channel and which kind of admin it needs. It can
 * therefore only narrow what the door let through; nothing here is a way around it.
 *
 * Levels
 *  - anyone         whoever the door admitted (in a fleet channel: someone the access policy hears; in a ClassicBot
 *                   channel: everyone, as for typed messages)
 *  - channel-admin  the admin of the channel's own kind: in a fleet channel an explicit fleet admin, in a ClassicBot
 *                   channel a fleet admin OR a ClassicBot admin (what `isModelAdmin` always meant)
 *  - fleet-admin    an explicit entry in the OWNING adapter's `allowed_users` (invoking when no target); empty grants nobody
 *  - classic-admin  a ClassicBot admin only (`admin_users`)
 *  - handler        the door has admitted the caller and the table asks nothing more: the command's own handler
 *                   decides, because the rule is not one level. Only `/start` is like this — an allowlist that is a
 *                   different list on each platform (see `start` below). A command with this level is not locked.
 *
 * Platforms: the table is read per platform. `scopes` is what the Discord slash dispatcher enforces; `telegram`, where
 * present, holds the cells where Telegram gates differently. A typed Telegram command in a fleet topic or General is
 * decided by this table before its handler runs (`TopicCommands.tableRefusal`, #754), and the ClassicBot handlers ask
 * the same levels themselves; each Telegram cell is pinned against the real handlers by
 * tests/command-gates-by-platform.test.ts. The audit that produced
 * this table once folded both platforms into one level per command and lost Telegram's side of it; a cell that holds
 * for Discord is not thereby true for Telegram, and "most restrictive wins" is not a way to merge them.
 *
 * Scopes: `fleet` is an instance's own channel, `general` the General dispatcher (also a fleet channel, but some
 * commands differ there), `classic` a ClassicBot channel, `none` a channel AgEnD has no agent in.
 */
export type CommandScope = "fleet" | "general" | "classic" | "none";
export type CommandLevel = "anyone" | "channel-admin" | "fleet-admin" | "classic-admin" | "handler";
export type Platform = "discord" | "telegram";

/** A locale key, optionally with arguments (`cmd.admin_required` wants the command name). */
export type Reply = readonly [key: string, ...args: string[]];

/**
 * One scope on one platform. `passthrough`: there is no handler for this command here — the typed text is not a
 * command, it goes to the agent like any message (or, in a chat with no agent, is dropped). It is NOT a refusal and
 * grants nothing; it exists so that "Telegram has no such command" is stated instead of being read off Discord's cell.
 */
export type PlatformRule = ScopeRule | { readonly passthrough: true };

export type ScopeRule =
  | { readonly level: CommandLevel; /** For `handler`: what the handler checks, per platform. */ readonly note?: string }
  /** The command does not apply in this kind of channel: say so, with this reply, and do nothing. */
  | { readonly refuse: Reply };

export interface CommandSpec {
  readonly name: string;
  /** Appears in the Discord slash menu. */
  readonly slash: boolean;
  /** What the Discord slash dispatcher enforces. */
  readonly scopes: Readonly<Record<CommandScope, ScopeRule>>;
  /** What Telegram's own handlers do, every scope written out (nothing is inherited from `scopes`). */
  readonly telegram: Readonly<Record<CommandScope, PlatformRule>>;
  /** Said when the caller is not at the required level. */
  readonly denied: Reply;
  /** Said instead of `denied` when a fleet-admin command is off because the adapter lists no admins at all. */
  readonly disabled?: Reply;
}

const SCOPES: readonly CommandScope[] = ["fleet", "general", "classic", "none"];

/** The same level everywhere. */
const everywhere = (level: CommandLevel): CommandSpec["scopes"] =>
  ({ fleet: { level }, general: { level }, classic: { level }, none: { level } });

/** An agent's own channel (fleet, General, ClassicBot): `level` there, `otherwise` anywhere else. */
const inAgentChannels = (level: CommandLevel, otherwise: Reply): CommandSpec["scopes"] =>
  ({ fleet: { level }, general: { level }, classic: { level }, none: { refuse: otherwise } });

/** ClassicBot channels only: `level` there, `otherwise` everywhere else. */
const classicOnly = (level: CommandLevel, otherwise: Reply): CommandSpec["scopes"] =>
  ({ fleet: { refuse: otherwise }, general: { refuse: otherwise }, classic: { level }, none: { refuse: otherwise } });

const NOT_AUTHORIZED: Reply = ["not_authorized"];
const PERMISSION_DENIED: Reply = ["permission.denied"];
const NO_AGENT: Reply = ["classic.no_agent"];
const NO_AGENT_START: Reply = ["classic.no_agent_start"];

/**
 * The Telegram column, written out for EVERY scope of every command: a Telegram cell is never inherited from Discord,
 * because most of them differ (a command can have no Telegram handler at all). Scopes are the same four: `general` is
 * the General topic, `fleet` an instance's own topic, `classic` a registered ClassicBot chat (private, or a group
 * addressed with `/cmd@bot`), `none` a chat with no agent (an unregistered group or private chat).
 */
const PASS: PlatformRule = { passthrough: true };
const ANYONE: PlatformRule = { level: "anyone" };
const FLEET_ADMIN: PlatformRule = { level: "fleet-admin" };
const CLASSIC_ADMIN: PlatformRule = { level: "classic-admin" };
const CHANNEL_ADMIN: PlatformRule = { level: "channel-admin" };
/** A chat with no agent: the command exists on Telegram and checks the caller, then finds nothing to act on — nobody gets it. */
const NOBODY_NO_AGENT: PlatformRule = { refuse: NO_AGENT };
const NOBODY_NO_AGENT_START: PlatformRule = { refuse: NO_AGENT_START };
const HANDLER: PlatformRule = { level: "handler", note: "Telegram private: user allowlist. Telegram group: group allowlist + ClassicBot admin." };
const tg = (general: PlatformRule, fleet: PlatformRule, classic: PlatformRule, none: PlatformRule = PASS): CommandSpec["telegram"] =>
  ({ general, fleet, classic, none });
/**
 * Only the General topic has a handler. In an instance topic the command is refused with a pointer to General (#1148):
 * it used to be an ordinary message to the agent, which got raw command text instead of AgEnD acting or refusing. In a
 * ClassicBot chat it is still not a command.
 */
const tgGeneralOnly = (general: PlatformRule, name: string): CommandSpec["telegram"] =>
  tg(general, { refuse: ["cmd.use_in_general", `/${name}`] }, PASS);

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "profile", slash: true, denied: NOT_AUTHORIZED, disabled: ["profile.disabled"],
    scopes: { general: { level: "fleet-admin" }, fleet: { refuse: ["profile.general_only"] },
      classic: { refuse: ["profile.general_only"] }, none: { refuse: ["profile.general_only"] } },
    telegram: tgGeneralOnly(FLEET_ADMIN, "profile"),
  },
  // ── ClassicBot lifecycle ──
  {
    name: "start", slash: true, denied: NOT_AUTHORIZED,
    // The handler admits ClassicBot admins directly, or an explicitly allowed guild/private user.
    // Empty lists request General approval. Telegram groups retain their ClassicBot admin start role.
    scopes: {
      fleet: { refuse: ["classic.topic_bound"] }, general: { refuse: ["classic.topic_bound"] }, classic: { refuse: ["classic.already_active"] },
      none: { level: "handler", note: "ClassicBot admin, or explicit guild/private-user grant; empty lists request approval. Telegram groups: ClassicBot admin." },
    },
    telegram: tg(PASS, PASS, HANDLER, HANDLER),
  },
  // A ClassicBot admin on both platforms. Telegram always required one; Discord used to require nothing ("the guild
  // allowlist is the trust boundary"), then briefly a channel admin, which let a fleet admin stop a channel Telegram
  // would not have let them stop.
  { name: "stop", slash: true, denied: ["classic.admin_only_stop"], scopes: classicOnly("classic-admin", NO_AGENT), telegram: tg(PASS, PASS, CLASSIC_ADMIN, NOBODY_NO_AGENT) },
  { name: "chat", slash: true, denied: NOT_AUTHORIZED, scopes: classicOnly("anyone", NO_AGENT_START), telegram: tg(PASS, PASS, ANYONE) },
  // Discord only: on Telegram `/load` is not a command (the text goes to the agent).
  { name: "load", slash: true, denied: ["admin.required"], scopes: classicOnly("classic-admin", NO_AGENT_START), telegram: tg(PASS, PASS, PASS) },

  // ── Per-agent controls ──
  // Channel-admin on both platforms (#754): in a ClassicBot chat the owning bot's fleet admin or a ClassicBot admin
  // (`isModelAdmin`); in a fleet topic, the owning bot's fleet admin.
  { name: "pause", slash: true, denied: PERMISSION_DENIED, scopes: inAgentChannels("channel-admin", NO_AGENT), telegram: tg(FLEET_ADMIN, FLEET_ADMIN, CHANNEL_ADMIN, NOBODY_NO_AGENT_START) },
  { name: "wake", slash: true, denied: PERMISSION_DENIED, scopes: inAgentChannels("channel-admin", NO_AGENT), telegram: tg(FLEET_ADMIN, FLEET_ADMIN, CHANNEL_ADMIN, NOBODY_NO_AGENT_START) },
  // Discord once had no check at all (the 🔒 was only a label), and Telegram none in a fleet topic (#1148 audit).
  { name: "compact", slash: true, denied: ["cmd.admin_required", "/compact"], scopes: inAgentChannels("channel-admin", NO_AGENT), telegram: tg(FLEET_ADMIN, FLEET_ADMIN, CHANNEL_ADMIN, NOBODY_NO_AGENT_START) },
  { name: "clear", slash: true, denied: PERMISSION_DENIED, scopes: inAgentChannels("channel-admin", NO_AGENT), telegram: tg(FLEET_ADMIN, FLEET_ADMIN, CHANNEL_ADMIN, NOBODY_NO_AGENT_START) },
  { name: "model", slash: true, denied: PERMISSION_DENIED, scopes: inAgentChannels("channel-admin", NO_AGENT), telegram: tg(FLEET_ADMIN, FLEET_ADMIN, CHANNEL_ADMIN, NOBODY_NO_AGENT_START) },
  // Telegram has no ClassicBot /effort handler (the text goes to the agent).
  { name: "effort", slash: true, denied: PERMISSION_DENIED, scopes: inAgentChannels("channel-admin", NO_AGENT), telegram: tg(FLEET_ADMIN, FLEET_ADMIN, PASS) },
  // Telegram has no ClassicBot /collab handler (the text goes to the agent).
  { name: "collab", slash: true, denied: NOT_AUTHORIZED, scopes: inAgentChannels("channel-admin", NO_AGENT_START), telegram: tg(FLEET_ADMIN, FLEET_ADMIN, PASS) },
  // Same levels as /compact.
  { name: "save", slash: true, denied: ["admin.required"], scopes: inAgentChannels("channel-admin", NO_AGENT_START), telegram: tg(FLEET_ADMIN, FLEET_ADMIN, CHANNEL_ADMIN, NOBODY_NO_AGENT_START) },
  // Anyone who can talk to the agent may talk to it mid-turn, ask a side question, interrupt it or read its context.
  { name: "steer", slash: true, denied: NOT_AUTHORIZED, scopes: inAgentChannels("anyone", NO_AGENT), telegram: tg(ANYONE, ANYONE, ANYONE, NOBODY_NO_AGENT_START) },
  { name: "btw", slash: true, denied: NOT_AUTHORIZED, scopes: inAgentChannels("anyone", NO_AGENT), telegram: tg(ANYONE, ANYONE, ANYONE, NOBODY_NO_AGENT_START) },
  { name: "cancel", slash: true, denied: NOT_AUTHORIZED, scopes: inAgentChannels("anyone", NO_AGENT), telegram: tg(ANYONE, ANYONE, ANYONE, NOBODY_NO_AGENT_START) },
  { name: "ctx", slash: true, denied: NOT_AUTHORIZED, scopes: inAgentChannels("anyone", NO_AGENT), telegram: tg(ANYONE, ANYONE, ANYONE, NOBODY_NO_AGENT_START) },

  // ── The fleet, from anywhere ── (on Telegram: only the General topic has these handlers)
  { name: "status", slash: true, denied: ["cmd.admin_required", "/status"], scopes: everywhere("fleet-admin"), telegram: tgGeneralOnly(FLEET_ADMIN, "status") },
  { name: "restart", slash: true, denied: NOT_AUTHORIZED, scopes: everywhere("fleet-admin"), telegram: tgGeneralOnly(FLEET_ADMIN, "restart") },
  { name: "login", slash: true, denied: PERMISSION_DENIED, scopes: everywhere("fleet-admin"), telegram: tgGeneralOnly(FLEET_ADMIN, "login") },
  { name: "update", slash: true, denied: NOT_AUTHORIZED, disabled: ["update.disabled"], scopes: everywhere("fleet-admin"), telegram: tgGeneralOnly(FLEET_ADMIN, "update") },
  { name: "doctor", slash: true, denied: NOT_AUTHORIZED, scopes: everywhere("fleet-admin"), telegram: tgGeneralOnly(FLEET_ADMIN, "doctor") },
  { name: "dashboard", slash: true, denied: NOT_AUTHORIZED, disabled: ["dashboard.disabled"], scopes: everywhere("fleet-admin"), telegram: tgGeneralOnly(FLEET_ADMIN, "dashboard") },
  // #1302: a fleet setting, so a fleet admin even to read it — the same as /doctor.
  { name: "visibility", slash: true, denied: NOT_AUTHORIZED, scopes: everywhere("fleet-admin"), telegram: tgGeneralOnly(FLEET_ADMIN, "visibility") },
  // Informational. `/tips on|off|advanced on` change settings and are gated by the handler on that argument.
  { name: "sysinfo", slash: true, denied: NOT_AUTHORIZED, scopes: everywhere("anyone"), telegram: tgGeneralOnly(ANYONE, "sysinfo") },
  { name: "usage", slash: true, denied: NOT_AUTHORIZED, scopes: everywhere("anyone"), telegram: tgGeneralOnly(ANYONE, "usage") },
  // On Telegram it also works in an instance's topic.
  { name: "tips", slash: true, denied: PERMISSION_DENIED, scopes: everywhere("anyone"), telegram: tg(ANYONE, ANYONE, PASS) },
];

const BY_NAME = new Map(COMMANDS.map(spec => [spec.name, spec]));

export function commandSpec(name: string): CommandSpec | undefined {
  return BY_NAME.get(name);
}

/** The rule for one scope on one platform: the Discord column for Discord, the Telegram column for Telegram. */
export function ruleFor(spec: CommandSpec, scope: CommandScope, platform: "discord"): ScopeRule;
export function ruleFor(spec: CommandSpec, scope: CommandScope, platform: Platform): PlatformRule;
export function ruleFor(spec: CommandSpec, scope: CommandScope, platform: Platform): PlatformRule {
  return platform === "telegram" ? spec.telegram[scope] : spec.scopes[scope];
}

/** True when some scope the command applies in asks for more than `anyone` — what the lock emoji says. */
export function isLocked(spec: CommandSpec): boolean {
  return SCOPES.some(scope => {
    const rule = spec.scopes[scope];
    return "level" in rule && rule.level !== "anyone" && rule.level !== "handler";
  });
}

/** The prefix for a slash command's menu description: generated, never typed. Unknown names get none. */
export function slashLock(name: string): string {
  const spec = BY_NAME.get(name);
  return spec && isLocked(spec) ? "🔒 " : "";
}

/** What a menu entry says after its description, as a locale key: the argument a command takes (#1145). */
const TELEGRAM_ARG_HINTS: Readonly<Record<string, string>> = { compact: "slash.compact_arg", visibility: "slash.visibility_arg" };

/**
 * The two Telegram command menus (`setMyCommands`), in menu order. Which commands a menu lists is picked by hand —
 * some handled commands stay out of it on purpose (`/cancel`, `/save`) — but nothing about them is typed: the lock
 * comes from the command's Telegram cells in the scopes the menu is shown in, and tests pin that every listed command
 * has a Telegram handler there (a menu entry with none is a command that does nothing when chosen).
 */
export const TELEGRAM_MENUS = {
  /** The fleet's forum group (its `chat` and `chat_administrators` scopes): the General topic and the instance topics. */
  fleet: {
    scopes: ["general", "fleet"],
    names: ["status", "sysinfo", "dashboard", "ctx", "compact", "steer", "btw", "clear", "model", "effort",
      "pause", "wake", "restart", "collab", "update", "profile", "doctor", "login", "usage", "tips", "visibility"],
  },
  /**
   * Every other chat (`default` and `all_group_chats`): ClassicBot private chats and groups, the ones with an agent and
   * the ones where `/start` would create it. No `/effort`: Telegram ClassicBot has no handler for it.
   */
  classic: {
    scopes: ["classic", "none"],
    names: ["start", "stop", "compact", "steer", "btw", "clear", "model", "pause", "wake", "ctx"],
  },
} as const satisfies Record<string, { scopes: readonly CommandScope[]; names: readonly string[] }>;

export type TelegramMenu = keyof typeof TELEGRAM_MENUS;

/** True when the command asks more than `anyone` on Telegram in some of these scopes — what its menu lock says. */
export function isLockedOnTelegram(spec: CommandSpec, scopes: readonly CommandScope[]): boolean {
  return scopes.some(scope => {
    const rule = spec.telegram[scope];
    return "level" in rule && rule.level !== "anyone" && rule.level !== "handler";
  });
}

/**
 * One Telegram menu: each command with its lock prefix ("🔒 " or ""), generated from the table, and the locale key of
 * its argument hint when it takes one.
 */
export function telegramMenu(menu: TelegramMenu): Array<{ name: string; lock: string; argHint?: string }> {
  const { scopes, names } = TELEGRAM_MENUS[menu];
  return names.map(name => {
    const spec = BY_NAME.get(name);
    if (!spec) throw new Error(`Telegram ${menu} menu lists /${name}, which the command table does not know`);
    const argHint = TELEGRAM_ARG_HINTS[name];
    return { name, lock: isLockedOnTelegram(spec, scopes) ? "🔒 " : "", ...(argHint ? { argHint } : {}) };
  });
}

export type FleetAdminState = "ok" | "disabled" | "denied";

/** What the caller knows about the person; each is asked only if the command's level needs it. */
export interface CommandChecks {
  fleetAdmin(): FleetAdminState;
  channelAdmin(): boolean;
  classicAdmin(): boolean;
}

export type CommandDecision = { allow: true } | { allow: false; reply: Reply };
/** On Telegram a cell can also be "not a command here" (see `PlatformRule`): nothing to authorize, refuse or run. */
export type PlatformDecision = CommandDecision | { allow: false; passthrough: true };

export function decideCommand(spec: CommandSpec, scope: CommandScope, checks: CommandChecks, platform?: "discord"): CommandDecision;
export function decideCommand(spec: CommandSpec, scope: CommandScope, checks: CommandChecks, platform: Platform): PlatformDecision;
export function decideCommand(spec: CommandSpec, scope: CommandScope, checks: CommandChecks, platform: Platform = "discord"): PlatformDecision {
  const rule = ruleFor(spec, scope, platform);
  if ("passthrough" in rule) return { allow: false, passthrough: true };
  if ("refuse" in rule) return { allow: false, reply: rule.refuse };
  switch (rule.level) {
    case "anyone":
    case "handler":
      return { allow: true };
    case "channel-admin":
      return checks.channelAdmin() ? { allow: true } : { allow: false, reply: spec.denied };
    case "classic-admin":
      return checks.classicAdmin() ? { allow: true } : { allow: false, reply: spec.denied };
    case "fleet-admin": {
      const state = checks.fleetAdmin();
      if (state === "ok") return { allow: true };
      return { allow: false, reply: state === "disabled" && spec.disabled ? spec.disabled : spec.denied };
    }
  }
}
