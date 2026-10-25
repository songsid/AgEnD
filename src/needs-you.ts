/**
 * #1386 "Needs you": one list of everything currently waiting on the person, derived — on demand, never stored —
 * from state the fleet already holds. Design: docs/design/1386-needs-you-inbox.md (§3 sources, §4 derivation).
 *
 * This module is pure: the fleet collects the inputs, this decides the items, which world owns each, what the
 * rendered list is (its signature), and the live chat message's text and links. Nothing here touches a socket,
 * a file or a clock of its own.
 */

export type NeedsYouType = "prompt" | "awaiting_input" | "instance" | "delivery" | "task" | "backend";

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
  /** auth_paused (#2233): the login the dashboard can sign in for it (its backend, and its credential profile). */
  signIn?: { backend: string; profile?: string };
  /**
   * task (#2246 step 3): the board card that waits — its number and the version the person sees; its title, its
   * question (blocked) and what it lacks (to confirm), for a page to say in its own language.
   */
  card?: { code: string; version: number; title?: string; question?: string; gap?: { unchecked: number; noResult: boolean } };
  /**
   * task (#2352): the instance whose own channel lists the card — the instance that handed it out, else its project's
   * lead. Its world owns the item; absent: the item sits in its assignee's world's General, as every other item.
   */
  lane?: string;
}

export type NeedsYouReason =
  | "hang" | "exited" | "assist"                                    // prompt
  | "permission" | "dangerous_command" | "login" | "dialog" | "terminal_input"   // awaiting_input
  | "auth_paused" | "crashed"                                       // instance
  | "delivery_uncertain" | "delivery_failed"                        // delivery
  | "task_review" | "task_blocked" | "backend_signin";                                 // task

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
  /** Paused for sign-in: the login the dashboard can sign in for it, or null (#2233). */
  signIn?: { backend: string; profile?: string } | null;
}

export interface DeliveryInput {
  deliveryId: string;
  state: "uncertain" | "failed";
  source: string;
  target: string;
  kind: string;
  finishedAt: number;
}

/** A task board card waiting for the person (#2246 step 3): to confirm, or blocked on a question. */
export interface TaskInput {
  uuid: string;
  code: string;
  title: string;
  status: "review" | "blocked";
  version: number;
  /** Its assignee: the instance the item sits under, whose chat world lists it. */
  assignee: string | null;
  /** The question, for a blocked card; what it still lacks, for one to confirm ("" when wrapped up) — in the fleet's words. */
  note: string;
  /** What it lacks, as numbers (a card to confirm that is not wrapped up). */
  gap?: { unchecked: number; noResult: boolean };
  /**
   * #2352: the channel that lists it — the dispatcher instance, else the project's lead — already checked by the fleet
   * to be usable (an instance of a live world with a channel of its own); absent: its assignee's world's General.
   */
  lane?: string;
  /** Epoch ms since it has waited (its move to review or to blocked). */
  since: number;
}

export interface BackendSignInInput { backend: string; since: number; browser: boolean }

export interface NeedsYouInputs {
  prompts: PromptInput[];
  instances: InstanceInput[];
  deliveries: DeliveryInput[];
  tasks?: TaskInput[];
  backendSignIns?: BackendSignInInput[];
  /** The live world that owns an instance, or undefined (no channel, or its world is gone). */
  ownerOf: (instance: string) => string | undefined;
}

const PROMPT_REASON: Record<string, NeedsYouReason> = {
  "hang:": "hang",
  "exit-restart:": "exited",
  "oom-retry:": "exited",
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
      items.push({ id: `auth:${inst.name}:${inst.pausedAt ?? 0}`, type: "instance", instance: inst.name, reason: "auth_paused", detail: "", since: inst.pausedAt ?? 0,
        ...(inst.signIn ? { signIn: { backend: inst.signIn.backend, ...(inst.signIn.profile ? { profile: inst.signIn.profile } : {}) } } : {}) });
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

  // Installer-selected backends are fleet-level web items, including when no agent uses them.
  for (const b of inputs.backendSignIns ?? []) items.push({
    id: `backend-signin:${b.backend}:${b.since}`, type: "backend", instance: "", reason: "backend_signin", detail: b.backend, since: b.since,
    ...(b.browser ? { signIn: { backend: b.backend } } : {}),
  });

  // Task board cards waiting for the person (#2246 step 3), under their assignee.
  for (const c of inputs.tasks ?? []) {
    items.push({
      id: `task:${c.uuid}:${c.status}:${c.since}`, type: "task", instance: c.assignee ?? "",
      reason: c.status === "review" ? "task_review" : "task_blocked",
      detail: oneLine(`${c.code} ${c.title}${c.note ? ` — ${c.note}` : ""}`), since: c.since,
      card: { code: c.code, version: c.version, title: c.title, ...(c.status === "blocked" && c.note ? { question: c.note } : {}), ...(c.gap ? { gap: c.gap } : {}) },
      ...(c.lane ? { lane: c.lane } : {}),
    });
  }

  for (const item of items) {
    // #2352: a laned card belongs to its lane's world (the admins where its buttons are); the rest to their instance's.
    const home = item.lane ?? item.instance;
    if (!home) continue;                                            // a card nobody is assigned: the web's only
    const owner = inputs.ownerOf(home);
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

/**
 * #2352: one live message's items — a world's General (`lane` null: everything of the world without a lane) or one
 * lane's channel (that lane's cards only).
 */
export function itemsForLane(items: readonly NeedsYouItem[], world: string, lane: string | null): NeedsYouItem[] {
  return items.filter(item => item.owner === world && (item.lane ?? null) === lane);
}

/** #2352: the lanes a world's items name now. */
export function lanesOf(items: readonly NeedsYouItem[], world: string): string[] {
  return [...new Set(items.filter(item => item.owner === world && item.lane).map(item => item.lane!))].sort();
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
    // A card's buttons carry the version it was shown at: a newer card renders (and mints) again.
    i.card ? i.card.version : null,
    i.lane ?? null,
  ]));
}

// ── Chat links (§5.1) ─────────────────────────────────────────────────────────────────────────────────────────
// #1990: built in topic-link.ts, the one place every "go to that topic" link comes from.

export { instanceLink, messageLink, type WorldPlace } from "./topic-link.js";

// ── The live message's text (§5.1) ────────────────────────────────────────────────────────────────────────────

export interface LiveLine {
  item: NeedsYouItem;
  title: string;
  link?: string;
}

export const LIVE_MAX_LINES = 10;
export const LIVE_MAX_ACKS = 5;
/** Task cards that get buttons on one render (Confirm and Send back, or Answer): the oldest shown. */
export const LIVE_MAX_TASKS = 3;

/**
 * The live message for one world: header, at most LIVE_MAX_LINES lines (then "… and N more"), and which delivery
 * items get an Acknowledge button (the newest LIVE_MAX_ACKS of those shown). `t` localizes.
 */
export function renderLiveMessage(
  lines: readonly LiveLine[],
  nowMs: number,
  t: (key: string, ...args: Array<string | number>) => string,
  /** #2352: a lane's message says it lists what waits here (`needs.live_header_lane`). */
  header = "needs.live_header",
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
  const tasks = shown.filter(l => l.item.type === "task" && l.item.card).map(l => l.item).slice(0, LIVE_MAX_TASKS);
  return { text: [t(header, lines.length), ...body].join("\n"), ackable: [...ackable, ...tasks] };
}
