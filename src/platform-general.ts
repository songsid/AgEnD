/**
 * The General of each chat connection (user decision 2026-11-06, after the v2.3.3 field report behind #3200).
 *
 * The fleet creates a General by itself only for its FIRST connection. A platform added later with its own group or
 * server (quickstart's "Add another platform") therefore had no dispatcher: a message there outside an agent's topic
 * reached nobody, and its General had to be bound by hand. quickstart now offers that platform's General, and
 * `agend doctor` says which connection lacks one.
 *
 * A Discord persona — a second bot in the same guild as an earlier connection — shares that connection's General and
 * never gets one of its own.
 *
 * Pure: no file system, no process state (quickstart and the config validator both use it).
 */
import { join } from "node:path";
import { freeGeneralName } from "./general-instance.js";

export interface ChannelLike {
  id?: string;
  type: string;
  group_id?: unknown;
  options?: { general_channel_id?: unknown } | null;
  general_channel_id?: unknown;
}
type Instances = Record<string, unknown>;
/** The fleet's `defaults` as written (only `general_topic` matters here). */
type Defaults = { general_topic?: unknown } | null | undefined;

/**
 * Whether an instance is a General as the config loader makes it: its own `general_topic`, else the fleet default
 * (`defaults.general_topic: true` makes every unflagged instance one; an explicit `general_topic: false` never is).
 */
export function isEffectiveGeneral(inst: unknown, defaults?: Defaults): boolean {
  if (!inst || typeof inst !== "object") return false;
  const own = (inst as { general_topic?: unknown }).general_topic;
  return own === undefined || own === null ? defaults?.general_topic === true : own === true;
}

export const channelAdapterId = (ch: ChannelLike): string => ch.id ?? ch.type;

/** A persona: a connection of the same platform and the same group as an earlier one (a second bot in that guild). */
export function isPersonaChannel(channels: readonly ChannelLike[], index: number): boolean {
  const ch = channels[index];
  if (!ch) return false;
  return channels.slice(0, index).some(prev => prev.type === ch.type && prev.group_id != null && String(prev.group_id) === String(ch.group_id));
}

/**
 * The General answering for a connection, as the fleet routes it: one bound by channel_id, or — for the first
 * connection only — one with no channel_id (a missing channel_id is the first connection's).
 */
export function generalForAdapter(instances: Instances, channels: readonly ChannelLike[], adapterId: string, defaults?: Defaults): string | undefined {
  const first = channels[0] ? channelAdapterId(channels[0]) : undefined;
  for (const [name, inst] of Object.entries(instances ?? {})) {
    if (!isEffectiveGeneral(inst, defaults)) continue;
    const row = inst as { channel_id?: unknown };
    const bound = typeof row.channel_id === "string" && row.channel_id ? row.channel_id : first;
    if (bound === adapterId) return name;
  }
  return undefined;
}

/** The connections (adapter ids) with their own group that no General answers for. Personas are never listed. */
export function adaptersWithoutGeneral(instances: Instances, channels: readonly ChannelLike[], defaults?: Defaults): string[] {
  return channels.flatMap((ch, i) => {
    if (isPersonaChannel(channels, i)) return [];
    const id = channelAdapterId(ch);
    return generalForAdapter(instances, channels, id, defaults) ? [] : [id];
  });
}

/** Where a General's topic is, bound the way the fleet binds the first one: Telegram's General topic, Discord's channel. */
export function generalTopicId(ch: ChannelLike): number | string | undefined {
  if (ch.type === "telegram") return 1;
  if (ch.type === "discord") {
    const raw = ch.options?.general_channel_id ?? ch.general_channel_id;
    const id = raw == null ? "" : String(raw);
    return /^\d{17,}$/.test(id) ? id : undefined;   // no valid channel: left unbound, as the fleet does
  }
  return undefined;
}

/**
 * The General quickstart offers for the connection at `index` (just added): `general-<adapter>` in the AgEnD home,
 * bound to that adapter, its topic bound like the first General's. null when it needs none: a persona, or a General
 * already answers for that adapter (re-running quickstart never makes a second one).
 */
export function platformGeneralPlan(
  instances: Instances,
  channels: readonly ChannelLike[],
  index: number,
  home: string,
  defaults?: Defaults,
): { name: string; instance: { working_directory: string; general_topic: true; channel_id: string; topic_id?: number | string } } | null {
  const ch = channels[index];
  if (!ch || isPersonaChannel(channels, index)) return null;
  const adapterId = channelAdapterId(ch);
  if (generalForAdapter(instances, channels, adapterId, defaults)) return null;
  const name = freeGeneralName(instances ?? {}, `general-${adapterId}`);
  const topicId = generalTopicId(ch);
  return {
    name,
    instance: { working_directory: join(home, name), general_topic: true, channel_id: adapterId, ...(topicId !== undefined ? { topic_id: topicId } : {}) },
  };
}
