/** Pure consumed/absorbed/queued and raw-paste proof grammar shared by local and native readers. */
import { normalizeTurnText } from "./transcript-turns.js";
const ENTER_MARKER = (deliveryId: string) => `[agend-delivery-id:${deliveryId}]`;
function userTextsFromEntry(entry: unknown, backend: string): string[] {
  if (!entry || typeof entry !== "object") return [];
  const value = entry as Record<string, any>;
  if (backend === "claude-code") {
    const message = value.message;
    if (value.type !== "user" || message?.role !== "user") return [];
    const content = message.content;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.filter((item: any) => item?.type === "text" && typeof item.text === "string")
      .map((item: any) => item.text as string);
  }
  if (backend === "codex") {
    const payload = value.payload;
    if (value.type !== "response_item" || payload?.type !== "message" || payload?.role !== "user") return [];
    if (!Array.isArray(payload.content)) return [];
    return payload.content.filter((item: any) => item?.type === "input_text" && typeof item.text === "string")
      .map((item: any) => item.text as string);
  }
  return [];
}

/**
 * Claude Code persists a pasted message wrapped in `\n\n<pasted_content id="<hex>">\n` — every paste, small or large
 * (seen on all 640 delivery entries of 2.1.284–2.1.289, none of which begins with the marker itself). The wrapper is the
 * CLI's own, in a fixed shape, so it is the one thing allowed in front of the marker; anything else in front still
 * disqualifies the entry.
 */
const CLAUDE_PASTE_WRAPPER = /^\s*<pasted_content id="[0-9a-f]+">\r?\n/;

/** A unique marker counts only at the start of a persisted body (after the CLI's own paste wrapper, if it adds one). */
function leadsWithMarker(text: string, backend: string, marker: string): boolean {
  if (text.startsWith(marker)) return true;
  if (backend !== "claude-code") return false;
  const wrapper = CLAUDE_PASTE_WRAPPER.exec(text);
  return !!wrapper && text.startsWith(marker, wrapper[0].length);
}

/**
 * Where a delivery's marker turned up in a transcript delta:
 * - `user` — the CLI consumed it as a user message of its own (the strongest signal);
 * - `absorbed` — consumed INTO a running turn at a tool boundary (#1201). Claude Code 2.1.293 writes no user entry for
 *   that: a `queue-operation` remove with `reason: "absorbed_mid_turn"` and an `attachment` of type `queued_command`
 *   whose `prompt` is the message (tests/fixtures/claude-2.1.293-steer-consumed-mid-turn.transcript.jsonl);
 * - `queued` — Claude Code's queue-operation enqueue: accepted into its input queue, not consumed yet.
 * Consumed means `user` or `absorbed`.
 */
export type TranscriptMarkerKind = "user" | "absorbed" | "queued";

/** Whether a marker kind means the CLI took the message (as its own turn, or into the running one). */
export function markerConsumed(kind: TranscriptMarkerKind | null | undefined): kind is "user" | "absorbed" {
  return kind === "user" || kind === "absorbed";
}

/** Claude Code's record of a queued message absorbed into the running turn: the message's own text, or null. */
function claudeAbsorbedText(value: Record<string, any>): string | null {
  if (value.type === "attachment" && value.attachment?.type === "queued_command" && typeof value.attachment.prompt === "string") {
    return value.attachment.prompt;
  }
  if (value.type === "queue-operation" && value.operation === "remove" && value.reason === "absorbed_mid_turn"
    && typeof value.content === "string") return value.content;
  return null;
}

export function transcriptDeltaDeliveryMarker(rawDelta: string, backend: string, deliveryId: string): TranscriptMarkerKind | null {
  return transcriptDeltaMarkerKind(rawDelta, backend, ENTER_MARKER(deliveryId));
}

/**
 * #3030: the same reading for any unique leading marker — a delivery's `[agend-delivery-id:…]` or a person's
 * `[agend-human-id:…]` (both lead the pasted body).
 */
export function transcriptDeltaMarkerKind(rawDelta: string, backend: string, marker: string): TranscriptMarkerKind | null {
  let queued = false;
  let absorbed = false;
  for (const line of rawDelta.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as unknown;
      const firstUserText = userTextsFromEntry(entry, backend)[0];
      if (firstUserText !== undefined && leadsWithMarker(firstUserText, backend, marker)) return "user";
      const value = entry as Record<string, any> | null;
      if (backend !== "claude-code" || !value || typeof value !== "object") continue;
      const absorbedText = claudeAbsorbedText(value);
      if (absorbedText !== null && leadsWithMarker(absorbedText, backend, marker)) absorbed = true;
      if (value.type === "queue-operation" && value.operation === "enqueue"
        && typeof value.content === "string" && leadsWithMarker(value.content, backend, marker)) queued = true;
    } catch { /* incomplete/malformed JSONL is not proof */ }
  }
  return absorbed ? "absorbed" : queued ? "queued" : null;
}

