// The Office view's data, behind one small seam (fleet-office.js uses only these calls):
// - the offices people made: the host's (GET / PUT /ui/offices, src/web-office-store.ts — one list for every viewer);
//   what comes back is checked again here (fleet-office-model.js officesOk), never trusted;
// - this browser's own choices (localStorage; blocked storage: this page only, as the canvas's Canvas/List): which
//   office is shown, the auto office's member filter, and its style (skin).
// TODO(office editor): adding and renaming offices, assigning people, dragging seats and drawing paths call
// saveOffices() with the whole list and the rev they read (a change in between answers 409).
import { AUTO_ID, filterOk, officesOk } from "./fleet-office-model.js";

const CHOICE_KEY = "agend_org_office", FILTER_KEY = "agend_org_office_filter", SKIN_KEY = "agend_org_office_skin";

/** `fetch`: the caller's (a lease's, so an answer after the person moved on is dropped); `storage`: default localStorage. */
export function createOfficeStore({ fetch: get = globalThis.fetch, storage } = {}) {
  const st = () => { try { return storage || globalThis.localStorage || null; } catch { return null; } };
  const read = (k) => { try { const s = st(); return s ? s.getItem(k) : null; } catch { return null; } };
  const write = (k, v) => { try { const s = st(); if (s) s.setItem(k, v); } catch { /* this page only */ } };
  const headers = { "Content-Type": "application/json" };
  return {
    /** { rev, offices } from the host; null when it could not be read (no offices shown but the auto one). */
    async offices() {
      try {
        const r = await get("/ui/offices", { method: "GET", headers });
        if (!r || !r.ok) return null;
        const d = await r.json();
        return { rev: Number.isSafeInteger(d && d.rev) ? d.rev : 0, offices: officesOk(d && d.offices) };
      } catch { return null; }
    },
    /**
     * Replace the host's list (an admin session; `rev`: the one read — required: the host refuses a save without it,
     * so two editors never overwrite each other unseen). { ok, rev, offices } or { ok: false, status, error }.
     */
    async saveOffices(list, rev) {
      if (!Number.isSafeInteger(rev)) return { ok: false, status: 0, error: "offices_rev_required" };
      try {
        const r = await get("/ui/offices", { method: "PUT", headers, body: JSON.stringify({ offices: list, rev }) });
        const d = await r.json().catch(() => ({}));
        return r.ok ? { ok: true, rev: d.rev, offices: officesOk(d.offices) } : { ok: false, status: r.status, error: d.error || "offices_failed" };
      } catch { return { ok: false, status: 0, error: "offices_failed" }; }
    },
    /** The office shown here: an id (one the host no longer has falls back to the auto office where it is used). */
    choice: () => { const v = read(CHOICE_KEY); return typeof v === "string" && v && v.length <= 40 ? v : AUTO_ID; },
    saveChoice: (id) => write(CHOICE_KEY, String(id)),
    filter: () => { const s = read(FILTER_KEY); try { return filterOk(s ? JSON.parse(s) : null); } catch { return filterOk(null); } },
    saveFilter: (f) => write(FILTER_KEY, JSON.stringify(filterOk(f))),
    /** The whole fleet's style here: a skin id ("pixel": desks, "studio": zones); an unknown one is the default where used. */
    skin: () => { const v = read(SKIN_KEY); return typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : "pixel"; },
    saveSkin: (id) => write(SKIN_KEY, String(id)),
  };
}
