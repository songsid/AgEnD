// The Office view's data, behind one small seam (fleet-office.js uses only these calls):
// - the offices people made: the host's (GET / PUT /ui/offices, src/web-office-store.ts — one list for every viewer);
//   what comes back is checked again here (fleet-office-model.js officesOk), never trusted;
// - this browser's own choices (localStorage; blocked storage: this page only, as the canvas's Canvas/List): which
//   office is shown, the auto office's member filter, and its style (skin); #2540: the view (zoom and centre) and the
//   fit mode (Fit or Fill) per office; #2554: whether All offices shows the lobby tile.
// - the skin packs an admin uploaded (#2513: GET /ui/office-skins, POST to upload one, DELETE to remove one;
//   src/web-office-skins.ts). The office editor and the layout editor call saveOffices() with the whole list and the rev
//   they read (a change in between answers 409).
// - #2692: the agents' pack changes (GET / POST /ui/office-pack-changes, an admin's): which agents may change packs, the
//   fleet's approval mode, the changes waiting for a yes, and the newest log entries.
import { AUTO_ID, filterOk, officesOk } from "./fleet-office-model.js";
import { fitModeOk, savedOk } from "./fleet-office-view.js";

const CHOICE_KEY = "agend_org_office", FILTER_KEY = "agend_org_office_filter", SKIN_KEY = "agend_org_office_skin", ASLEEP_KEY = "agend_org_office_hide_asleep", NIGHT_KEY = "agend_org_office_night";
/** #2554: "0" when All offices leaves the lobby tile out (default: shown). */
const LOBBY_KEY = "agend_org_office_lobby";
/** #2540: { "<office>@<style>": [k, cx, cy] (and a 1 after them: a fit) } — the last VIEWS_MAX views, the most recent last. */
const VIEW_KEY = "agend_org_office_view", VIEWS_MAX = 32;
/** #2540: { "<office>@<style>": "cover" } — the offices whose fit fills the panel (the rest: "contain"), the last VIEWS_MAX. */
const FIT_KEY = "agend_org_office_fit";
const PACK_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** #2692: GET /ui/office-pack-changes, checked: { approval, agents: [names], pending: [views], log: [entries] } (anything odd dropped). */
export function packChangesOk(d) {
  const str = (v, n = 200) => (typeof v === "string" ? v.slice(0, n) : "");
  const approval = d && (d.approval === "apply" || d.approval === "approve") ? d.approval : "approve";
  const agents = Array.isArray(d && d.agents) ? d.agents.filter((n) => typeof n === "string" && n).slice(0, 500).map((n) => n.slice(0, 200)) : [];
  const pending = (Array.isArray(d && d.pending) ? d.pending.slice(0, 32) : []).filter((v) => v && /^[0-9a-f]{32}$/.test(String(v.id)) && typeof v.instance === "string")
    .map((v) => ({ id: v.id, instance: str(v.instance), action: str(v.action, 20), at: Number(v.at) || 0, expires_at: Number(v.expires_at) || 0,
      packs: (Array.isArray(v.packs) ? v.packs.slice(0, 16) : []).filter((p) => p && typeof p.id === "string").map((p) => ({ id: str(p.id, 40), name: str(p.name, 60) || str(p.id, 40), files: Number(p.files) || 0, bytes: Number(p.bytes) || 0, replaces: typeof p.replaces === "string" ? p.replaces.slice(0, 32) : null })),
      office: str(v.office, 40), style: str(v.style, 40), keep_previous: v.keep_previous === true, drops: Array.isArray(v.drops) ? v.drops.length : 0 }));
  const log = (Array.isArray(d && d.log) ? d.log.slice(0, 50) : []).filter((e) => e && typeof e.at === "string")
    .map((e) => ({ at: str(e.at, 40), by: str(e.by), action: str(e.action, 20), pack: str(e.pack, 200), outcome: str(e.outcome), files: Number(e.files) || 0, bytes: Number(e.bytes) || 0, approved_by: str(e.approved_by) }));
  return { approval, agents, pending, log };
}
/** The host's list of skin packs, checked: [{ id, name, sha }] (anything odd dropped). */
export function skinListOk(d) {
  const out = [], ids = new Set();
  for (const p of Array.isArray(d && d.packs) ? d.packs.slice(0, 64) : []) {
    if (!p || typeof p.id !== "string" || !PACK_ID.test(p.id) || ids.has(p.id) || typeof p.sha !== "string" || !/^[0-9a-f]{32}$/.test(p.sha)) continue;
    ids.add(p.id);
    out.push({ id: p.id, name: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 60) : p.id, sha: p.sha });
  }
  return out;
}

