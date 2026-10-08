/**
 * Who may use a Discord slash command, decided once at the door.
 *
 * AgEnD registers its slash commands GLOBALLY: every guild the bot is in, and every DM with it, shows the
 * same menu — Discord has no per-channel visibility to lean on, and the lock emoji in a description is only
 * a label. So the handler is the only place authority can be enforced, and for a long time it was not: a
 * slash command skipped the allowlist that guards the same words typed as a message, never looked at which
 * guild it came from, and (apart from /start) never looked at whether it came from a DM. Anyone who shared
 * any server with the bot could `/steer`, `/compact` or `/cancel` a fleet instance, or run `/sysinfo`.
 *
 * This is the pure decision. The caller supplies the facts (it owns the routing table, the access managers
 * and the adapter's config), so the rule is testable without a Discord client and cannot drift between the
 * two places that dispatch slash commands.
 *
 * What it settles, in order:
 *  1. a DM is refused — nothing in AgEnD is addressed to a DM channel, and `guildId` is the only thing that
 *     tells a DM from a guild;
 *  2. the guild must be the adapter's own, unless the channel is a registered ClassicBot channel (those are
 *     open by design, in any guild the operator allowed) or the command is `/start` (which validates its own
 *     guild against `allowed_guilds`) — and a command that needs a fleet admin needs the fleet's own guild even
 *     from a ClassicBot channel;
 *  3. whoever speaks must be someone the text path would also hear: a fleet channel applies the access policy
 *     of the adapter that owns its instance, anywhere else the invoking adapter's. ClassicBot channels stay
 *     open, exactly as they are for typed messages.
 *
 * Which admin level a command needs stays with the command: this only decides whether the caller may speak.
 */
export type SlashScope = "fleet" | "classic" | "none";

export type SlashSpeaker =
  /** The caller is an explicit fleet admin, or the access policy of the world that governs this channel admits them. */
  | "allowed"
  | "denied"
  /** A fleet channel whose owning adapter is not running: its policy cannot be applied, so nothing is let through. */
  | "owner-not-running";

export interface SlashFacts {
  command: string;
  /** Discord's guild id for the interaction; absent in a DM. */
  guildId?: string;
  /** The guild this adapter's fleet lives in (`group_id`); empty/absent when the adapter has none. */
  primaryGuildId?: string;
  /** What the channel the command was typed in is. */
  scope: SlashScope;
  speaker: SlashSpeaker;
  /**
   * The command needs a fleet admin in this scope (the command table's level). A ClassicBot channel is open in any
   * guild the operator allowed, but fleet administration is not: it is refused outside the fleet's own guild
   * (#754 audit) — otherwise any guild that hosts a ClassicBot channel is a place to run /update or /restart from.
   */
  fleetAdminCommand?: boolean;
}

export type SlashDenial = "dm" | "wrong-guild" | "not-allowed" | "owner-not-running";

export type SlashDecision = { allow: true } | { allow: false; reason: SlashDenial };

export function decideSlash(f: SlashFacts): SlashDecision {
  if (!f.guildId) return { allow: false, reason: "dm" };

  const inOwnGuild = !!f.primaryGuildId && f.guildId === f.primaryGuildId;
  if (!inOwnGuild && f.scope !== "classic" && f.command !== "start") {
    return { allow: false, reason: "wrong-guild" };
  }
  if (!inOwnGuild && f.fleetAdminCommand) return { allow: false, reason: "wrong-guild" };

  // Typed messages in a ClassicBot channel are open to everyone there, and so are its slash commands.
  if (f.scope === "classic") return { allow: true };
  // `/start` in a channel nobody has registered is how a ClassicBot channel comes to exist; its own guild
  // check (allowed_guilds) is the gate, as it always was.
  if (f.scope === "none" && f.command === "start") return { allow: true };

  if (f.speaker === "owner-not-running") return { allow: false, reason: "owner-not-running" };
  return f.speaker === "allowed" ? { allow: true } : { allow: false, reason: "not-allowed" };
}
