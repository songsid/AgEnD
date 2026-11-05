// AgEnD Hub P1, slice 3: the Hub workspace's pages — Ask, My exposures, Administration (/ui/hub, /ui/hub/exposures,
// /ui/hub/admin) — and its session row. Served only by a Hub's own listener at its own origin, over the Hub's /hub/v1/*
// API (hub-client.js createHubWebClient); nothing here reads or reaches a fleet. A lazy module: it imports only names
// every shell has had since #1408, so a tab opened before an upgrade loads it as fresh as the rest.
//
// What people see is what the server says now: every list is read fresh, every change is checked again by the server
// (who, the revision shown, the directory), and a conflict reloads the list instead of guessing.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { PanelHeader, setTitle } from "/assets/app-shell.js";
import { Empty } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { compareGroups, hubClient } from "./hub-client.js";
import { hw, linkHubCss } from "./hub-strings.js";

const TITLES = { ask: "askTitle", exposures: "exposuresTitle", admin: "adminTitle" };
/** P1 room polling: at most once per ten seconds, one request at a time, paused while the page is hidden (hub.md §5). */
export const POLL_MS = 10_000;
const DAYS = [1, 7, 30, 90];

// The page's one view of the Hub session, shared by the panel and the sidebar's session row.
let session;                                     // undefined: not read yet; null: signed out; else the session
const sessionSubs = new Set();
function setSession(next) { session = next; for (const fn of sessionSubs) { try { fn(next); } catch { /* a subscriber's own failure */ } } }
let reading = null;
function readSession() {
  const c = hubClient();
  if (typeof c.session !== "function") { setSession(null); return Promise.resolve(null); }
  return reading ??= c.session().then((r) => { setSession(r.ok && r.signedIn ? r : null); return session; }, () => { setSession(null); return null; })
    .finally(() => { reading = null; });
}
let watchingEnd = false;
function useSession() {
  const [s, set] = useState(session);
  useEffect(() => {
    sessionSubs.add(set);
    const c = hubClient();
    if (!watchingEnd && c.onSignedOut) { watchingEnd = true; c.onSignedOut(() => setSession(null)); }
    if (session === undefined) readSession();
    return () => sessionSubs.delete(set);
  }, []);
  return s;
}
const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const errText = (r) => hw(r.code === "conflict" || r.code === "stale" ? "errConflictHub" : r.code === "not-found" ? "errNotFound"
  : r.code === "backpressure" ? "errBusyHub" : r.code === "revoked" || r.code === "denied" ? "errDenied" : r.code === "unreachable" ? "errUnreachableHub" : "errFailed");
