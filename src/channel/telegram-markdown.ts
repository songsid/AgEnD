/**
 * Markdown → Telegram HTML (parse_mode "HTML") for text an agent wrote as markdown.
 *
 * Escape first, by construction: every character of the input is escaped (`&`, `<`, `>`) before any tag is added, and
 * the only tags in the output are the ones this file writes — so `a<b`, `&` or a literal `<b>` in the input are shown
 * as text, never parsed. A fixed set of inline forms becomes tags: `code`, **bold**, ~~strike~~, *italic* / _italic_
 * and [text](http(s) URL). Each tag pair wraps text that contains no tag yet (code spans, fences and link targets are
 * cut out before emphasis runs; emphasis content excludes `<` `>`), so the output is always well-formed. A fence or
 * any other run of two or more backticks keeps its text exactly — escaped, backticks and all, never formatted.
 * Tables and headings stay as their literal characters.
 *
 * Linear time: the text can be as long as a tool argument allows (far beyond Telegram's 4096), and this runs on the
 * fleet's event loop before any API call. One left-to-right pass; each scan stops at the next character that could
 * start another token, and the emphasis patterns stop at their own next delimiter.
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

/** `(http(s)://target)` right after a link's `]`; the target stops at whitespace, parentheses, quotes and < >. */
const LINK_TARGET = /\((https?:\/\/[^\s()<>"]+)\)/y;

/** Every maximal run of 2+ backticks, by length — so finding a fence's closing run never rescans the text. */
function backtickRuns(text: string): Map<number, number[]> {
  const runs = new Map<number, number[]>();
  for (let i = text.indexOf("`"); i >= 0; i = text.indexOf("`", i)) {
    let n = 1;
    while (text[i + n] === "`") n++;
    if (n >= 2) (runs.get(n) ?? runs.set(n, []).get(n)!).push(i);
    i += n;
  }
  return runs;
}

export function markdownToTelegramHtml(text: string): string {
  const runs = backtickRuns(text);
  const cursor = new Map<number, number>();
  /** The first run of exactly `n` backticks starting at or after `from` (callers ask with a rising `from`). */
  const nextRun = (n: number, from: number): number => {
    const list = runs.get(n) ?? [];
    let k = cursor.get(n) ?? 0;
    while (k < list.length && list[k]! < from) k++;
    cursor.set(n, k);
    return k < list.length ? list[k]! : -1;
  };
  let out = "", from = 0, i = 0;
  const token = (start: number, end: number, html: string) => {
    if (start > from) out += emphasis(escapeHtml(text.slice(from, start)));
    out += html;
    from = i = end;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "`") {
      let n = 1;
      while (text[i + n] === "`") n++;
      if (n >= 2) {
        // A fence or a multi-backtick span: literal through its closing run of the same length (or just the run).
        const close = nextRun(n, i + n);
        const end = close < 0 ? i + n : close + n;
        token(i, end, escapeHtml(text.slice(i, end)));
        continue;
      }
      const j = text.indexOf("`", i + 1);
      if (j > i + 1 && text[j + 1] !== "`" && !text.slice(i + 1, j).includes("\n")) {
        token(i, j + 1, `<code>${escapeHtml(text.slice(i + 1, j))}</code>`);
        continue;
      }
    } else if (c === "[") {
      let k = i + 1;
      while (k < text.length && text[k] !== "]" && text[k] !== "[" && text[k] !== "\n") k++;
      if (text[k] === "]" && k > i + 1) {
        LINK_TARGET.lastIndex = k + 1;
        const m = LINK_TARGET.exec(text);
        if (m) {
          token(i, k + 1 + m[0].length, `<a href="${escapeHtml(m[1]!)}">${emphasis(escapeHtml(text.slice(i + 1, k)))}</a>`);
          continue;
        }
      }
    }
    i++;
  }
  return out + emphasis(escapeHtml(text.slice(from)));
}

/**
 * Telegram refused the text's markup itself ("Bad Request: can't parse entities: …"): a definite 400 before anything
 * changed, so sending the same text again without a parse mode is safe and cannot double-apply.
 */
export function isTelegramParseRefusal(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 400 && /can't parse entities/i.test(err.description);
}
