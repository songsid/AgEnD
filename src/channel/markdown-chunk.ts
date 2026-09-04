/**
 * Fence-aware text truncation and splitting for chat platforms.
 *
 * Both Discord and Telegram render markdown, so a naive `slice()` that lands
 * inside a ``` code block emits an *unclosed* fence. Discord swallows the rest
 * of the message into the code block; Telegram, on a `parse_mode: "Markdown"`
 * path, rejects the whole send with "can't parse entities" and the message is
 * dropped outright.
 *
 * The cross-instance previews, both Discord splitters and the Telegram queue go
 * through these helpers. Several lower-frequency `msg.edit` truncations in the
 * Discord adapter still slice directly and are tracked separately.
 *
 * Fences follow CommonMark closely enough for chat text: a fence opens on a run
 * of three or more backticks or tildes, and closes only on a run of the *same*
 * character, at least as long, carrying no info string. That is what makes a
 * ```js block nested inside a ````markdown block read as content rather than as
 * a close, and what stops a line like ```ts inside an open block from being
 * mistaken for a closer and inverting all the prose that follows it.
 */

interface Fence {
  char: "`" | "~";
  len: number;
  info: string;
}

const OPENER = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSER = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function fenceOpener(line: string): Fence | null {
  const m = OPENER.exec(line);
  if (!m) return null;
  const info = m[2].trim();
  // A backtick fence's info string may not itself contain a backtick.
  if (m[1][0] === "`" && info.includes("`")) return null;
  return { char: m[1][0] as "`" | "~", len: m[1].length, info };
}

function closesFence(line: string, open: Fence): boolean {
  const m = CLOSER.exec(line);
  return m != null && m[1][0] === open.char && m[1].length >= open.len;
}

/** The fence still open at the end of `text`, or null when balanced. */
function openFence(text: string): Fence | null {
  let open: Fence | null = null;
  for (const line of text.split("\n")) {
    if (open === null) {
      const f = fenceOpener(line);
      if (f) open = f;
    } else if (closesFence(line, open)) {
      open = null;
    }
  }
  return open;
}

function fenceMarker(f: Fence): string {
  return f.char.repeat(f.len);
}

/** True when `text` has an odd number of single backticks outside fenced blocks. */
function hasDanglingInlineCode(text: string): boolean {
  let open: Fence | null = null;
  let ticks = 0;
  for (const line of text.split("\n")) {
    if (open === null) {
      const f = fenceOpener(line);
      if (f) { open = f; continue; }
      ticks += (line.match(/`/g) ?? []).length;
    } else if (closesFence(line, open)) {
      open = null;
    }
  }
  return ticks % 2 === 1;
}

/** Index of the line that opened the fence still open at the end, or -1. */
function openerLineIndex(lines: string[]): number {
  let open: Fence | null = null;
  let at = -1;
  lines.forEach((line, i) => {
    if (open === null) {
      const f = fenceOpener(line);
      if (f) { open = f; at = i; }
    } else if (closesFence(line, open)) {
      open = null;
      at = -1;
    }
  });
  return at;
}

/** Close any markdown left dangling by a cut, marking the elision. */
function closeMarkup(cut: string): string {
  let out = cut;
  let suffix = "…";
  if (hasDanglingInlineCode(out)) suffix = `\`${suffix}`;

  const open = openFence(out);
  if (open !== null) {
    const lines = out.split("\n");
    const at = openerLineIndex(lines);
    // An opener with nothing under it would render as an empty code block; drop
    // the opener instead and let the ellipsis stand for the elided block.
    if (lines.slice(at + 1).join("").trim() === "") {
      const trimmed = lines.slice(0, at).join("\n");
      return trimmed === "" ? suffix : `${trimmed}\n${suffix}`;
    }
    // Keep the ellipsis inside the block, then close it.
    if (!out.endsWith("\n")) out += "\n";
    return `${out}${suffix}\n${fenceMarker(open)}`;
  }

  // Appending straight onto a fence line would turn the marker into an opener
  // carrying "…" as its info string.
  const lastLine = out.slice(out.lastIndexOf("\n") + 1);
  if (OPENER.test(lastLine)) return `${out}\n${suffix}`;
  return out + suffix;
}

/**
 * Shorten `text` to at most `limit` characters for a preview, leaving no
 * dangling markdown. A truncated code block is closed rather than stripped, so
 * the preview still shows what the code was — stripping would expose the code's
 * own `*` and `_` to the markdown renderer.
 *
 * The closing markers are charged against `limit`: the result never exceeds
 * what the caller budgeted, so this is safe to point at a hard platform cap and
 * not only at a cosmetic preview length.
 */
export function truncatePreview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // Shrinking the cut can change what markup is left open, so step back until
  // the assembled preview fits. The reservation is a handful of characters, so
  // this settles within a few iterations.
  for (let take = limit; take > 0; take--) {
    const out = closeMarkup(text.slice(0, take));
    if (out.length <= limit) return out;
  }
  // Budget too small to close anything. A bare slice would emit half a fence,
  // so say nothing rather than something unrenderable.
  return limit >= 1 ? "…" : "";
}

/** Legacy behaviour: fixed-width slices. Correct whenever no fence is involved. */
function hardSplit(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + limit));
    offset += limit;
  }
  return chunks;
}

/**
 * Split `text` into chunks of at most `limit` characters, keeping every chunk's
 * code fences balanced: a block cut across a boundary is closed at the end of
 * one chunk and reopened (with its original fence marker and info string) at
 * the start of the next. Those markers are charged against `limit`, so no chunk
 * can exceed the platform cap.
 *
 * Text with no fences — and limits too small to hold one — fall back to plain
 * fixed-width slicing, which is what callers relied on before.
 */
export function splitTextFenceAware(text: string, limit: number): string[] {
  if (text.length === 0) return [];
  if (text.length <= limit) return [text];

  // A fence needs its marker plus a newline plus at least one char of content.
  const minUsable = 5;
  if (limit <= minUsable || !/^ {0,3}(`{3,}|~{3,})/m.test(text)) return hardSplit(text, limit);

  const chunks: string[] = [];
  let rest = text;
  let carried: Fence | null = null;

  while (rest.length > 0) {
    const prefix = carried === null ? "" : `${fenceMarker(carried)}${carried.info}\n`;
    const closeCost = carried === null ? 0 : carried.len + 1;
    // Reserve room for the closing fence we may have to append.
    const budget = limit - prefix.length - Math.max(closeCost, 4);
    if (budget <= 0) {
      // Info string so long it leaves no room; degrade rather than loop forever.
      chunks.push(...hardSplit(prefix + rest, limit));
      break;
    }

    if (prefix.length + rest.length <= limit) {
      chunks.push(prefix + rest);
      break;
    }

    // Prefer a line boundary so we do not cut mid-line when we do not have to.
    let take = rest.lastIndexOf("\n", budget);
    if (take <= 0) take = budget;

    const piece = rest.slice(0, take);
    const body = prefix + piece;
    const open = openFence(body);
    chunks.push(open === null ? body : `${body.replace(/\n$/, "")}\n${fenceMarker(open)}`);
    carried = open;
    rest = rest.slice(take).replace(/^\n/, "");
  }

  return chunks;
}
