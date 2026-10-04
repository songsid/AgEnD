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
 *  - fleet-admin    an explicit entry in the INVOKING adapter's `allowed_users`; an empty list means nobody
 *  - classic-admin  a ClassicBot admin only (`admin_users`)
 *
 * Scopes: `fleet` is an instance's own channel, `general` the General dispatcher (also a fleet channel, but some
 * commands differ there), `classic` a ClassicBot channel, `none` a channel AgEnD has no agent in.
 */
export type CommandScope = "fleet" | "general" | "classic" | "none";
export type CommandLevel = "anyone" | "channel-admin" | "fleet-admin" | "classic-admin";

/** A locale key, optionally with arguments (`cmd.admin_required` wants the command name). */
export type Reply = readonly [key: string, ...args: string[]];

export type ScopeRule =
  | { readonly level: CommandLevel }
  /** The command does not apply in this kind of channel: say so, with this reply, and do nothing. */
  | { readonly refuse: Reply };

export interface CommandSpec {
  readonly name: string;
  /** Appears in the Discord slash menu. */
  readonly slash: boolean;
  readonly scopes: Readonly<Record<CommandScope, ScopeRule>>;
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

export const COMMANDS: readonly CommandSpec[] = [
  // ── ClassicBot lifecycle ──
  {
    name: "start", slash: true, denied: NOT_AUTHORIZED,
    // Anyone may start one in a channel nobody has registered (the guild allowlist is its gate, checked by the handler).
    scopes: { fleet: { refuse: ["classic.topic_bound"] }, general: { refuse: ["classic.topic_bound"] }, classic: { refuse: ["classic.already_active"] }, none: { level: "anyone" } },
  },
  { name: "stop", slash: true, denied: ["classic.admin_only_stop"], scopes: classicOnly("channel-admin", NO_AGENT) },
  { name: "chat", slash: true, denied: NOT_AUTHORIZED, scopes: classicOnly("anyone", NO_AGENT_START) },
  { name: "load", slash: true, denied: ["admin.required"], scopes: classicOnly("classic-admin", NO_AGENT_START) },

  // ── Per-agent controls ──
  { name: "pause", slash: true, denied: PERMISSION_DENIED, scopes: inAgentChannels("channel-admin", NO_AGENT) },
  { name: "wake", slash: true, denied: PERMISSION_DENIED, scopes: inAgentChannels("channel-admin", NO_AGENT) },
  { name: "compact", slash: true, denied: ["cmd.admin_required", "/compact"], scopes: inAgentChannels("channel-admin", NO_AGENT) },
  { name: "clear", slash: true, denied: PERMISSION_DENIED, scopes: inAgentChannels("channel-admin", NO_AGENT) },
  { name: "model", slash: true, denied: PERMISSION_DENIED, scopes: inAgentChannels("channel-admin", NO_AGENT) },
  { name: "effort", slash: true, denied: PERMISSION_DENIED, scopes: inAgentChannels("channel-admin", NO_AGENT) },
  { name: "collab", slash: true, denied: NOT_AUTHORIZED, scopes: inAgentChannels("channel-admin", NO_AGENT_START) },
  { name: "save", slash: true, denied: ["admin.required"], scopes: inAgentChannels("channel-admin", NO_AGENT_START) },
  // Anyone who can talk to the agent may talk to it mid-turn, ask a side question, interrupt it or read its context.
  { name: "steer", slash: true, denied: NOT_AUTHORIZED, scopes: inAgentChannels("anyone", NO_AGENT) },
  { name: "btw", slash: true, denied: NOT_AUTHORIZED, scopes: inAgentChannels("anyone", NO_AGENT) },
  { name: "cancel", slash: true, denied: NOT_AUTHORIZED, scopes: inAgentChannels("anyone", NO_AGENT) },
  { name: "ctx", slash: true, denied: NOT_AUTHORIZED, scopes: inAgentChannels("anyone", NO_AGENT) },

  // ── The fleet, from anywhere ──
  { name: "status", slash: true, denied: ["cmd.admin_required", "/status"], scopes: everywhere("fleet-admin") },
  { name: "restart", slash: true, denied: NOT_AUTHORIZED, scopes: everywhere("fleet-admin") },
  { name: "login", slash: true, denied: PERMISSION_DENIED, scopes: everywhere("fleet-admin") },
  { name: "update", slash: true, denied: NOT_AUTHORIZED, disabled: ["update.disabled"], scopes: everywhere("fleet-admin") },
  { name: "doctor", slash: true, denied: NOT_AUTHORIZED, scopes: everywhere("fleet-admin") },
  { name: "dashboard", slash: true, denied: NOT_AUTHORIZED, disabled: ["dashboard.disabled"], scopes: everywhere("fleet-admin") },
  // Informational. `/tips on|off|advanced on` change settings and are gated by the handler on that argument.
  { name: "sysinfo", slash: true, denied: NOT_AUTHORIZED, scopes: everywhere("anyone") },
  { name: "usage", slash: true, denied: NOT_AUTHORIZED, scopes: everywhere("anyone") },
  { name: "tips", slash: true, denied: PERMISSION_DENIED, scopes: everywhere("anyone") },
];

const BY_NAME = new Map(COMMANDS.map(spec => [spec.name, spec]));

export function commandSpec(name: string): CommandSpec | undefined {
  return BY_NAME.get(name);
}

/** True when some scope the command applies in asks for more than `anyone` — what the lock emoji says. */
export function isLocked(spec: CommandSpec): boolean {
  return SCOPES.some(scope => {
    const rule = spec.scopes[scope];
    return "level" in rule && rule.level !== "anyone";
  });
}

/** The prefix for a slash command's menu description: generated, never typed. Unknown names get none. */
export function slashLock(name: string): string {
  const spec = BY_NAME.get(name);
  return spec && isLocked(spec) ? "🔒 " : "";
}

export type FleetAdminState = "ok" | "disabled" | "denied";

/** What the caller knows about the person; each is asked only if the command's level needs it. */
export interface CommandChecks {
  fleetAdmin(): FleetAdminState;
  channelAdmin(): boolean;
  classicAdmin(): boolean;
}

export type CommandDecision = { allow: true } | { allow: false; reply: Reply };

export function decideCommand(spec: CommandSpec, scope: CommandScope, checks: CommandChecks): CommandDecision {
  const rule = spec.scopes[scope];
  if ("refuse" in rule) return { allow: false, reply: rule.refuse };
  switch (rule.level) {
    case "anyone":
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
