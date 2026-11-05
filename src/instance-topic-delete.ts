/**
 * Deleting an agent's own chat topic when the agent is deleted (user decision, beta.9): by default, through the agent's
 * own bot, and said truthfully — `deleted: true` only when the platform confirmed it, otherwise the reason.
 *
 * The plan is made BEFORE the instance is removed (its fleet.yaml entry, and with it its topic id and bot, go with the
 * removal) and carried out after it: a removal that fails leaves the topic alone, and a topic that cannot be deleted
 * never fails the removal.
 *
 * Never deleted: the General topic (Telegram's forum root, id 1, or any instance's general_topic), a topic another
 * agent of the same bot also uses, and a ClassicBot room (a Classic agent has no fleet.yaml entry, so no topic of its
 * own here). On Discord an agent's "topic" is a text channel: deleting it deletes its history.
 */
import type { ChannelAdapter } from "./channel/types.js";
import type { InstanceConfig } from "./types.js";
import { t } from "./locale.js";

export type TopicDeleteOutcome = { deleted: true } | { deleted: false; reason: string };

/**
 * Where a topic physically is, whatever bot reaches it (#3055 review, Prism P1): a Telegram topic is (its group, its
 * thread id) — two bots in one group share it; a Discord channel id is unique across bots; anything else is per bot.
 */
export function topicDestination(platform: string | undefined, groupId: string | undefined, adapterId: string | undefined,
  topicId: number | string): string {
  if (platform === "telegram") return `telegram:${groupId ?? ""}:${topicId}`;
  if (platform === "discord") return `discord:${topicId}`;
  return `${platform ?? "?"}:${adapterId ?? ""}:${topicId}`;
}

/** What deleting an instance's topic will act on, or why nothing will be deleted. */
export type InstanceTopicPlan =
  | { kind: "delete"; name: string; topicId: number | string; adapterId: string | undefined; adapter: ChannelAdapter; destination: string }
  | { kind: "keep"; reason: string };

export const TOPIC_KEPT_BY_REQUEST = "kept (delete_topic: false)";

/** The fleet as it is NOW, for a topic's ownership: asked when planning and again right before the platform call. */
export interface TopicOwnership {
  instances: Record<string, InstanceConfig> | undefined;
  /** The physical destination of an instance's topic (null: none). */
  destinationOf(name: string): string | null;
  /** Every connection's own General destination (Telegram's topic 1 in its group, Discord's general_channel_id). */
  generalDestinations(): Set<string>;
}

/** Why `destination` must stay, given the fleet now (`except`: the instance being deleted), or null. */
export function topicMustStay(destination: string, own: TopicOwnership, except: string): string | null {
  if (own.generalDestinations().has(destination)) return "the General topic is never deleted";
  for (const [other, oc] of Object.entries(own.instances ?? {})) {
    if (other === except || own.destinationOf(other) !== destination) continue;
    return oc.general_topic ? "the General topic is never deleted" : `the topic is also used by ${other}`;
  }
  return null;
}

export function planInstanceTopicDelete(input: TopicOwnership & {
  name: string;
  /** The instance's own bot (its channel_id, else the fleet's primary), and that bot's adapter — never a substitute. */
  adapterId: string | undefined;
  adapter: ChannelAdapter | undefined;
}): InstanceTopicPlan {
  const { name, instances, adapterId, adapter } = input;
  const cfg = instances && Object.hasOwn(instances, name) ? instances[name] : undefined;
  if (!cfg) return { kind: "keep", reason: "the agent has no topic of its own (not a fleet.yaml agent)" };
  if (cfg.general_topic) return { kind: "keep", reason: "the General topic is never deleted" };
  const topicId = cfg.topic_id;
  if (topicId == null || topicId === "") return { kind: "keep", reason: "the agent has no topic" };
  if (!adapter) return { kind: "keep", reason: "the agent's bot is not connected, so its topic was left for manual cleanup" };
  const destination = input.destinationOf(name);
  if (!destination) return { kind: "keep", reason: "the agent has no topic" };
  if (adapter.type === "telegram" && String(topicId) === "1") return { kind: "keep", reason: "the General topic is never deleted" };
  const stay = topicMustStay(destination, input, name);
  if (stay) return { kind: "keep", reason: stay };
  if (!adapter.deleteTopic) return { kind: "keep", reason: `this ${adapter.type} bot cannot delete topics` };
  return { kind: "delete", name, topicId, adapterId, adapter, destination };
}

