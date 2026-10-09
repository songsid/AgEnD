/**
 * #1386 "Needs you": one list of everything currently waiting on the person, derived — on demand, never stored —
 * from state the fleet already holds. Design: docs/design/1386-needs-you-inbox.md (§3 sources, §4 derivation).
 *
 * This module is pure: the fleet collects the inputs, this decides the items, which world owns each, what the
 * rendered list is (its signature), and the live chat message's text and links. Nothing here touches a socket,
 * a file or a clock of its own.
 */

export type NeedsYouType = "prompt" | "awaiting_input" | "instance" | "delivery";

export interface NeedsYouItem {
  /** Stable per occurrence: a new episode, crash or delivery is a new id (§3). */
  id: string;
  type: NeedsYouType;
  /** The instance to open; a delivery's is its target. */
  instance: string;
  /** The world (adapter id) that owns the instance, or undefined: listed only in /ui (§5.0). */
  owner?: string;
  /** Which kind of wait, for the title (localized by the renderer, not here). */
  reason: NeedsYouReason;
  /** One line, may be "": a prompt's text, an interaction summary, "source → target · kind". */
  detail: string;
  /** Epoch ms when it started waiting. */
  since: number;
  /** prompt: the nonce the web answers through POST /ui/prompt, its buttons, and where the buttons are. */
  nonce?: string;
  actions?: Array<{ id: string; label: string }>;
  promptAt?: { adapterId: string; chatId: string; threadId?: string; messageId?: string };
  /** delivery: the outbox row; Acknowledge offered. */
  deliveryId?: string;
}

export type NeedsYouReason =
  | "hang" | "exited" | "assist"                                    // prompt
  | "permission" | "dangerous_command" | "login" | "dialog" | "terminal_input"   // awaiting_input
  | "auth_paused" | "crashed"                                       // instance
  | "delivery_uncertain" | "delivery_failed";                       // delivery

/** A fleet prompt offered on the dashboard (hang / exit-restart / interactive-assist), as the fleet holds it. */
export interface PromptInput {
  nonce: string;
  prefix: string;
  instance: string;
  text: string;
  actions: Array<{ id: string; label: string }>;
  createdAt: number;
  adapterId: string;
  chatId: string;
  threadId?: string;
  messageId?: string;
  /** interactive-assist only: the interaction wait it was raised for (§3.2). */
  assistFor?: { owner: string | null; episode: number | null };
}

export interface InstanceInput {
  name: string;
  /** presentation state: "awaiting_input" when the CLI waits at its terminal and that is not stale/suspected. */
  state?: string;
  interaction?: { kind?: string | null; owner?: string | null; episode?: number | null; since?: number | null } | null;
  interactionSummary?: string | null;
  /** The pause marker's reason, for a paused instance; and when it was paused. */
  pauseReason?: string | null;
  pausedAt?: number | null;
  /** "crashed" with the time the fleet first saw it so (§3.3). */
  crashedAt?: number | null;
}

export interface DeliveryInput {
  deliveryId: string;
  state: "uncertain" | "failed";
  source: string;
  target: string;
  kind: string;
  finishedAt: number;
}

export interface NeedsYouInputs {
  prompts: PromptInput[];
  instances: InstanceInput[];
  deliveries: DeliveryInput[];
  /** The live world that owns an instance, or undefined (no channel, or its world is gone). */
  ownerOf: (instance: string) => string | undefined;
}

const PROMPT_REASON: Record<string, NeedsYouReason> = {
  "hang:": "hang",
  "exit-restart:": "exited",
  "interactive-assist:": "assist",
};

const INTERACTION_REASON: Record<string, NeedsYouReason> = {
  permission: "permission",
  dangerous_command: "dangerous_command",
  login: "login",
  dialog: "dialog",
  suspected_terminal_input: "terminal_input",
};