/** Claude Code's closing tag after a persisted paste: `</pasted_content id="<hex>">` (seen on 2.1.29x transcripts). */
const CLAUDE_PASTE_WRAPPER_END = /\r?\n?<\/pasted_content id="[0-9a-f]+">\s*$/;

/**
 * #1663 P1-1: the user message's ORIGINAL body when it is one piece of text and nothing else — Claude Code's string
 * content, or a content list of exactly one text block; Codex's content of exactly one input_text. Anything else (a
 * second block of any kind: more text, an image, a file) is not a plain text message, so it is no raw paste's own
 * entry: null. (userTextsFromEntry, which the marker match shares, keeps only the text blocks — not this question.)
 */
function soleUserText(entry: unknown, backend: string): string | null {
  if (!entry || typeof entry !== "object") return null;
  const value = entry as Record<string, any>;
  const sole = (content: unknown, type: string): string | null =>
    Array.isArray(content) && content.length === 1 && content[0]?.type === type && typeof content[0].text === "string" ? content[0].text : null;
  if (backend === "claude-code") {
    const message = value.message;
    if (value.type !== "user" || message?.role !== "user") return null;
    return typeof message.content === "string" ? message.content : sole(message.content, "text");
  }
  if (backend === "codex") {
    const payload = value.payload;
    if (value.type !== "response_item" || payload?.type !== "message" || payload?.role !== "user") return null;
    return sole(payload.content, "input_text");
  }
  return null;
}

/** A persisted user body without the CLI's own paste wrapper (claude-code wraps a long paste in both tags). */
function withoutPasteWrapper(text: string, backend: string): string {
  if (backend !== "claude-code") return text;
  const open = CLAUDE_PASTE_WRAPPER.exec(text);
  return open ? text.slice(open[0].length).replace(CLAUDE_PASTE_WRAPPER_END, "") : text;
}

/**
 * What a transcript proof looks for: an enveloped delivery's id marker (a delivery id string), or — for a raw paste,
 * which carries no envelope (a silent schedule, a system command) — its exact text (#1647).
 */
export type TranscriptNeedle = string | { readonly rawText: string } | { readonly marker: string };

/**
 * #1647: a raw paste's exact text as a user entry of the CLI's own — a message that, whitespace aside and without Claude
 * Code's paste wrapper, IS the pasted text — is the record of the turn that took the paste. The delta starts at the
 * checkpoint taken before the write, so an earlier copy of the same words (a schedule repeats them every run) is never
 * in it. A quote of the text inside a longer message, a tool result or a queued entry is not. Raw text is not unique
 * the way a delivery marker is: the caller must hold a transcript that belongs to the target alone (#1663 P1-2).
 */
export function transcriptDeltaHasRawText(rawDelta: string, backend: string, rawText: string): boolean {
  const wanted = normalizeTurnText(rawText);
  if (!wanted) return false;
  for (const line of rawDelta.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      // The WHOLE user message must be the paste: its original body is one text and nothing else (#1663 P1-1).
      const body = soleUserText(JSON.parse(line) as unknown, backend);
      if (body !== null && normalizeTurnText(withoutPasteWrapper(body, backend)) === wanted) return true;
    } catch { /* incomplete/malformed JSONL is not proof */ }
  }
  return false;
}

/** One needle against one delta: the marker's kind, `user` for a raw paste's own entry, or null. */
export function transcriptDeltaNeedle(rawDelta: string, backend: string, needle: TranscriptNeedle): TranscriptMarkerKind | null {
  if (typeof needle === "string") return transcriptDeltaDeliveryMarker(rawDelta, backend, needle);
  if ("marker" in needle) return transcriptDeltaMarkerKind(rawDelta, backend, needle.marker);
  return transcriptDeltaHasRawText(rawDelta, backend, needle.rawText) ? "user" : null;
}

/**
 * Whether the CLI consumed the delivery: its unique marker at the start of a persisted user-message body, or of the
 * message Claude Code absorbed into a running turn (#1201).
 */
export function transcriptDeltaHasDeliveryMarker(rawDelta: string, backend: string, deliveryId: string): boolean {
  return markerConsumed(transcriptDeltaDeliveryMarker(rawDelta, backend, deliveryId));
}