/** A platform's refusal, said as the reason a person can act on. */
export function describeTopicDeleteError(platform: string, err: unknown): string {
  const e = err as { description?: unknown; message?: unknown; code?: unknown; rawError?: { message?: unknown } } | null;
  const text = String(e?.description ?? e?.rawError?.message ?? e?.message ?? err ?? "");
  // The adapters' own refusals (deleteTopic) are already the reason.
  if (/^the General topic is never deleted$|^the Telegram bot is not connected to its group$|^not a topic channel AgEnD creates/.test(text)) return text;
  if (platform === "telegram") {
    if (/not enough rights|CHAT_ADMIN_REQUIRED|have no rights|rights to manage topics|need administrator rights/i.test(text)) {
      return "the Telegram bot lacks the Manage Topics admin right";
    }
    if (/TOPIC_ID_INVALID|TOPIC_DELETED|thread not found|topic not found|message thread/i.test(text)) return "topic not found";
    if (/not a forum|CHANNEL_FORUM_MISSING|forum/i.test(text)) return "the group is not a forum";
  }
  if (platform === "discord") {
    const code = Number(e?.code);
    if (code === 10003 || /Unknown Channel/i.test(text)) return "topic not found";
    if (code === 50013 || /Missing Permissions/i.test(text)) return "the Discord bot lacks the Manage Channels permission";
    if (code === 50001 || /Missing Access/i.test(text)) return "the Discord bot cannot see this channel";
  }
  const said = text.replace(/\s+/g, " ").trim().slice(0, 200);
  return said ? `the ${platform} API refused: ${said}` : `the ${platform} API refused without a reason`;
}

/**
 * Carry the plan out. Never throws: a topic left in place is an outcome, not a failure of the deletion.
 * `recheck` is asked synchronously right before the platform call (#3055 review, Prism P1): the plan was made before the
 * removal was awaited, and in between another agent may have been bound to the topic, or the bot rebuilt. A reason
 * from it keeps the topic. `inFlight` brackets the platform call (bindings refuse that destination meanwhile).
 */
export async function deletePlannedTopic(plan: InstanceTopicPlan | null, logger: {
  info(obj: object, msg: string): void; warn(obj: object, msg: string): void;
}, recheck: (plan: Extract<InstanceTopicPlan, { kind: "delete" }>) => string | null = () => null,
  inFlight?: { begin(destination: string): void; end(destination: string): void }): Promise<TopicDeleteOutcome> {
  if (!plan) return { deleted: false, reason: TOPIC_KEPT_BY_REQUEST };
  if (plan.kind === "keep") {
    logger.info({ reason: plan.reason }, "Instance topic kept");
    return { deleted: false, reason: plan.reason };
  }
  const where = { instance: plan.name, topicId: plan.topicId, adapterId: plan.adapterId, platform: plan.adapter.type };
  const stale = recheck(plan);
  if (stale) {
    logger.info({ ...where, reason: stale }, "Instance topic kept");
    return { deleted: false, reason: stale };
  }
  inFlight?.begin(plan.destination);
  try {
    await plan.adapter.deleteTopic!(plan.topicId);
    logger.info(where, "Instance topic deleted");
    return { deleted: true };
  } catch (err) {
    const reason = describeTopicDeleteError(plan.adapter.type, err);
    logger.warn({ ...where, err, reason }, "Instance topic not deleted");
    return { deleted: false, reason };
  } finally {
    inFlight?.end(plan.destination);
  }
}

/** The topic part of a delete's HTTP answer: what happened, why it stayed, and a line the dashboard can show as is. */
export function topicFields(name: string, topic: TopicDeleteOutcome | null): Record<string, unknown> {
  if (!topic) return {};
  return topic.deleted
    ? { topic_deleted: true, topic_note: t("instance.topic_deleted", name) }
    : { topic_deleted: false, topic_reason: topic.reason, topic_note: t("instance.topic_kept", name, topic.reason) };
}
