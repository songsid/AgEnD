// Completing a word after a trigger character — one function for the page's two lists.
//   `@` in Fleet › Tasks' comment box (fleet-task-activity.js) offers the fleet's instance names, `#` in an instance's web chat
//   (chat-task-refs.js) offers the board's cards. Both are the same three things: the trigger character being typed, the word
//   typed after it up to the caret, and the replacement of that word once one is chosen. They differ only in what a word is
//   made of, where the trigger may stand and whether code is skipped — a rule per trigger (TRIGGERS below), so a third
//   trigger is one more row, not another copy. Pure: no DOM, no state; the callers keep the list, the keys and the caret.

/**
 * What each trigger reads, each rule the board's / the renderer's own:
 *   word       the characters the typed word is made of;
 *   max        how many of them are read back from the caret (a longer run is not a word being typed);
 *   notBefore  what may not stand right before the trigger (an address, a path, a word: `me@host`, `a/@x`, `page#top`);
 *   inCode     false: the trigger inside inline code or a fenced block is no trigger (the board does not read it there);
 *   command    true: a line that starts with "/" is a command, not a message — offered nothing.
 */
const TRIGGERS = {
  // An instance's name may be CJK, so letters of any script; the board's rule (task-board-mentions.ts, NOT_BEFORE) is ASCII only,
  // so a letter of another script before the `@` ("請@lead") is fine there and here.
  "@": { word: /[\p{L}\p{N}_.\-]/u, max: Infinity, notBefore: /[A-Za-z0-9_.@/\\-]/, inCode: false, command: false },
  // No space, no second `#`: a card number or a word of a title. What may not come before it is the renderer's and the server's
  // rule (src/chat-task-refs.ts).
  "#": { word: /[^\s#]/u, max: 60, notBefore: /[A-Za-z0-9_/&#@-]/, inCode: true, command: true },
};

/**
 * The text with fenced blocks and inline code blanked, as the board reads a comment (task-board-mentions.ts, withoutCode):
 * an `@name` in code names an instance without waking it. A fence not closed runs to the end of the text; inline code
 * is between two backticks on one line.
 */
export function withoutCode(text) {
  const blank = (s) => s.replace(/[^\n]/g, " ");
  return String(text).replace(/```[\s\S]*?(?:```|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}

/**
 * The `trigger` word being typed at the caret, or null: the trigger character must start the text or follow something not in
 * the trigger's `notBefore` (and, for a trigger that skips code, not be in inline code or a fenced block), then the word's
 * characters up to the caret. Null wherever the thing that reads the text would not read the word, so a list is never offered
 * for a word that would do nothing. { start: where the trigger is, query: the characters after it }.
 */
export function triggerAt(text, caret, trigger) {
  const rule = Object.prototype.hasOwnProperty.call(TRIGGERS, trigger) ? TRIGGERS[trigger] : null;
  if (!rule) return null;
  const s = String(text);
  if (rule.command && /^\s*\//.test(s)) return null;
  const end = Math.min(Math.max(0, caret), s.length);
  let i = end;
  while (i > 0 && rule.word.test(s[i - 1]) && end - i <= rule.max) i--;
  if (i === 0 || s[i - 1] !== trigger) return null;
  const start = i - 1;
  const read = rule.inCode ? s : withoutCode(s);
  if (read[start] !== trigger) return null;
  if (start > 0 && rule.notBefore.test(read[start - 1])) return null;
  return { start, query: s.slice(i, end) };
}

/**
 * The text with the `trigger` word at `at` (what triggerAt returned) replaced by `<trigger><word> ` — one space after, unless one
 * is already there or a line break follows — and where the caret goes. `names`: every word the list can offer, when the thing
 * that reads the text reads the longest that fits: if the text after the caret would run the word on into a longer one
 * (`@a` before " b", with an instance `a b` too), a space of its own is put in, so the word typed is the word read.
 */
export function insertAtTrigger(text, at, caret, trigger, word, names = []) {
  const s = String(text);
  const after = s.slice(Math.max(caret, at.start));
  const lower = word.toLowerCase(), tail = after.toLowerCase();
  const runsOn = names.some((n) => n.length > word.length && n.toLowerCase().startsWith(lower) && tail.startsWith(n.toLowerCase().slice(word.length)));
  const spaced = after.startsWith(" ") && !runsOn;
  const head = `${s.slice(0, at.start)}${trigger}${word}${after.startsWith("\n") || spaced ? "" : " "}`;
  return { text: head + after, caret: head.length + (spaced ? 1 : 0) };
}