const oneLine = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** §3: every item, from the inputs only. Ordered by instance (the one with the oldest item first), then oldest first. */
export function deriveNeedsYou(inputs: NeedsYouInputs): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];

  // §3.1 prompts.
  for (const p of inputs.prompts) {
    const reason = PROMPT_REASON[p.prefix];
    if (!reason) continue;
    items.push({
      id: `prompt:${p.nonce}`, type: "prompt", instance: p.instance, reason,
      detail: oneLine(p.text), since: p.createdAt, nonce: p.nonce, actions: p.actions,
      promptAt: { adapterId: p.adapterId, chatId: p.chatId, ...(p.threadId !== undefined ? { threadId: p.threadId } : {}), ...(p.messageId ? { messageId: p.messageId } : {}) },
    });
  }

  for (const inst of inputs.instances) {
    // §3.2 awaiting_input — folded into an interactive-assist prompt only when it was raised for this same wait.
    if (inst.state === "awaiting_input" && inst.interaction) {
      const episode = inst.interaction.episode ?? null;
      const owner = inst.interaction.owner ?? null;
      const folded = inputs.prompts.some(p => p.prefix === "interactive-assist:" && p.instance === inst.name
        && p.assistFor !== undefined && p.assistFor.episode === episode && p.assistFor.owner === owner);
      if (!folded) {
        items.push({
          id: `awaiting:${inst.name}:${owner ?? "-"}:${episode ?? "-"}`, type: "awaiting_input", instance: inst.name,
          reason: INTERACTION_REASON[inst.interaction.kind ?? ""] ?? "dialog",
          detail: oneLine(inst.interactionSummary ?? ""), since: inst.interaction.since ?? 0,
        });
      }
    }
    // §3.3 instance: paused for sign-in, or crashed.
    if (inst.pauseReason === "auth") {
      items.push({ id: `auth:${inst.name}:${inst.pausedAt ?? 0}`, type: "instance", instance: inst.name, reason: "auth_paused", detail: "", since: inst.pausedAt ?? 0 });
    }
    if (inst.crashedAt != null) {
      items.push({ id: `crashed:${inst.name}:${inst.crashedAt}`, type: "instance", instance: inst.name, reason: "crashed", detail: "", since: inst.crashedAt });
    }
  }

  // §3.4 deliveries (already filtered by the outbox: unacknowledged, last 24 h, newest 50).
  for (const d of inputs.deliveries) {
    items.push({
      id: `delivery:${d.deliveryId}`, type: "delivery", instance: d.target,
      reason: d.state === "uncertain" ? "delivery_uncertain" : "delivery_failed",
      detail: oneLine(`${d.source} → ${d.target} · ${d.kind}`), since: d.finishedAt, deliveryId: d.deliveryId,
    });
  }

  for (const item of items) {
    const owner = inputs.ownerOf(item.instance);
    if (owner !== undefined) item.owner = owner;
  }

  // Group by instance; instances ordered by their oldest item, items oldest first.
  const oldest = new Map<string, number>();
  for (const item of items) oldest.set(item.instance, Math.min(oldest.get(item.instance) ?? Infinity, item.since));
  return items.sort((a, b) =>
    (oldest.get(a.instance)! - oldest.get(b.instance)!) || a.instance.localeCompare(b.instance) || (a.since - b.since) || a.id.localeCompare(b.id));
}

/** §5.0: the items a world's chat surfaces show — only those whose instance it owns. */
export function itemsForWorld(items: readonly NeedsYouItem[], world: string): NeedsYouItem[] {
  return items.filter(item => item.owner === world);
}

