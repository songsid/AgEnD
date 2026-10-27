import type { FleetConfig } from "./types.js";
import { discordGeneralChannelId } from "./discord-general.js";

/** Stable user-facing error shared by every manual pause entry point. */
export const GENERAL_PAUSE_ERROR = "General cannot be paused";

/**
 * General is a coordinator, not an expendable worker. The literal-name fallback
 * preserves the same legacy protection already used by Daemon auto-pause while
 * general_topic covers renamed and per-world General instances.
 */
export function isGeneralInstance(config: FleetConfig | null | undefined, name: string): boolean {
  return name === "general" || config?.instances[name]?.general_topic === true;
}

/** M-2069: the name a fleet's General has by default (the auto-created one, and the setup's first agent). */
export const GENERAL_NAME = "general";

/**
 * M-2069: the topic a General on this connection is bound to: the chat's own General — Telegram's built-in General
 * topic (thread 1), the Discord connection's general channel — never a new forum topic. Null for a Discord connection
 * without a valid general channel: a new General is then left unbound, as the fleet's own General is (autoCreateTopics),
 * and an adopted one keeps the topic it has.
 */
export function generalTopicFor(channel: Record<string, unknown>): number | string | null {
  if (channel.type === "telegram") return 1;
  if (channel.type !== "discord") return null;
  const general = discordGeneralChannelId(channel);
  return general != null && /^\d{17,}$/.test(general) ? general : null;
}

/**
 * M-2069: an agent named "general" is the General to its daemon, its tool profile and the pause guard, but the fleet
 * picks its dispatcher by general_topic. In a chat fleet with no General, the auto-General would be skipped (its name
 * is taken) and the fleet would run with no dispatcher. So that agent is made the General — on the primary connection,
 * in the chat's own General topic where it has one (Telegram's thread 1; Discord's general channel — without one, it
 * keeps the topic it has). On Telegram a stray forum topic it was given is left behind, unrouted. Left alone: a
 * "general" bound to another connection, a fleet that already has a General, and (#2744 review) a "general" working in
 * a folder AgEnD does not own (`ownFolder`) — the General's instructions would land in a project of the user's; the
 * fleet then adds its General under a free name (Phase 3). Returns whether the config changed.
 */
export function adoptGeneralByName(fleet: FleetConfig, logger: { warn(obj: unknown, msg?: string): void }, ownFolder: (dir: string) => boolean): boolean {
  const channels = (fleet.channels ?? (fleet.channel ? [fleet.channel] : [])) as unknown as Array<Record<string, unknown>>;
  if (!channels.length || !Object.hasOwn(fleet.instances, GENERAL_NAME)) return false;
  const inst = fleet.instances[GENERAL_NAME];
  if (inst.general_topic === true || Object.values(fleet.instances).some(cfg => cfg.general_topic === true)) return false;
  const primary = channels[0], primaryId = String(primary.id ?? primary.type);
  if (inst.channel_id != null && inst.channel_id !== primaryId) return false;
  if (!ownFolder(inst.working_directory)) return false;
  const topic = generalTopicFor(primary), from = inst.topic_id ?? null;
  inst.general_topic = true;
  if (topic != null) inst.topic_id = topic;
  logger.warn({ name: GENERAL_NAME, topic_from: from, topic_to: inst.topic_id ?? null },
    "An agent named general had no general_topic and the fleet had no General — made it the General (its chat's General topic)");
  return true;
}

/** M-2069: the first free name for a General the fleet creates: `base`, else `base-2`, `base-3`, … */
export function freeGeneralName(instances: Record<string, unknown>, base: string): string {
  let name = base;
  for (let n = 2; Object.hasOwn(instances, name); n++) name = `${base}-${n}`;
  return name;
}
