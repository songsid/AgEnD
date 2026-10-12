// #1682 (design: the comment on #1682): the names of the Discord mentions a page shows — `<@id>` / `<@!id>` (a user),
// `<@&id>` (a role), `<#id>` (a channel). Asked from GET /ui/mentions (same-origin; the host answers from memory) only
// for the ids the page's messages carry, each id once per page, at most MAX_IDS per request. Until a name arrives (or
// if it never does) the pill reads @user / @role / #channel; when names arrive, the messages are drawn again.

const TOKEN = /<(@!?|@&|#)(\d{15,25})>/g;
const KIND = { "@": "u", "@!": "u", "@&": "r", "#": "c" };
const MAX_IDS = 100;

export function createMentionIndex(fetchImpl) {
  const names = new Map();     // "u:id" → name
  const asked = new Set();     // "u:id" asked already (answered or not: never again on this page)
  const listeners = new Set();
  let inFlight = 0;
  function idsIn(msgs) {
    const want = [];
    for (const x of msgs || []) {
      if (!x || typeof x.text !== "string" || x.text.indexOf("<") === -1) continue;
      for (const m of x.text.matchAll(TOKEN)) {
        const key = `${KIND[m[1]]}:${m[2]}`;
        if (!asked.has(key) && !want.includes(key)) want.push(key);
      }
    }
    return want;
  }
  return {
    /** The name the page knows for a mention, or null (the pill says @user / @role / #channel). */
    name: (kind, id) => names.get(`${kind}:${id}`) ?? null,
    /** Ask for the names of the mentions in these messages the page has not asked about yet. */
    ensure(msgs) {
      const want = idsIn(msgs);
      for (let i = 0; i < want.length; i += MAX_IDS) {
        const batch = want.slice(i, i + MAX_IDS);
        for (const key of batch) asked.add(key);
        const params = new URLSearchParams();
        for (const kind of ["u", "r", "c"]) {
          const ids = batch.filter((k) => k[0] === kind).map((k) => k.slice(2));
          if (ids.length) params.set(kind, ids.join(","));
        }
        inFlight++;
        Promise.resolve()
          .then(() => fetchImpl(`/ui/mentions?${params}`))
          .then((r) => (r && r.ok ? r.json() : null))
          .then((body) => {
            let added = false;
            for (const kind of ["u", "r", "c"]) {
              const got = body && typeof body[kind] === "object" && body[kind] ? body[kind] : {};
              for (const key of batch) {
                if (key[0] !== kind) continue;
                const id = key.slice(2);
                if (Object.prototype.hasOwnProperty.call(got, id) && typeof got[id] === "string" && got[id]) { names.set(key, got[id]); added = true; }
              }
            }
            if (added) for (const f of [...listeners]) f();
          }, () => {})
          .finally(() => { inFlight--; });
      }
    },
    subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
    /** Requests not answered yet (tests). */
    pending: () => inFlight,
  };
}
