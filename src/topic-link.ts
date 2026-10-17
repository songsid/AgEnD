/**
 * #1990: links to another topic. One place builds "a link to instance X's place (or a world's General) on surface S"
 * from what the adapters already know — Discord guild/channel ids, the Telegram supergroup id, its public @username
 * when it has one, and topic ids — and messages name such a place through a token that each surface renders in its own
 * form, or as plain text when the reader could not open the target.
 *
 *   Discord   `<#channel>` (clickable in place); in a DM, `https://discord.com/channels/<guild>/<channel>`
 *   Telegram  `https://t.me/<username>/<topic>` (public group) or `https://t.me/c/<id without -100>/<topic>`, carried by
 *             a `text_link` entity on plain text — no parse mode, so nothing in the text needs escaping
 *   plain     the label alone (a suffix token disappears)
 *
 * The forms are the documented ones; no real client was driven (#1990: the user checks them on the 2.3 beta).
 */

export interface WorldPlace {
  type: "discord" | "telegram" | string;
  /** Discord: the guild id. Telegram: the supergroup id (-100…). */
  groupId?: string;
  /** Telegram: the group's public @username (without the @), when it has one — then links work for non-members too. */
  username?: string;
}

/** A world's place, for links: its platform, its group and (Telegram) the group's public @username once read. */
export function worldPlaceOf(world: { type: string; groupId: string; adapter?: { groupUsername?(groupId: string): string | undefined } }): WorldPlace {
  const username = world.groupId ? world.adapter?.groupUsername?.(world.groupId) : undefined;
  return { type: world.type, ...(world.groupId ? { groupId: world.groupId } : {}), ...(username ? { username } : {}) };
}

export const SNOWFLAKE = /^\d{5,25}$/;
/** A Telegram @username as the platform allows it: 4–32 of [A-Za-z0-9_], starting with a letter. */
const TELEGRAM_USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

/** t.me/c/ links take a supergroup's id without its -100 prefix; anything else has no such link. */
export function telegramInternalId(chatId: string): string | undefined {
  const m = /^-100(\d+)$/.exec(chatId);
  return m ? m[1] : undefined;
}

/** The t.me path prefix of a group: `<username>` for a public one, `c/<id>` for a private supergroup. */
function telegramGroupPath(place: WorldPlace, chatId = place.groupId ?? ""): string | undefined {
  if (place.username && TELEGRAM_USERNAME.test(place.username) && chatId === place.groupId) return place.username;
  const internal = telegramInternalId(chatId);
  return internal ? `c/${internal}` : undefined;
}

/** A link to a message (a prompt's own buttons), or undefined when none can be built for this platform/place. */
export function messageLink(place: WorldPlace, at: { chatId: string; threadId?: string; messageId?: string }): string | undefined {
  if (!at.messageId) return undefined;
  if (place.type === "discord") {
    const channel = at.threadId ?? at.chatId;
    if (!place.groupId || !SNOWFLAKE.test(place.groupId) || !SNOWFLAKE.test(channel) || !SNOWFLAKE.test(at.messageId)) return undefined;
    return `https://discord.com/channels/${place.groupId}/${channel}/${at.messageId}`;
  }
  if (place.type === "telegram") {
    const path = telegramGroupPath(place, at.chatId);
    if (!path || !/^\d+$/.test(at.messageId)) return undefined;
    const topic = at.threadId && at.threadId !== "1" && /^\d+$/.test(at.threadId) ? `${at.threadId}/` : "";
    return `https://t.me/${path}/${topic}${at.messageId}`;
  }
  return undefined;
}

/**
 * A browser URL to a topic or channel. Telegram's General topic (1) gets one only when `general` is set: an
 * instance's link never points at General.
 */
export function topicUrl(place: WorldPlace | undefined, topicId: string | undefined, opts: { general?: boolean } = {}): string | undefined {
  if (!place || !topicId) return undefined;
  if (place.type === "discord") {
    if (!place.groupId || !SNOWFLAKE.test(place.groupId) || !SNOWFLAKE.test(topicId)) return undefined;
    return `https://discord.com/channels/${place.groupId}/${topicId}`;
  }
  if (place.type === "telegram") {
    const path = telegramGroupPath(place);
    if (!path || !/^\d+$/.test(topicId) || (topicId === "1" && !opts.general)) return undefined;
    return `https://t.me/${path}/${topicId}`;
  }
  return undefined;
}

/** A way to the instance's own thread: Discord's channel mention (clickable in place), Telegram's topic link. */
export function instanceLink(place: WorldPlace, topicId: string | undefined): string | undefined {
  if (!topicId) return undefined;
  if (place.type === "discord") return SNOWFLAKE.test(topicId) ? `<#${topicId}>` : undefined;
  return topicUrl(place, topicId);
}

// ── Place tokens ──────────────────────────────────────────────────────────────────────────────────────────────

/** What a token points at: a world's General, or an instance's topic/room. */
export type PlaceTarget = { kind: "general" } | { kind: "instance"; name: string };

/** How a surface reaches a target: a Discord mention, or a URL. Undefined: the reader gets plain text. */
export type PlaceLink = { mention: string } | { url: string };

/** A Telegram `text_link` entity: UTF-16 offsets, which is what a JS string's indices are. */
export interface TextLink { offset: number; length: number; url: string }

export type PlaceSurface = "discord" | "telegram" | "plain";

// Private-use code points: no normal text carries them, and a stray one is never taken for a token.
const OPEN = "";
const MID = "";
const CLOSE = "";
const TOKEN = /([^-]*)([^-]*)/g;
const MARKERS = /[-]/g;

