// Task cards in the web chat. The person types `#` in the chat box, picks a card, and the box holds its number
// (`#M-3`; M- is a main task, S- a sub task). A hand-typed `#M-3` / `#s3` counts the same; a bare `M-3` does not.
// Nothing about a reference is stored with the message — the text is the message — so an older chat, and an older AgEnD, read
// it as the text it is. This file is the page's side:
//   - taskRefAt / insertTaskRef: the `#query` being typed at the caret, and the number put in its place (pure; the shared
//     trigger-complete.js with "#");
//   - createTaskRefIndex: what the page knows of the cards its messages name (GET /ui/tasks/refs, only the numbers asked,
//     each once per page and again after the board changed), and the cards offered while `#` is typed. Until a card's answer
//     arrives (or if the number is no card) the message shows the number as text; when it arrives the messages are drawn again.
// The chip itself is drawn by the shared renderer (shared/chat-render.js), which asks `taskRefs(code)`.
//
// The `@` completion of Fleet › Tasks' comment box (fleet-task-activity.js) is the same function, trigger-complete.js, with "@".

import { insertAtTrigger, triggerAt } from "./trigger-complete.js";

/** The same rule as the renderer's and the server's (src/chat-task-refs.ts): a test holds the three to one list of cases. */
const REF = /(?<![A-Za-z0-9_/&#@-])#([MmSs])-?(\d{1,9})(?![A-Za-z0-9_-]|\.\d)/g;
const MAX_CODES = 50;
/** A card number as the board writes it: "#s3" / "m 3" → "S-3"; null when it is not one. */
export function taskRefCode(raw) {
  const m = /^\s*#?\s*([MmSs])\s*-?\s*(\d{1,9})\s*$/.exec(String(raw));
  return m ? `${m[1].toUpperCase()}-${Number(m[2])}` : null;
}

/** The card numbers a text names, normalised, each once, in order. */
export function taskRefCodes(text, max = 10) {
  const out = [];
  if (typeof text !== "string" || !text) return out;
  for (const m of text.matchAll(REF)) {
    const code = taskRefCode(`${m[1]}-${m[2]}`);
    if (code && !out.includes(code)) out.push(code);
    if (out.length >= max) break;
  }
  return out;
}

// ── Typing a `#` ──────────────────────────────────────────

// The `#query` at the caret and the number put in its place are the shared trigger-complete.js's, with the trigger "#"
//: a "#" that starts the text or
// follows a space, a bracket or a full-width punctuation mark (not a word, a path or a URL: "page#top", "a/b#c") — the renderer's
// and the server's rule for what comes before a `#` — then what was typed after it up to the caret; a line that starts
// with "/" is a command, not a message.

/** The `#query` being typed at the caret, or null: { start: where the "#" is, query: the characters after it }. */
export const taskRefAt = (text, caret) => triggerAt(text, caret, "#");

/** The text with the `#query` at `at` replaced by `#M-3 ` (one space after, unless one is already there), and where the caret goes. */
export const insertTaskRef = (text, at, caret, code) => insertAtTrigger(text, at, caret, "#", code);

// ── What the page knows of the cards ──────────────────────

/**
 * `fetchImpl(url)` → a Response (or null: no board for this page). Keeps, per card number, the view the server gave
 * ({ code, title, status, assignee, kind }) — or null for a number that is no card (asked once; asked again only after the
 * board changed, which `refresh()` is told of). The messages that name a number come in `ensure(msgs)`; only a person's own
 * words count (`role: "user"`): an agent's "M-3" is its prose, not a reference.
 */
export function createTaskRefIndex(fetchImpl) {
  const known = new Map();      // code → view | null
  const asked = new Set();      // codes asked and answered (or being asked)
  // Each request is numbered as it starts, and each card number keeps the number of the request its view came from: an
  // answer older than that view is dropped (refresh() can ask again while the first answer is still on its way, and the
  // answers can arrive in either order).
  const from = new Map();       // code → the request its view in `known` came from
  let requests = 0;
  const take = (code, view, seq) => {
    if ((from.get(code) || 0) > seq) return false;
    from.set(code, seq);
    const changed = JSON.stringify(known.get(code) || null) !== JSON.stringify(view);
    known.set(code, view);
    return changed;
  };
  const listeners = new Set();
  let inFlight = 0;
  let suggestSeq = 0;

  const read = (url) => Promise.resolve().then(() => fetchImpl(url)).then((r) => (r && r.ok ? r.json() : null), () => null);
  const notify = () => { for (const f of [...listeners]) f(); };

  function ask(codes) {
    for (let i = 0; i < codes.length; i += MAX_CODES) {
      const batch = codes.slice(i, i + MAX_CODES);
      for (const c of batch) asked.add(c);
      inFlight++;
      const seq = ++requests;
      read(`/ui/tasks/refs?codes=${encodeURIComponent(batch.join(","))}`).then((body) => {
        if (!body || !Array.isArray(body.refs)) return;   // not answered: the numbers stay text (and are asked again after a change)
        let changed = false;
        const got = new Map(body.refs.filter((v) => v && typeof v.code === "string").map((v) => [v.code, v]));
        for (const c of batch) if (take(c, got.get(c) || null, seq)) changed = true;
        if (changed) notify();
      }).finally(() => { inFlight--; });
    }
  }

  return {
    /** The card a number is, or null (not asked yet, not a card, or the board cannot be read here). */
    get: (code) => known.get(code) || null,
    /** Ask for the numbers in these messages (a person's own words) that have not been asked about yet. */
    ensure(msgs) {
      const want = [];
      for (const x of msgs || []) {
        if (!x || x.role !== "user" || typeof x.text !== "string" || x.text.length < 3) continue;
        for (const c of taskRefCodes(x.text)) if (!asked.has(c) && !want.includes(c)) want.push(c);
      }
      if (want.length) ask(want);
    },
    /** The board changed: the numbers asked about are asked again (the status and title in a chip follow the card). */
    refresh() {
      const again = [...asked];
      asked.clear();
      if (again.length) ask(again);
    },
    /** The cards to offer for what follows a `#` ("" → the latest changes). Resolves to [] when none, or when a newer call came first. */
    async suggest(query) {
      const mine = ++suggestSeq;
      const seq = ++requests;
      const body = await read(`/ui/tasks/refs?limit=8&q=${encodeURIComponent(query)}`);
      if (mine !== suggestSeq || !body || !Array.isArray(body.refs)) return [];
      // What the list shows is what the page now knows of those cards (a chip drawn later says the same), unless a newer answer came first.
      for (const v of body.refs) if (v && typeof v.code === "string") take(v.code, v, seq);
      return body.refs.filter((v) => v && typeof v.code === "string" && typeof v.title === "string");
    },
    subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
    /** Requests not answered yet (tests). */
    pending: () => inFlight,
  };
}