/** `fetch`: the caller's (a lease's, so an answer after the person moved on is dropped); `storage`: default localStorage. */
/**
 * Agents' acts as the host sends them (GET /ui/office-acts, the `office_acts` event), checked: the well-formed ones.
 * `now`: the host's clock when it sent them — each end is moved onto this page's clock (they may differ).
 */
export function actsOk(list, now) {
  const skew = typeof now === "number" && Number.isFinite(now) ? now - Date.now() : 0;
  const str = (v) => typeof v === "string" && v.length > 0 && v.length <= 200, num = (v) => typeof v === "number" && Number.isFinite(v);
  return (Array.isArray(list) ? list : []).filter((a) => a && typeof a === "object" && str(a.instance) && str(a.office) && num(a.until)
    && (a.x === undefined || num(a.x)) && (a.y === undefined || num(a.y)) && (a.person === undefined || str(a.person))
    && (a.say === undefined || (typeof a.say === "string" && a.say.length <= 40)) && (a.pose === undefined || ["idle", "working", "needs", "paused"].includes(a.pose)))
    .map((a) => ({ instance: a.instance, office: a.office, until: a.until - skew, ...(num(a.since) ? { since: a.since } : {}), ...(str(a.state) ? { state: a.state } : {}),
      ...(num(a.x) && num(a.y) ? { x: a.x, y: a.y } : {}),
      ...(a.person ? { person: a.person } : {}), ...(a.say ? { say: a.say } : {}), ...(a.pose ? { pose: a.pose } : {}) }));
}
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
    /** #2578: what agents are doing in the offices now (office_set): their acts, or null when they could not be read. */
    async acts() {
      try {
        const r = await get("/ui/office-acts", { method: "GET", headers });
        if (!r || !r.ok) return null;
        const d = await r.json();
        return actsOk(d && d.acts, d && d.now);
      } catch { return null; }
    },
    /** The skin packs the host keeps: { rev, packs: [{ id, name, sha }] }; null when they could not be read. */
    async skins() {
      try {
        const r = await get("/ui/office-skins", { method: "GET", headers });
        if (!r || !r.ok) return null;
        const d = await r.json();
        return { rev: typeof (d && d.rev) === "string" ? d.rev : "", packs: skinListOk(d) };
      } catch { return null; }
    },
    /** Upload a pack (an admin session): { manifest, files: { name: base64 }, name? } → { ok, pack } or { ok: false, status, error, detail }. */
    async uploadSkin(body) {
      try {
        const r = await get("/ui/office-skins", { method: "POST", headers, body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        return r.ok ? { ok: true, pack: d.pack, rev: d.rev } : { ok: false, status: r.status, error: d.error || "skin_failed", detail: d.detail || "" };
      } catch { return { ok: false, status: 0, error: "skin_failed", detail: "" }; }
    },
    /** Remove a pack (an admin session). */
    async deleteSkin(id) {
      try {
        const r = await get(`/ui/office-skins/${encodeURIComponent(id)}`, { method: "DELETE", headers });
        const d = await r.json().catch(() => ({}));
        return r.ok ? { ok: true } : { ok: false, status: r.status, error: d.error || "skin_failed" };
      } catch { return { ok: false, status: 0, error: "skin_failed" }; }
    },
    /**
     * #2692: the agents' skin-pack changes (an admin session): { approval, agents, pending, log }, or null (not offered,
     * not an admin, not read).
     */
    async packChanges() {
      try {
        const r = await get("/ui/office-pack-changes", { method: "GET", headers });
        if (!r || !r.ok) return null;
        return packChangesOk(await r.json());
      } catch { return null; }
    },
    /** #2692: the fleet's approval mode for agents' pack changes ("apply" | "approve"). */
    async setPackApproval(approval) {
      try {
        const r = await get("/ui/office-pack-changes", { method: "POST", headers, body: JSON.stringify({ approval }) });
        const d = await r.json().catch(() => ({}));
        return r.ok ? { ok: true, changes: packChangesOk(d) } : { ok: false, status: r.status, error: d.error || "pack_changes_failed" };
      } catch { return { ok: false, status: 0, error: "pack_changes_failed" }; }
    },
    /** #2692: an admin's yes or no on a pending pack change: { ok, text } or { ok: false, status, error, detail }. */
    async decidePackChange(id, decision) {
      if (!/^[0-9a-f]{32}$/.test(String(id))) return { ok: false, status: 0, error: "change_unknown", detail: "" };
      try {
        const r = await get(`/ui/office-pack-changes/${id}`, { method: "POST", headers, body: JSON.stringify({ decision }) });
        const d = await r.json().catch(() => ({}));
        return r.ok ? { ok: true, text: String(d.text || "") } : { ok: false, status: r.status, error: d.error || "pack_changes_failed", detail: String(d.detail || "") };
      } catch { return { ok: false, status: 0, error: "pack_changes_failed", detail: "" }; }
    },
    /**
     * The office shown here: an id (one the host no longer has falls back to the auto office where it is used), or
     * #2554's All offices (fleet-office-overview.js ALL_ID; with fewer than two offices stored: the auto office).
     */
    choice: () => { const v = read(CHOICE_KEY); return typeof v === "string" && v && v.length <= 40 ? v : AUTO_ID; },
    saveChoice: (id) => write(CHOICE_KEY, String(id)),
    filter: () => { const s = read(FILTER_KEY); try { return filterOk(s ? JSON.parse(s) : null); } catch { return filterOk(null); } },
    saveFilter: (f) => write(FILTER_KEY, JSON.stringify(filterOk(f))),
    /** The whole fleet's style here: a skin id ("pixel": desks, "studio" and "cozy": zones); none chosen yet: cozy (#2631); an unknown one is the default where used. */
    skin: () => { const v = read(SKIN_KEY); return typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : "cozy"; },
    saveSkin: (id) => write(SKIN_KEY, String(id)),
    /** Whether paused and stopped people are left out of the Office here (default: shown). */
    hideAsleep: () => read(ASLEEP_KEY) === "1",
    saveHideAsleep: (v) => write(ASLEEP_KEY, v ? "1" : "0"),
    /** #2568: whether the idle go to bed at night (00:00–06:00 on this device's clock) here (default: off). */
    nightOn: () => read(NIGHT_KEY) === "1",
    saveNightOn: (v) => write(NIGHT_KEY, v ? "1" : "0"),
    /** #2554: whether All offices shows the lobby tile (the instances in no stored office) here (default: shown). */
    lobbyTile: () => read(LOBBY_KEY) !== "0",
    saveLobbyTile: (v) => write(LOBBY_KEY, v ? "1" : "0"),
    /** The view kept for `key` (an office and its style): { k, cx, cy } (fleet-office-view.js savedOf), or null. */
    view: (key) => {
      try { const m = JSON.parse(read(VIEW_KEY) || "{}"); const a = m && Object.prototype.hasOwnProperty.call(m, key) ? m[key] : null;
        return Array.isArray(a) ? savedOk({ k: a[0], cx: a[1], cy: a[2], fit: a[3] === 1 }) : null; } catch { return null; }
    },
    saveView: (key, v) => {
      const ok = savedOk(v);
      if (!ok || typeof key !== "string" || key.length > 100) return;
      let m = {};
      try { const o = JSON.parse(read(VIEW_KEY) || "{}"); if (o && typeof o === "object" && !Array.isArray(o)) m = o; } catch { m = {}; }
      const r = (n) => Math.round(n * 1000) / 1000;
      const next = Object.entries(m).filter(([k2, a]) => k2 !== key && Array.isArray(a)).slice(-(VIEWS_MAX - 1));
      write(VIEW_KEY, JSON.stringify(Object.fromEntries([...next, [key, [r(ok.k), r(ok.cx), r(ok.cy), ...(ok.fit ? [1] : [])]]])));
    },
    /** The fit mode kept for `key`: "contain" (the default) or "cover" (Fill). */
    fitMode: (key) => {
      try { const m = JSON.parse(read(FIT_KEY) || "{}"); return fitModeOk(m && Object.prototype.hasOwnProperty.call(m, key) ? m[key] : null); } catch { return "contain"; }
    },
    saveFitMode: (key, mode) => {
      if (typeof key !== "string" || key.length > 100) return;
      let m = {};
      try { const o = JSON.parse(read(FIT_KEY) || "{}"); if (o && typeof o === "object" && !Array.isArray(o)) m = o; } catch { m = {}; }
      const next = Object.entries(m).filter(([k2, v]) => k2 !== key && v === "cover").slice(-(VIEWS_MAX - 1));
      write(FIT_KEY, JSON.stringify(Object.fromEntries(fitModeOk(mode) === "cover" ? [...next, [key, "cover"]] : next)));
    },
  };
}
