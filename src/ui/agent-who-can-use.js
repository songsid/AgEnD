// M-3734 (#4459, the user's 2X): an agent page's "Who can use" (agent-details-settings.js, category "access"). One place
// that lists and edits the two existing records of who can use this agent — no third permission model:
// - Web guests: web.guests.grants (Settings → Guests' own data, read with GET /api/settings/guests). Each change writes one
//   person's whole grant with PUT /api/settings/fleet/web { guests: { grants: { <account>: grant | null } } } — the same
//   write as Settings → Guests' Save, through the same Settings confirmation: adding a person or an agent, or making them
//   Trusted, waits for a fleet admin (202, followed by settings-confirm.js); taking away applies at once. Each write is made
//   from the grant this page shows and carries it as `if_grants` (Prism #4461 P2): the server refuses it (409) when that
//   grant changed since — checked as it is admitted and again as it applies after a confirmation — so a change made
//   meanwhile in Settings → Guests is never written over, and Remove's question is about exactly what is written.
//   While the fleet still uses #1920's derived access (no grants saved), the list is read-only, and "Start from today's
//   guests" saves each guest's current reach as a grant (Settings → Guests' own button, one write here, `if_grants: "unset"`).
// - Hub: who may ask is kept only on the Hub (its grants: people or AD groups, each with an expiry); the Fleet never reads
//   or writes it. This says whether the agent is shared and links to the Hub page that chooses who may ask
//   (`?agent=<exposureId>&grant=1`, as Settings → Hub does) — on the Hub's own address, so only where the Hub is reachable.
// Discord / Telegram allowed_users is the whole bot's setting and stays as it is. Its own reads and writes (like
// Permissions, contact-permissions.js) — never staged with the page's settings Save. The server decides who may see or
// change anything: a session that isn't a fleet admin's gets 403 and is told so.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { Skeleton } from "/assets/ui-states.js";
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { settingsPath } from "/assets/app-route.js";
import { api, confirmedWrite } from "./settings-confirm.js";
import "./settings-strings.js";
import { hubClient, hubMarks, safeWebOrigin } from "./hub-client.js";
import { wc } from "./agent-who-can-use-strings.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
const PLATFORMS = { discord: "Discord", telegram: "Telegram" };
const accountKey = (g) => `${g.adapterId}:${g.userId}`;
const levelOf = (g) => (g && g.level === "trusted" ? "trusted" : "chat");
/** A grant as written: chat is the default level, never written (settings-guests.js grantOf). */
export const grantOf = (v) => ({ ...(v.name ? { name: v.name } : {}), instances: [...v.instances], ...(v.level === "trusted" ? { level: "trusted" } : {}) });
const GUESTS_URL = "/api/settings/guests";
const WRITE_URL = "/api/settings/fleet/web";

/**
 * The people this page lists for `name`, from the guests overview: with grants saved, each one whose grant names it (`editable`);
 * before that (#1920's derived access), each guest who can use it today, read-only.
 */
export function whoCanUse(overview, name) {
  const guests = (overview && Array.isArray(overview.guests) && overview.guests) || [];
  if (overview && overview.explicit) return guests.filter((g) => g.grant && Array.isArray(g.grant.instances) && g.grant.instances.includes(name));
  return guests.filter((g) => Array.isArray(g.scope) && g.scope.includes(name));
}
/** Whether a guest may be given `name` at all: one of fleet.yaml's instances, or a ClassicBot room (#2667). */
export const grantable = (overview, name) => !!overview && ((overview.instances || []).includes(name) || (overview.rooms || []).some((r) => r.name === name));
/** Each guest's current reach as a grant — Settings → Guests' "Start from today's guests". */
export function todaysGrants(overview) {
  const out = {};
  for (const g of (overview && overview.guests) || []) if (Array.isArray(g.scope) && g.scope.length) out[accountKey(g)] = { ...(g.name ? { name: g.name } : {}), instances: [...g.scope] };
  return out;
}
/**
 * One person's grant after a change on this page, from the grant saved now (null: none): "add" adds `name` (a new grant
 * when there is none, at the Chat level), "remove" takes it away (no agent left: the grant goes, null), "level" sets it.
 */
export function nextGrant(saved, name, change, extra = {}) {
  const base = saved ? grantOf(saved) : { ...(extra.name ? { name: extra.name } : {}), instances: [] };
  if (change === "add") return base.instances.includes(name) ? base : { ...base, instances: [...base.instances, name] };
  if (change === "remove") { const instances = base.instances.filter((n) => n !== name); return instances.length ? { ...base, instances } : null; }
  if (change === "level") return saved ? grantOf({ ...base, level: extra.level === "trusted" ? "trusted" : undefined }) : null;
  return base;
}
const roomName = (overview, n) => { const r = ((overview && overview.rooms) || []).find((x) => x.name === n); return (r && r.display_name) || n; };