function newKey() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const x = [...b].map((v) => v.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function HubPanel({ route }) {
  const tab = TITLES[route && route.tab] ? route.tab : "ask";
  const s = useSession();
  useEffect(() => { linkHubCss(); }, []);
  useEffect(() => { setTitle(hw(TITLES[tab])); }, [tab]);
  let body = null;
  if (s === null) body = html`<${HubSignIn} />`;
  else if (s) body = tab === "ask" ? html`<${HubAsk} />` : tab === "exposures" ? html`<${HubMine} />` : html`<${HubAdmin} admin=${!!s.admin} />`;
  return html`<div data-effect-panel="hub" class=${`panel p-hub p-hub-${tab}`}>
    <${PanelHeader} title=${hw(TITLES[tab])} />
    <div data-trust="panel-content" class="panel-body hub-body">${body}</div>
  </div>`;
}

/** The sidebar's session row: who is signed in to this Hub, and Sign out. */
export function HubSessionMenu() {
  const s = useSession();
  const [busy, setBusy] = useState(false);
  if (!s) return html`<div class="session hub-session"><span class="side-row"><span class="dot" aria-hidden="true"></span><span class="grow">${hw("signedOutHub")}</span></span></div>`;
  const out = async () => { setBusy(true); await hubClient().signOut(); setBusy(false); setSession(null); };
  return html`<div class="session hub-session">
    <span class="side-row"><span class="dot ok" aria-hidden="true"></span><span class="grow">${s.displayName}</span></span>
    <button type="button" class="btn btn-sm hub-signout" disabled=${busy} onClick=${out}>${hw("signOut")}</button>
  </div>`;
}

function HubSignIn() {
  const [form, setForm] = useState({ login: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (busy || !form.login.trim() || !form.password) return;
    setBusy(true); setMsg(null);
    const r = await hubClient().signIn(form.login.trim(), form.password);
    setBusy(false);
    if (r.ok) { setForm({ login: "", password: "" }); setSession(r); return; }
    setForm((f) => ({ ...f, password: "" }));
    setMsg(r.code === "backpressure" ? hw("errBusyHub") : r.code === "unavailable" ? hw("errDirectory") : hw("errSignIn"));
  };
  return html`<section class="card hub-signin">
    <h2>${hw("signInTitle")}</h2>
    <p class="note">${hw("signInLead")}</p>
    <form class="form" onSubmit=${submit}>
      <label class="field"><span>${hw("login")}</span><input id="hubLogin" autocomplete="username" spellcheck=${false} autocapitalize="none"
        value=${form.login} onInput=${(e) => { const v = e.target.value; setForm((f) => ({ ...f, login: v })); }} /></label>
      <label class="field"><span>${hw("password")}</span><input id="hubPassword" type="password" autocomplete="current-password"
        value=${form.password} onInput=${(e) => { const v = e.target.value; setForm((f) => ({ ...f, password: v })); }} /></label>
      <div class="field-row"><button type="submit" class="btn btn-primary" disabled=${busy || !form.login.trim() || !form.password}>${hw("signIn")}</button></div>
    </form>
    ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
  </section>`;
}

/** Load a list from the client; `reload` reads it again. null while loading, { error } on failure. */
function useRead(read) {
  const [data, setData] = useState(null);
  const live = useRef(true);
  const reload = () => read().then((r) => { if (live.current) setData(r.ok ? r : { error: errText(r) }); }, () => { if (live.current) setData({ error: hw("errFailed") }); });
  useEffect(() => { live.current = true; reload(); return () => { live.current = false; }; }, []);
  return [data, reload];
}

// ── Ask ──
function HubAsk() {
  const [cat] = useRead(() => hubClient().catalog());
  const [rooms, reloadRooms] = useRead(() => hubClient().rooms());
  const [room, setRoom] = useState(null);
  const [msg, setMsg] = useState(null);
  const open = async (item) => {
    setMsg(null);
    const r = await hubClient().openRoom(item.exposure.id, item.grant.id);
    if (!r.ok) { setMsg(errText(r)); return; }
    setRoom(r.room); reloadRooms();
  };
  if (room) return html`<${HubRoom} room=${room} onBack=${() => { setRoom(null); reloadRooms(); }} />`;
  if (!cat) return null;
  if (cat.error) return html`<p class="err" role="alert">${cat.error}</p>`;
  const askable = cat.askable || [], mine = rooms && rooms.rooms ? rooms.rooms : [];
  if (!askable.length && !mine.length) return html`<div class="center hub-empty"><${Empty} icon="chat" title=${hw("askEmpty")} hint=${hw("askHint")} /></div>`;
  return html`<div class="hub-ask">
    ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
    ${askable.length ? html`<section class="card"><h3>${hw("askableTitle")}</h3><ul class="hub-list">${askable.map((it) => html`<li key=${it.grant.id} class="hub-item">
      <div class="grow"><strong>${it.exposure.displayName}</strong><small class="note">${hw("allowedBy", it.ownerName || "—", when(it.grant.expiresAt))}</small></div>
      <button type="button" class="btn btn-sm" onClick=${() => open(it)}><${Icon} name="chat" size=${14} />${hw("ask")}</button>
    </li>`)}</ul></section>` : null}
    ${mine.length ? html`<section class="card"><h3>${hw("roomsTitle")}</h3><ul class="hub-list">${mine.map((r) => html`<li key=${r.id} class="hub-item">
      <div class="grow"><strong>${r.exposureName}</strong></div>
      <button type="button" class="btn btn-sm" onClick=${() => setRoom({ id: r.id, exposureName: r.exposureName })}>${hw("openRoom")}</button>
    </li>`)}</ul></section>` : null}
  </div>`;
}

const STAGE = { queued: "stageQueued", delivered: "stageDelivered", consumed: "stageWorking", answered: "stageAnswered",
  rejected: "stageNotAnswered", cancelled: "stageNotAnswered", failed: "stageNotAnswered", uncertain: "stageUncertain" };
function HubRoom({ room, onBack }) {
  const [entries, setEntries] = useState([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [closed, setClosed] = useState(false);
  const state = useRef({ live: true, timer: 0, inflight: false, entries: [] });
  const merge = (got) => {
    const byId = new Map(state.current.entries.map((e) => [e.messageId, e]));
    for (const e of got) byId.set(e.messageId, { ...byId.get(e.messageId), ...e });
    state.current.entries = [...byId.values()].sort((a, b) => a.sequence - b.sequence);
    setEntries(state.current.entries);
  };
  const poll = async () => {
    const st = state.current;
    if (!st.live || st.inflight) return;
    if (typeof document !== "undefined" && document.hidden) { schedule(POLL_MS); return; }
    st.inflight = true;
    // Unanswered entries are read again (from just before the oldest open one); answered history is kept.
    const open = st.entries.find((e) => !["answered", "rejected", "cancelled", "failed"].includes(e.receipt && e.receipt.stage));
    const after = open ? open.sequence - 1 : st.entries.length ? st.entries[st.entries.length - 1].sequence : 0;
    const r = await hubClient().read(room.id, after);
    st.inflight = false;
    if (!st.live) return;
    if (r.ok) { merge(r.entries || []); schedule(POLL_MS); return; }
    if (r.code === "revoked" || r.code === "not-found") { setClosed(true); return; }
    schedule(r.code === "backpressure" ? Math.max(POLL_MS, (r.retryAfter || 10) * 1000) : POLL_MS);
  };
  const schedule = (ms) => { const st = state.current; clearTimeout(st.timer); if (st.live) st.timer = setTimeout(poll, ms); };
  useEffect(() => {
    state.current.live = true; poll();
    const vis = () => { if (typeof document !== "undefined" && !document.hidden) schedule(0); };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", vis);
    return () => { state.current.live = false; clearTimeout(state.current.timer); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", vis); };
  }, [room.id]);
  const send = async (e) => {
    e.preventDefault();
    const q = text.trim();
    if (busy || !q) return;
    setBusy(true); setMsg(null);
    const r = await hubClient().ask(room.id, newKey(), q);
    setBusy(false);
    if (!r.ok) { setMsg(errText(r)); if (r.code === "revoked") setClosed(true); return; }
    setText("");
    const seq = (state.current.entries.length ? state.current.entries[state.current.entries.length - 1].sequence : 0) + 1;
    merge([{ messageId: r.receipt.messageId, sequence: seq, receipt: r.receipt, question: q }]);
  };
  return html`<div class="hub-room">
    <div class="hub-room-head"><button type="button" class="btn btn-sm" onClick=${onBack}><${Icon} name="back" size=${14} />${hw("back")}</button>
      <h3>${room.exposureName || ""}</h3></div>
    <p class="note hub-identity">${hw("roomNote")}</p>
    <ol class="hub-entries">${entries.map((e) => html`<li key=${e.messageId} class="hub-entry">
      <div class="hub-q">${e.expired ? html`<em>${hw("expiredText")}</em>` : e.question ?? ""}</div>
      ${e.answer !== undefined ? html`<div class="hub-a">${e.answer}</div>`
        : html`<div class=${`hub-stage stage-${e.receipt ? e.receipt.stage : "queued"}`} role="status">${hw(STAGE[e.receipt && e.receipt.stage] || "stageQueued")}</div>`}
    </li>`)}</ol>
    ${closed ? html`<p class="err" role="alert">${hw("roomClosed")}</p>` : html`<form class="form hub-compose" onSubmit=${send}>
      <label class="field"><span class="sr-only">${hw("question")}</span><textarea id="hubQuestion" rows="3" maxlength="65536" placeholder=${hw("questionPh")}
        value=${text} onInput=${(e) => setText(e.target.value)}></textarea></label>
      <div class="field-row"><button type="submit" class="btn btn-primary" disabled=${busy || !text.trim()}>${hw("send")}</button></div>
    </form>`}
    ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
  </div>`;
}

// ── My exposures ──
function HubMine() {
  const [cat, reload] = useRead(() => hubClient().catalog());
  const [pairings, reloadPairings] = useRead(() => hubClient().pairings());
  const [msg, setMsg] = useState(null);
  const act = async (fn, after = reload) => {
    setMsg(null);
    const r = await fn();
    if (!r.ok) setMsg(errText(r));
    await after();
  };
  const confirmPairing = async (p) => {
    if (!(await confirmDialog({ message: hw("confirmPairingAsk", compareGroups(p.fingerprint)), confirmLabel: hw("confirmPairing") }))) return;
    await act(() => hubClient().confirmPairing(p.id, p.fingerprint), reloadPairings);
  };
  const pend = pairings && pairings.pairings ? pairings.pairings : [];
  const mine = cat && cat.mine ? cat.mine : [];
  return html`<div class="hub-mine">
    ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
    ${pend.length ? html`<section class="card hub-pairings"><h3>${hw("pairingsTitle")}</h3><p class="note">${hw("pairingsLead")}</p>
      <ul class="hub-list">${pend.map((p) => html`<li key=${p.id} class="hub-item">
        <div class="grow"><code class="hub-fp-groups">${compareGroups(p.fingerprint)}</code><small class="note">${hw("expires", when(p.expiresAt))}</small></div>
        ${p.ownerConfirmed ? html`<small>${hw("confirmed")}</small>` : html`<button type="button" class="btn btn-sm" onClick=${() => confirmPairing(p)}>${hw("confirmPairing")}</button>`}
      </li>`)}</ul></section>` : null}
    ${cat && cat.error ? html`<p class="err" role="alert">${cat.error}</p>` : null}
    ${cat && !cat.error && !mine.length ? html`<div class="center hub-empty"><${Empty} icon="globe" title=${hw("exposuresEmpty")} hint=${hw("exposuresHint")} /></div>` : null}
    ${mine.map((x) => html`<${HubExposureCard} key=${x.id} x=${x} act=${act} />`)}
  </div>`;
}

function HubExposureCard({ x, act }) {
  const [form, setForm] = useState({ login: "", days: 7 });
  const grant = (e) => {
    e.preventDefault();
    if (!form.login.trim()) return;
    act(() => hubClient().grant({ exposureId: x.id, exposureRevision: x.revision, login: form.login.trim(), days: form.days }).then((r) => { if (r.ok) setForm((f) => ({ ...f, login: "" })); return r; }));
  };
  const revoke = async (g) => {
    if (!(await confirmDialog({ message: hw("revokeAsk", g.subjectName || g.subjectLogin), confirmLabel: hw("revoke"), danger: true }))) return;
    act(() => hubClient().revokeGrant(g.id, g.revision));
  };
  const freeze = async () => {
    if (!(await confirmDialog({ message: hw("freezeAsk", x.displayName), confirmLabel: hw("freeze"), danger: true }))) return;
    act(() => hubClient().freeze(x.id, x.revision));
  };
  const shared = x.state === "published";
  return html`<section class=${`card hub-exposure-card${shared ? " is-shared" : ""}`}>
    <h3>${x.displayName} <span class=${`hub-badge state-${x.state}`}>${hw(`state_${x.state}`)}</span></h3>
    <p class="note">${hw("policy", x.dataViewId, (x.allowedTools || []).join(", ") || "—")} · ${hw("revision", x.revision)}</p>
    ${x.grants && x.grants.length ? html`<ul class="hub-list">${x.grants.map((g) => html`<li key=${g.id} class="hub-item">
      <div class="grow"><strong>${g.subjectName || g.subjectLogin}</strong>${g.subjectLogin ? html` <small><code>${g.subjectLogin}</code></small>` : null}
        <small class="note">${hw("until", when(g.expiresAt))}</small></div>
      <button type="button" class="btn btn-sm btn-danger" onClick=${() => revoke(g)}>${hw("revoke")}</button>
    </li>`)}</ul>` : html`<p class="note">${hw("noGrants")}</p>`}
    ${shared ? html`<form class="form hub-grant" onSubmit=${grant}>
      <label class="field"><span>${hw("grantLogin")}</span><input autocomplete="off" spellcheck=${false} autocapitalize="none" value=${form.login}
        onInput=${(e) => { const v = e.target.value; setForm((f) => ({ ...f, login: v })); }} /></label>
      <label class="field"><span>${hw("grantDays")}</span><select value=${String(form.days)} onChange=${(e) => { const v = Number(e.target.value); setForm((f) => ({ ...f, days: v })); }}>
        ${DAYS.map((d) => html`<option value=${String(d)}>${hw("days", d)}</option>`)}</select></label>
      <div class="field-row"><button type="submit" class="btn" disabled=${!form.login.trim()}>${hw("allow")}</button>
        <button type="button" class="btn btn-danger" onClick=${freeze}>${hw("freeze")}</button></div>
    </form>` : null}
  </section>`;
}

// ── Administration ──
function HubAdmin({ admin }) {
  if (!admin) return html`<div class="center hub-empty"><${Empty} icon="key" title=${hw("adminOnly")} hint=${hw("adminOnlyHint")} /></div>`;
  return html`<${HubAdminPage} />`;
}
function HubAdminPage() {
  const [view, reload] = useRead(() => hubClient().adminOverview());
  const [login, setLogin] = useState("");
  const [offer, setOffer] = useState(null);
  const [msg, setMsg] = useState(null);
  const create = async (e) => {
    e.preventDefault();
    if (!login.trim()) return;
    setMsg(null);
    const r = await hubClient().createPairing(login.trim());
    if (!r.ok) { setMsg(errText(r)); return; }
    setOffer({ code: r.code, expiresAt: r.expiresAt, login: login.trim() }); setLogin(""); reload();
  };
  const approve = async (p) => {
    if (!(await confirmDialog({ message: hw("approveAsk", compareGroups(p.fingerprint)), confirmLabel: hw("approve") }))) return;
    setMsg(null);
    const r = await hubClient().approvePairing(p.id, p.fingerprint);
    if (!r.ok) setMsg(errText(r));
    reload();
  };
  const revoke = async (f) => {
    if (!(await confirmDialog({ message: hw("revokeFleetAsk", f.owner ? f.owner.name : f.id), confirmLabel: hw("revoke"), danger: true }))) return;
    setMsg(null);
    const r = await hubClient().revokeFleet(f.id);
    if (!r.ok) setMsg(errText(r));
    reload();
  };
  const fleets = view && view.fleets ? view.fleets : [], pairings = view && view.pairings ? view.pairings : [];
  return html`<div class="hub-admin">
    ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
    <section class="card"><h3>${hw("pairTitle")}</h3><p class="note">${hw("pairLead")}</p>
      <form class="form" onSubmit=${create}>
        <label class="field"><span>${hw("pairOwner")}</span><input autocomplete="off" spellcheck=${false} autocapitalize="none" value=${login} onInput=${(e) => setLogin(e.target.value)} /></label>
        <div class="field-row"><button type="submit" class="btn" disabled=${!login.trim()}>${hw("pairCreate")}</button></div>
      </form>
      ${offer ? html`<div class="hub-offer" role="status"><p>${hw("pairCode", offer.login)}</p><code class="hub-code">${offer.code}</code>
        <small class="note">${hw("expires", when(offer.expiresAt))}</small></div>` : null}
    </section>
    ${pairings.length ? html`<section class="card"><h3>${hw("pendingPairings")}</h3><ul class="hub-list">${pairings.map((p) => html`<li key=${p.id} class="hub-item">
      <div class="grow"><strong>${p.owner ? p.owner.name : "—"}</strong>
        ${p.fingerprint ? html`<code class="hub-fp-groups">${compareGroups(p.fingerprint)}</code>` : html`<small class="note">${hw("codeUnused")}</small>`}
        <small class="note">${p.ownerConfirmed ? hw("ownerConfirmed") : hw("ownerWaiting")}</small></div>
      ${p.adminApproved ? html`<small>${hw("approved")}</small>`
        : html`<button type="button" class="btn btn-sm" disabled=${!p.fingerprint || !p.ownerConfirmed} onClick=${() => approve(p)}>${hw("approve")}</button>`}
    </li>`)}</ul></section>` : null}
    <section class="card"><h3>${hw("fleetsTitle")}</h3>
      ${fleets.length ? html`<ul class="hub-list">${fleets.map((f) => html`<li key=${f.id} class="hub-item">
        <div class="grow"><strong>${f.owner ? f.owner.name : "—"}</strong>${f.owner ? html` <small><code>${f.owner.login}</code></small>` : null}
          <small class="note">${hw(f.status === "active" ? "fleetActive" : "fleetRevoked")}</small></div>
        ${f.status === "active" ? html`<button type="button" class="btn btn-sm btn-danger" onClick=${() => revoke(f)}>${hw("revoke")}</button>` : null}
      </li>`)}</ul>` : html`<p class="note">${hw("noFleets")}</p>`}
    </section>
  </div>`;
}

/** Tests only: forget the page's session view. */
export function resetHubSession() { session = undefined; reading = null; watchingEnd = false; sessionSubs.clear(); }
