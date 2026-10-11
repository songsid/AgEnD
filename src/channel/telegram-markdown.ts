/**
 * Markdown → Telegram HTML (parse_mode "HTML") for text an agent wrote as markdown.
 *
 * Escape first, by construction: every character of the input is escaped (`&`, `<`, `>`) before any tag is added, and
 * the only tags in the output are the ones this file writes — so `a<b`, `&` or a literal `<b>` in the input are shown
 * as text, never parsed. A fixed set of inline forms becomes tags: `code`, **bold**, ~~strike~~, *italic* / _italic_
 * and [text](http(s) URL). Each tag pair wraps text that contains no tag yet (code and link targets are cut out
 * before emphasis runs; emphasis content excludes `<` `>`), so the output is always well-formed. Anything else —
 * tables, fenced code, headings — stays as its literal characters.
 */
import { GrammyError } from "grammy";

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Emphasis on already-escaped text. Bold first; strike and italic never span a tag (their content excludes < >). */
function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>")
    .replace(/~~([^~\n<>]+?)~~/g, "<s>$1</s>")
    .replace(/(^|[^\w*])\*([^*\s<>](?:[^*\n<>]*?[^*\s<>])?)\*(?![\w*])/g, "$1<i>$2</i>")
    // `_` only at word edges, so snake_case stays as it is.
    .replace(/(^|[^\w])_([^_\s<>](?:[^_\n<>]*?[^_\s<>])?)_(?!\w)/g, "$1<i>$2</i>");
}

/** Inline code and links are cut out first: nothing inside a code span or a link target is formatted. */
const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s()<>"]+)\)/g;

export function markdownToTelegramHtml(text: string): string {
  let out = "", last = 0;
  for (const m of text.matchAll(INLINE)) {
    out += emphasis(escapeHtml(text.slice(last, m.index)));
    out += m[1] !== undefined
      ? `<code>${escapeHtml(m[1])}</code>`
      : `<a href="${escapeHtml(m[3]!)}">${emphasis(escapeHtml(m[2]!))}</a>`;
    last = m.index! + m[0].length;
  }
  return out + emphasis(escapeHtml(text.slice(last)));
}

/**
 * Telegram refused the text's markup itself ("Bad Request: can't parse entities: …"): a definite 400 before anything
 * changed, so sending the same text again without a parse mode is safe and cannot double-apply.
 */
export function isTelegramParseRefusal(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 400 && /can't parse entities/i.test(err.description);
}