export function WhoCanUsePanel({ name, display }) {
  // The agent as people know it — its display name, with the name the page heading uses beside it when they differ.
  const shown = display && display !== name ? wc("agentLabel", display, name) : name;
  return html`<div class="ap-who">
    <p class="note ap-who-admins">${wc("adminsNote")}</p>
    <${GuestsCard} name=${name} shown=${shown} />
    <${HubCard} name=${name} />
  </div>`;
}

function GuestsCard({ name, shown }) {
  const [overview, setOverview] = useState(null), [state, setState] = useState("loading");     // loading | ready | denied | failed
  const [people, setPeople] = useState(null), [query, setQuery] = useState("");
  const [busy, setBusy] = useState(null), [msg, setMsg] = useState(null);
  const live = useRef(true), seq = useRef(0);
  const read = async () => {
    const n = ++seq.current;
    let r = null;
    try { r = await api(GUESTS_URL); } catch { r = null; }
    if (!live.current || n !== seq.current) return null;
    if (r && r.ok && r.body) { setOverview(r.body); setState("ready"); return r.body; }
    setState(r && (r.status === 401 || r.status === 403) ? "denied" : "failed");
    return null;
  };
  const readPeople = async () => {
    let r = null;
    try { r = await api(`${GUESTS_URL}/people`); } catch { r = null; }
    if (live.current) setPeople(r && r.ok && r.body && Array.isArray(r.body.people) ? r.body.people : []);
  };
  useEffect(() => {
    live.current = true; void read();
    const onShow = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", onShow);
    return () => { live.current = false; seq.current++; document.removeEventListener("visibilitychange", onShow); };
  }, [name]);

  /** One write of Settings → Guests' own shape; `body` is the guests patch. Says how it went. */
  const write = async (key, guests) => {
    setBusy(key); setMsg(null);
    try {
      const r = await confirmedWrite(WRITE_URL, { method: "PUT", body: { guests }, resendable: true, label: wc("guestsTitle"),
        onPending: () => { if (live.current) setMsg({ waiting: true }); } });
      if (!live.current) return;
      if (r.ok) { setMsg(null); toast(wc("saved")); }
      else if (r.ambiguous) setMsg({ error: wc("unknown") });
      else if (r.status === 409 && r.body && (r.body.key === "guest_grant_changed" || r.body.error === "guest_grant_changed")) setMsg({ error: wc("changed") });
      else if (r.body && r.body.key === "guest_grant_refused") setMsg({ error: wc("refused", r.body.error || "") });
      else setMsg({ error: wc("saveFailed", (r.body && r.body.error) || r.status) });
    } catch { if (live.current) setMsg({ error: wc("unknown") }); }
    finally { if (live.current) { setBusy(null); await read(); } }
  };
  /** One person's change, made from their grant as this page shows it (`shown`: null, none), on condition it is still that. */
  const change = async (key, shownGrant, kind, extra) => {
    if (busy || !overview || !overview.explicit) return;
    const next = nextGrant(shownGrant, name, kind, extra);
    await write(key, { grants: { [key]: next }, if_grants: { [key]: shownGrant ? grantOf(shownGrant) : null } });
  };
  const shownGrantOf = (key) => { const g = ((overview && overview.guests) || []).find((x) => accountKey(x) === key); return (g && g.grant) || null; };
  const remove = async (g) => {
    // Asked about the grant shown, and written only if it is still that one (if_grants): the warning is about what is written.
    const last = !!g.grant && g.grant.instances.length === 1;
    const yes = await confirmDialog({ title: wc("removeTitle", g.name), message: wc(last ? "removeLast" : "removeConfirm", g.name, shown), confirmLabel: wc("remove"), danger: true });
    if (yes) await change(accountKey(g), g.grant, "remove");
  };
  const convert = async () => {
    if (!overview || overview.explicit) return;
    const yes = await confirmDialog({ title: wc("convertTitle"), message: wc("convertConfirm"), confirmLabel: wc("convert") });
    if (!yes) return;
    await write("--convert", { grants: todaysGrants(overview), if_grants: "unset" });
  };

  const head = html`<h3>${wc("guestsTitle")}</h3><p class="note">${wc("guestsLead")}</p>
    <div class="field-row"><a class="btn btn-sm ap-who-go" href=${`${settingsPath("access")}#guests`}>${wc("openGuests")}</a></div>`;
  if (state === "loading") return html`<section class="card ap-who-guests" id="who-guests">${head}<${Skeleton} variant="rows" lines=${3} /></section>`;
  if (state === "denied") return html`<section class="card ap-who-guests" id="who-guests">${head}<p class="note" role="status">${wc("notAdmin")}</p></section>`;
  if (state === "failed") return html`<section class="card ap-who-guests" id="who-guests">${head}<p class="note" role="status">${tn("guestsLoadFailed")} <button type="button" class="btn btn-sm" onClick=${read}>${t("app.retry")}</button></p></section>`;
  if (!grantable(overview, name)) return html`<section class="card ap-who-guests" id="who-guests">${head}<p class="note">${wc("notGrantable")}</p></section>`;

  const rows = whoCanUse(overview, name);
  const explicit = !!overview.explicit;
  const listed = new Set(rows.map(accountKey));
  const q = query.trim().toLowerCase();
  const candidates = (people || []).filter((p) => !listed.has(accountKey(p)))
    .filter((p) => !q || [p.name, p.username, p.userId].some((x) => typeof x === "string" && x.toLowerCase().includes(q))).slice(0, 8);
  const others = (g) => (g.grant ? g.grant.instances : g.scope || []).filter((n) => n !== name).map((n) => roomName(overview, n));
  const row = (g) => {
    const key = accountKey(g), levelId = `who-level-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`, level = levelOf(g.grant), on = g.sessions || g.devices, mine = busy === key, also = others(g);
    return html`<li key=${key} class="ap-who-row" data-account=${key}>
      <span class="ap-who-av" aria-hidden="true">${(g.name || "?").slice(0, 1).toUpperCase()}</span>
      <div class="ap-who-id"><strong>${g.name || g.userId}</strong> <span class="note">${PLATFORMS[g.platform] || g.platform || ""}</span>
        <div class="note ap-who-state">${on ? tn("grantsSignedIn", g.devices || g.sessions) : tn("grantsNotSignedIn")}${also.length ? html` · ${wc("alsoUses", also.join(", "))}` : null}</div></div>
      ${explicit ? html`<div class="ap-who-actions">
        <span class="note ap-who-level-label" id=${levelId}>${wc("level")}</span>
        <div class="seg-inline" role="group" aria-labelledby=${levelId}>${["chat", "trusted"].map((l) => html`<button key=${l} type="button"
          class=${`btn btn-sm${level === l ? " btn-primary" : ""}`} aria-pressed=${level === l ? "true" : "false"} data-level=${l} disabled=${!!busy}
          onClick=${() => { if (level !== l) void change(key, g.grant, "level", { level: l }); }}>${tn(l === "trusted" ? "grantsLevelTrusted" : "grantsLevelChat")}</button>`)}</div>
        <button type="button" class="btn btn-sm btn-danger ap-who-remove" disabled=${!!busy} aria-busy=${mine ? "true" : undefined} onClick=${() => remove(g)}>${wc("remove")}</button>
      </div>${also.length ? html`<p class="note ap-who-level-all">${wc("levelAll", g.name, also.length + 1)}</p>` : null}` : html`<span class="note ap-who-level">${tn(level === "trusted" ? "grantsLevelTrusted" : "grantsLevelChat")}</span>`}
    </li>`;
  };
  return html`<section class="card ap-who-guests" id="who-guests">${head}
    ${!overview.enabled ? html`<p class="note ap-who-off" role="note">${wc("guestsOff")}</p>` : null}
    ${!explicit ? html`<div class="ap-who-derived"><p class="note">${wc("derived")}</p><p class="note">${wc("convertHint")}</p>
      <button type="button" class="btn btn-sm" id="whoConvert" disabled=${!!busy} onClick=${convert}>${wc("convert")}</button></div>` : null}
    ${!explicit && rows.length ? html`<p class="note">${wc("derivedList")}</p>` : null}
    ${rows.length ? html`<ul class="ap-who-list">${rows.map(row)}</ul>` : html`<p class="note" id="whoNone">${wc("none")}</p>`}
    ${rows.some((g) => levelOf(g.grant) === "trusted") ? html`<p class="note ap-who-trusted">${wc("trustedHint")}</p>` : null}
    ${explicit ? html`<details class="ap-who-add" onToggle=${(e) => { if (e.target.open && people === null) void readPeople(); }}><summary>${wc("add")}</summary>
      <p class="note">${wc("addHint")} ${wc("addMissing")}</p>
      <p class="note ap-who-confirm-note">${wc("addConfirm")}</p>
      <input type="search" class="input" id="whoSearch" value=${query} aria-label=${wc("searchLabel")} placeholder=${wc("searchShort")} onInput=${(e) => setQuery(e.target.value)} />
      ${people === null ? html`<${Skeleton} variant="rows" lines=${2} />` : !candidates.length ? html`<p class="note" id="whoNoPeople">${wc("noPeople")}</p>`
        : html`<ul class="ap-who-list ap-who-pick">${candidates.map((p) => { const key = accountKey(p); return html`<li key=${key} class="ap-who-row" data-account=${key}>
          <span class="ap-who-av" aria-hidden="true">${(p.name || "?").slice(0, 1).toUpperCase()}</span>
          <div class="ap-who-id"><strong>${p.name}</strong> <span class="note">${PLATFORMS[p.platform] || p.platform}${p.username ? ` · @${p.username}` : ""}</span></div>
          <div class="ap-who-actions"><button type="button" class="btn btn-sm" disabled=${!!busy} onClick=${() => change(key, shownGrantOf(key), "add", { name: p.name })}>${busy === key ? wc("adding") : wc("addOne")}</button></div></li>`; })}</ul>`}
    </details>` : null}
    ${msg && msg.waiting ? html`<p class="note ap-who-msg" role="status">${wc("waiting")}</p>` : null}
    ${msg && msg.error ? html`<p class="note err ap-who-msg" role="alert">${msg.error}</p>` : null}
  </section>`;
}

