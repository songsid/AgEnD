// #1630 (design: the comment on #1630): the Discord server emoji the fleet's bots know — GET /ui/emojis, session-gated
// and served same-origin — so a message's `<:name:id>` / `<a:name:id>` can be drawn as its picture (chat-render.js).
// Read once per page, and only once a message shows such a tag; until it arrives (or if it fails) every tag stays text.
// A message drawn before the list arrived is drawn again when it does (the thread replaces what changed).

const TAG = /<a?:[A-Za-z0-9_]{2,32}:\d{15,25}>/;
const ID = /^\d{15,25}$/;

export function createEmojiIndex(fetchImpl) {
  let ids = null;          // Set of known ids once read (empty after a failure: no retry on this page)
  let loading = false;
  const listeners = new Set();
  const settle = (next) => { ids = next; for (const f of [...listeners]) f(); };
  return {
    known: (id) => !!ids && ids.has(id),
    /** Any of these messages carries a server-emoji tag. */
    wants: (msgs) => (msgs || []).some((x) => x && typeof x.text === "string" && TAG.test(x.text)),
    /** Starts the one read of this page (once). */
    ensure() {
      if (ids || loading) return;
      loading = true;
      Promise.resolve()
        .then(() => fetchImpl("/ui/emojis"))
        .then((r) => (r && r.ok ? r.json() : null))
        .then((body) => {
          const next = new Set();
          if (body && Array.isArray(body.emojis)) for (const e of body.emojis) if (e && typeof e.id === "string" && ID.test(e.id)) next.add(e.id);
          settle(next);
        }, () => settle(new Set()));
    },
    subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
  };
}