function encodeTarget(target: PlaceTarget): string {
  return target.kind === "general" ? "g" : `i:${encodeURIComponent(target.name)}`;
}

function decodeTarget(payload: string): PlaceTarget | undefined {
  if (payload === "g") return { kind: "general" };
  if (!payload.startsWith("i:")) return undefined;
  try {
    const name = decodeURIComponent(payload.slice(2));
    return name ? { kind: "instance", name } : undefined;
  } catch { return undefined; }
}

/** Name a place in a message: rendered as `label` linked to the target, or as `label` alone. */
export function placeRef(target: PlaceTarget, label: string): string {
  return `${OPEN}${encodeTarget(target)}${MID}${label.replace(MARKERS, "")}${CLOSE}`;
}

/**
 * A link appended to a message (" → General"): the message's own words stay as they are, and when the place cannot
 * be linked the suffix disappears with its leading space.
 */
export function placeSuffix(target: PlaceTarget, label: string): string {
  return ` ${OPEN}s|${encodeTarget(target)}${MID}${label.replace(MARKERS, "")}${CLOSE}`;
}

export function hasPlaceRefs(text: string): boolean {
  return text.includes(OPEN);
}

/**
 * Render every token for one surface. `resolve` says how this reader reaches a target (undefined: plain text). The
 * text outside tokens is copied unchanged; `textLinks` is non-empty only on Telegram.
 */
export function renderPlaceRefs(
  text: string,
  surface: PlaceSurface,
  resolve: (target: PlaceTarget) => PlaceLink | undefined,
): { text: string; textLinks: TextLink[] } {
  if (!hasPlaceRefs(text)) return { text, textLinks: [] };
  const textLinks: TextLink[] = [];
  let out = "";
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    let before = text.slice(last, m.index);
    last = m.index + m[0].length;
    const suffix = m[1].startsWith("s|");
    const target = decodeTarget(suffix ? m[1].slice(2) : m[1]);
    const label = m[2];
    const link = target && label && surface !== "plain" ? resolve(target) : undefined;
    if (!link) {
      // A suffix is all link: without one it goes, with the space placeSuffix put before it.
      if (suffix) before = before.endsWith(" ") ? before.slice(0, -1) : before;
      out += before + (suffix ? "" : label);
      continue;
    }
    out += before;
    const arrow = suffix ? "→ " : "";
    if (surface === "discord") {
      // A mention is clickable in place; a URL (a DM) in angle brackets so Discord adds no embed.
      const ref = "mention" in link ? link.mention : `<${link.url}>`;
      out += suffix ? `${arrow}${ref}` : `${label} (${ref})`;
    } else if ("url" in link) {
      out += arrow;
      textLinks.push({ offset: out.length, length: label.length, url: link.url });
      out += label;
    } else {
      out += arrow + label;
    }
  }
  out += text.slice(last);
  return { text: out, textLinks };
}

/** Every token as its label, suffixes gone: what a surface that renders no links shows. */
export function stripPlaceRefs(text: string): string {
  return renderPlaceRefs(text, "plain", () => undefined).text;
}

/** Text links that lie wholly inside [start, end), re-based to start; one that crosses the boundary is dropped. */
export function textLinksWithin(links: readonly TextLink[], start: number, end: number): TextLink[] {
  return links.filter(l => l.offset >= start && l.offset + l.length <= end).map(l => ({ ...l, offset: l.offset - start }));
}

// ── Group membership, for a DM that would link into the group ─────────────────────────────────────────────────

export interface MembershipSource {
  isGroupMember?(groupId: string, userId: string): Promise<boolean>;
}

/**
 * Whether a DM recipient may get links into a group: only a confirmed member (#1990 — never link to what the reader
 * cannot open). One read per (group, user) per `ttlMs`, bounded by `deadlineMs`; a non-member, an error, a timeout or
 * an adapter that cannot tell all mean "no" (plain text). Answers are cached, failures included, so a refusing
 * platform is asked again only after the TTL; concurrent asks share one read.
 */
export class GroupMembership {
  private readonly answers = new Map<string, { member: boolean; at: number }>();
  private readonly reads = new Map<string, Promise<boolean>>();

  constructor(private readonly opts: { now: () => number; ttlMs?: number; deadlineMs?: number; maxEntries?: number } = { now: () => performance.now() }) {}

  async isMember(source: MembershipSource, groupId: string, userId: string): Promise<boolean> {
    if (!source.isGroupMember || !groupId || !userId) return false;
    const key = `${groupId}\u0000${userId}`;
    const ttl = this.opts.ttlMs ?? 10 * 60_000;
    const cached = this.answers.get(key);
    if (cached && this.opts.now() - cached.at < ttl) return cached.member;
    const pending = this.reads.get(key);
    if (pending) return pending;
    const read = this.read(source, groupId, userId).then(member => {
      this.answers.delete(key);   // re-insert: the map's order is its age, for the bound below
      this.answers.set(key, { member, at: this.opts.now() });
      const max = this.opts.maxEntries ?? 1000;
      while (this.answers.size > max) this.answers.delete(this.answers.keys().next().value as string);
      return member;
    }).finally(() => this.reads.delete(key));
    this.reads.set(key, read);
    return read;
  }

  private read(source: MembershipSource, groupId: string, userId: string): Promise<boolean> {
    const deadlineMs = this.opts.deadlineMs ?? 5_000;
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), deadlineMs);
      (timer as { unref?: () => void }).unref?.();
      let asked: Promise<boolean>;
      try { asked = source.isGroupMember!(groupId, userId); } catch { asked = Promise.resolve(false); }
      asked.then(member => { clearTimeout(timer); resolve(member === true); }, () => { clearTimeout(timer); resolve(false); });
    });
  }
}