/** The Hub's part: this agent's share, as Settings → Hub reads it, and the way to the Hub page that chooses who may ask. */
export function hubState(marks, pairing, rows, name) {
  if (!marks || !marks.member) return { kind: "none" };
  if (!pairing) return { kind: "loading" };
  if (pairing.state !== "paired") return { kind: "notPaired" };
  if (!rows) return { kind: "loading" };
  const row = rows.find((r) => r && r.agent === name);
  const origin = safeWebOrigin(pairing), offline = pairing.link === "offline";
  const link = row && origin && /^[a-f0-9-]{36}$/.test(row.exposureId || "") ? `${origin}/ui/hub/exposures?agent=${encodeURIComponent(row.exposureId)}&grant=1` : null;
  if (!row) return { kind: "notShared", offline };
  if (row.pending) return { kind: "pending", offline };
  if (row.state === "frozen") return { kind: "frozen", offline };
  if (row.state !== "published") return { kind: "notShared", offline };
  if (row.reason === "hub_refused") return { kind: "refused", offline };
  if (row.reason === "republish_required" || row.reason === "share_lapsed") return { kind: "lapsed", offline, link };
  return { kind: "shared", offline, link };
}
const HUB_WORDS = { none: "hubNone", notPaired: "hubNotPaired", notShared: "hubNotShared", pending: "hubPending", frozen: "hubFrozen", refused: "hubRefused", lapsed: "hubLapsed", shared: "hubShared", failed: "hubLoadFailed" };

