/**
 * #1630 (design: the comment on #1630): what stands for an instance in the web app — decided here, on the server,
 * once; the page only draws it. In order:
 *   0. the picture uploaded for it in View (its profile avatar);
 *   1. its own bot's avatar, when it has a bot of its own (a persona bot, or the primary when it serves it alone);
 *   2. (#1867) else the avatar of the bot it speaks through on Telegram/Discord — the General (primary) bot, or a bot it
 *      shares — so the web shows the face the chat shows; with no connection of its own (web-only), the primary's.
 *      A bot with no avatar set falls through at 1 and 2 (a default avatar says nothing);
 *   3. its persona emoji (`status_emojis.delivered`, what set_persona_emoji sets): unicode as text, a Discord server
 *      emoji through the emoji route (a Telegram custom emoji has no picture here and falls through);
 *   4. the first character of its display name, or of its name.
 * The accent ring (a Discord role colour) goes with an own bot's face only: a shared bot's would ring everyone alike.
 * Images are same-origin `/ui/img/…` URLs only; the version makes a changed picture a new URL.
 */
import { normalizeEmoji } from "./status-emojis.js";

export type AvatarDescriptor =
  | { kind: "image"; src: string }
  | { kind: "emoji"; text: string }
  | { kind: "emoji"; src: string; alt: string }
  | { kind: "initial"; text: string };

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** The first user-perceived character, upper-cased where that means anything ("é" → "É", "中" stays). */
export function firstCharacter(text: string): string {
  for (const { segment } of GRAPHEMES.segment(text.trim())) return segment.toLocaleUpperCase();
  return "?";
}

export function avatarFor(input: {
  name: string;
  displayName?: string | null;
  /** The profile picture's version, when one is uploaded (step 0). */
  profileVersion?: string | null;
  /** The bot's avatar (step 1 or 2): its connection id and cached version, when the avatar is on disk. */
  bot?: { connection: string; version: string } | null;
  /** The instance's own `status_emojis.delivered`, as configured. */
  personaEmoji?: unknown;
}): AvatarDescriptor {
  if (input.profileVersion) return { kind: "image", src: `/ui/img/avatar/${encodeURIComponent(input.name)}?v=${encodeURIComponent(input.profileVersion)}` };
  if (input.bot) return { kind: "image", src: `/ui/img/bot/${encodeURIComponent(input.bot.connection)}?v=${encodeURIComponent(input.bot.version)}` };
  const emoji = normalizeEmoji(input.personaEmoji);
  if (emoji?.kind === "unicode") return { kind: "emoji", text: emoji.value };
  if (emoji?.kind === "custom") return { kind: "emoji", src: `/ui/img/emoji/${emoji.id}`, alt: `:${emoji.name}:` };
  return { kind: "initial", text: firstCharacter(input.displayName || input.name) };
}

/**
 * The connections that are ONE instance's own bot: answering for exactly one instance or ClassicBot room. The primary
 * counts too when one instance is all it serves (a fleet that keeps it for General only — #1630 follow-up); shared by
 * more, it is nobody's own. `assignments` is every instance and room with the connection it uses.
 */
export function ownBotConnections(assignments: ReadonlyArray<readonly [instance: string, connection: string | undefined]>): Map<string, string> {
  const users = new Map<string, string[]>();
  for (const [instance, connection] of assignments) {
    if (!connection) continue;
    const list = users.get(connection);
    if (list) list.push(instance); else users.set(connection, [instance]);
  }
  const own = new Map<string, string>();          // instance → its own connection
  for (const [connection, instances] of users) if (instances.length === 1) own.set(instances[0]!, connection);
  return own;
}

/** A Discord role colour as the page may use it: `#rrggbb`, never black (Discord's "no colour"). */
export function accentColor(raw: unknown): string | null {
  return typeof raw === "string" && /^#[0-9a-f]{6}$/i.test(raw) && raw.toLowerCase() !== "#000000" ? raw.toLowerCase() : null;
}