/** The age bucket shown next to an item: changes of it re-render, nothing finer does. */
export function ageLabel(sinceMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * §4.2: what a surface shows, as a string — ids in order, each item's displayed text and age bucket, and its action
 * coordinates (the prompt message it links to, its owning world). Two lists with the same signature render the same.
 * New-item notification is keyed on ids, separately; a re-render never notifies.
 */
export function renderSignature(items: readonly NeedsYouItem[], nowMs: number): string {
  return JSON.stringify(items.map(i => [
    i.id, i.reason, i.detail, ageLabel(i.since, nowMs), i.owner ?? null,
    i.promptAt ? [i.promptAt.adapterId, i.promptAt.chatId, i.promptAt.threadId ?? null, i.promptAt.messageId ?? null] : null,
  ]));
}

// ── Chat links (§5.1) ─────────────────────────────────────────────────────────────────────────────────────────

export interface WorldPlace {
  type: "discord" | "telegram" | string;
  /** Discord: the guild id. Telegram: the supergroup id (-100…). */
  groupId?: string;
}

const SNOWFLAKE = /^\d{5,25}$/;

/** A link to a message (a prompt's own buttons), or undefined when none can be built for this platform/place. */
export function messageLink(place: WorldPlace, at: { chatId: string; threadId?: string; messageId?: string }): string | undefined {
  if (!at.messageId) return undefined;
  if (place.type === "discord") {
    const channel = at.threadId ?? at.chatId;
    if (!place.groupId || !SNOWFLAKE.test(place.groupId) || !SNOWFLAKE.test(channel) || !SNOWFLAKE.test(at.messageId)) return undefined;
    return `https://discord.com/channels/${place.groupId}/${channel}/${at.messageId}`;
  }
  if (place.type === "telegram") {
    const internal = telegramInternalId(at.chatId);
    if (!internal || !/^\d+$/.test(at.messageId)) return undefined;
    const topic = at.threadId && at.threadId !== "1" && /^\d+$/.test(at.threadId) ? `${at.threadId}/` : "";
    return `https://t.me/c/${internal}/${topic}${at.messageId}`;
  }
  return undefined;
}

/** A way to the instance's own thread: Discord's channel mention (clickable in place), Telegram's topic link. */
export function instanceLink(place: WorldPlace, topicId: string | undefined): string | undefined {
  if (!topicId) return undefined;
  if (place.type === "discord") return SNOWFLAKE.test(topicId) ? `<#${topicId}>` : undefined;
  if (place.type === "telegram") {
    const internal = telegramInternalId(place.groupId ?? "");
    return internal && /^\d+$/.test(topicId) && topicId !== "1" ? `https://t.me/c/${internal}/${topicId}` : undefined;
  }
  return undefined;
}

/** t.me/c/ links take a supergroup's id without its -100 prefix; anything else has no such link. */
function telegramInternalId(chatId: string): string | undefined {
  const m = /^-100(\d+)$/.exec(chatId);
  return m ? m[1] : undefined;
}

// ── The live message's text (§5.1) ────────────────────────────────────────────────────────────────────────────

export interface LiveLine {
  item: NeedsYouItem;
  title: string;
  link?: string;
}

export const LIVE_MAX_LINES = 10;
export const LIVE_MAX_ACKS = 5;

/**
 * The live message for one world: header, at most LIVE_MAX_LINES lines (then "… and N more"), and which delivery
 * items get an Acknowledge button (the newest LIVE_MAX_ACKS of those shown). `t` localizes.
 */
export function renderLiveMessage(
  lines: readonly LiveLine[],
  nowMs: number,
  t: (key: string, ...args: Array<string | number>) => string,
): { text: string; ackable: NeedsYouItem[] } {
  if (lines.length === 0) return { text: t("needs.live_empty"), ackable: [] };
  const shown = lines.slice(0, LIVE_MAX_LINES);
  const body = shown.map(l => {
    const age = ageLabel(l.item.since, nowMs);
    const head = `• ${l.item.instance} — ${l.title} (${age})`;
    return l.link ? `${head} · ${l.link}` : head;
  });
  if (lines.length > shown.length) body.push(t("needs.live_more", lines.length - shown.length));
  const ackable = shown.filter(l => l.item.type === "delivery").map(l => l.item)
    .sort((a, b) => b.since - a.since).slice(0, LIVE_MAX_ACKS);
  return { text: [t("needs.live_header", lines.length), ...body].join("\n"), ackable };
}