function HubCard({ name }) {
  const marks = hubMarks();
  const [pairing, setPairing] = useState(null), [rows, setRows] = useState(null), [failed, setFailed] = useState(false);
  const live = useRef(true);
  const read = async () => {
    if (!marks.member) return;
    setFailed(false);
    try {
      const client = hubClient();
      const p = await client.pairing();
      if (!live.current) return;
      setPairing(p);
      if (p && p.state === "paired") { const r = await client.exposures(); if (live.current) setRows(Array.isArray(r) ? r : []); }
    } catch { if (live.current) setFailed(true); }
  };
  useEffect(() => { live.current = true; void read(); return () => { live.current = false; }; }, [name]);
  const s = failed ? { kind: "failed" } : hubState(marks, pairing, rows, name);
  return html`<section class="card ap-who-hub" id="who-hub" data-hub-state=${s.kind}><h3>${wc("hubTitle")}</h3>
    <p class="note">${wc("hubLead")}</p>
    ${s.kind === "loading" ? html`<${Skeleton} variant="rows" lines=${1} />` : html`<p class="ap-who-hub-state" role="status">${wc(HUB_WORDS[s.kind])}</p>`}
    ${s.offline ? html`<p class="note">${wc("hubOffline")}</p>` : null}
    ${s.kind === "failed" ? html`<button type="button" class="btn btn-sm" onClick=${read}>${t("app.retry")}</button>` : null}
    ${s.link ? html`<p class="note ap-who-hub-where">${wc("hubWhere")}</p>` : null}
    <div class="field-row">
      ${s.link ? html`<a class="btn btn-sm btn-primary" id="whoHubChoose" href=${s.link} target="_blank" rel="noopener noreferrer">${wc("hubChoose")}<span aria-hidden="true"> ↗</span></a>` : null}
      ${s.kind !== "loading" ? html`<a class="btn btn-sm" href=${settingsPath("hub")}>${wc("hubSettings")}</a>` : null}
    </div>
  </section>`;
}
