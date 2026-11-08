// AgEnD Hub P1, slice 3: the Hub workspace's pages — the chats (/ui/hub, a room at /ui/hub?room=<id>; #3226 B), My
// exposures and Administration (/ui/hub/exposures, /ui/hub/admin; reached from the session row's menu) — and its session row. Served only by a Hub's own listener at its own origin, over the Hub's /hub/v1/*
// API (hub-client.js createHubWebClient); nothing here reads or reaches a fleet. A lazy module: it imports only names
// every shell has had since #1408, so a tab opened before an upgrade loads it as fresh as the rest.
//
// What people see is what the server says now: every list is read fresh, every change is checked again by the server
// (who, the revision shown, the directory), and a conflict reloads the list instead of guessing.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { PanelHeader, closeDrawer, setTitle } from "/assets/app-shell.js";
import { lang, register, t } from "/assets/app-i18n.js";
import { createStore, useStore } from "/assets/app-store.js";
import { navigate, navStore } from "/assets/app-nav.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { Dialog } from "/assets/ui-dialog.js";
import { PairingNotices } from "./hub-quick-pairing.js";
import { Menu } from "/assets/ui-menu.js";
import { toast } from "/assets/ui-toast.js";
// #3226 B: the chat is the fleet chat's own drawing (PR A's shared modules), in the fleet chat's words.
import { createThread, msgKey } from "/assets/chat-thread.js";
import { PreviewPanel, closePanel, panelStore } from "/assets/preview-panel.js";
import { ComposerInput, WorkBarView, touchScreen } from "/assets/chat-composer.js";
import { RailFrame } from "/assets/side-rail.js";
import "/assets/chat-strings.js";
import { compareGroups, hubClient } from "./hub-client.js";
import { hw, linkHubCss } from "./hub-strings.js";
import { hc, linkHubChatCss } from "./hub-chat-strings.js";
import { ho, linkHubOwnerCss } from "./hub-owner-strings.js";
import { hg } from "./hub-grant-strings.js";
import { createHubChatStore } from "./hub-chat-store.js";
import { QuotaBanner, QuotaCard, QuotaChip, QuotaVisibilityRow } from "./hub-quota.js";
import { PageHead } from "/assets/page-head.js";
import { bindRoomFeedback, bootHubPreview, downloadHtml, draftWithLine, panelOpenFor, roomPanelKey, roomPanelOpts, setHubPreviewOptIn } from "./hub-preview.js";
import { PendingFiles, hf, pageCarriesFiles, roomTakesFiles, uploadChosen } from "./hub-attachments.js";
// #3298 S-89 (experimental): the group permissions editor and the signed-in welcome are their own LAZY modules, loaded only
// when the Hub's session says "group-policy-v1" and this tab's client has the calls — a Hub without them never serves or loads them.
// The one group-permissions sentence this module draws itself (shown when the lazy modules are NOT loaded: this Hub lacks them).
register("hubGroupsNote", {
  en: { unavailable: "Group permissions aren't available on this Hub yet. Update the Hub, then try again." },
  "zh-TW": { unavailable: "這個 Hub 還沒有群組權限。請更新 Hub 後再試。" },
});
const groupPolicyOn = (session, client) => !!session && Array.isArray(session.features) && session.features.includes("group-policy-v1")
  && !!client && client.groupPolicyV1 === true;
function LazyGroups({ pick, props }) {
  const [C, setC] = useState(null), [failed, setFailed] = useState(false);
  useEffect(() => { let live = true; Promise.all([import("./hub-welcome.js"), import("./hub-group-policy.js"), import("./hub-group-strings.js")])
    .then(([w, p, g]) => { if (live) setC(() => pick({ ...w, ...p, ...g })); }, () => { if (live) setFailed(true); }); return () => { live = false; }; }, []);
  return failed ? null : C ? html`<${C} ...${props} />` : html`<${Skeleton} variant="rows" lines=${3} />`;
}

const TITLES = { ask: "askTitle", exposures: "exposuresTitle", admin: "adminTitle" };
/** P1 room polling: at most once per ten seconds, one request at a time, paused while the page is hidden (hub.md §5). */
export const POLL_MS = 10_000;
const DAYS = [1, 7, 30, 90];

/** #3226 B: the person's open rooms, as the conversation list shows them: { loaded, rooms, error }. */
const roomsStore = createStore({ loaded: false, rooms: [], error: null });
let roomsReading = null;
// The page's one view of the Hub session, shared by the panel and the sidebar's session row.
let session;                                     // undefined: not read yet; null: signed out; else the session
const sessionSubs = new Set();
function setSession(next) {
  const was = session;
  session = next;
  // #3226 B: the conversation list is this person's: cleared when no one is signed in, read again when someone is.
  if (!next) roomsStore.set({ loaded: false, rooms: [], error: null });
  else if (!was || was.login !== next.login) void refreshRooms();
  for (const fn of sessionSubs) { try { fn(next); } catch { /* a subscriber's own failure */ } }
}
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

export function HubPanel({ route }) {
  const tab = TITLES[route && route.tab] ? route.tab : "ask";
  const s = useSession();
  useEffect(() => { linkHubCss(); if (tab === "ask") linkHubChatCss(); }, [tab]);
  useEffect(() => { setTitle(hw(TITLES[tab])); }, [tab]);
  let body = tab === "ask" ? roomParam() ? html`<${HubRoomLoading} />`
    : html`<${PanelHeader} title=${hc("chats")} /><div class="hub-home"><${Skeleton} variant="rows" lines=${4} /></div>`
    : html`<${Skeleton} variant="rows" lines=${4} />`;
  // Signed out: the sign-in page alone (no panel header, no chat chrome).
  if (s === null) return html`<div data-effect-panel="hub" class="panel p-hub p-hub-signin"><${HubSignIn} /></div>`;
  if (s) body = tab === "ask" ? html`<${HubChats} />` : tab === "exposures" ? html`<${HubMine} />` : html`<${HubAdmin} admin=${!!s.admin} />`;
  const notices = s?.features?.includes("quick-pairing-v1") && hubClient().quickPairingV1 ? html`<${PairingNotices} admin=${!!s.admin} />` : null;
  // The chats draw their own header (the room's); the other pages keep the panel's.
  if (s !== null && tab === "ask") return html`<div data-effect-panel="hub" class="panel p-hub p-hub-ask"><div data-trust="panel-content" class="panel-body hub-chat-body">${notices}${body}</div></div>`;
  // #3226 C: My shared agents and Administration are Settings-like pages (their own PageHead under the panel's header).
  const pageTitle = tab === "exposures" ? hc("mine") : tab === "admin" ? hc("admin") : hw(TITLES[tab]);
  return html`<div data-effect-panel="hub" class=${`panel p-hub p-hub-${tab}`}>
    <${PanelHeader} title=${s ? pageTitle : hw(TITLES[tab])} />
    <div data-trust="panel-content" class=${`panel-body ${s ? "hub-page-body" : "hub-body"}`}>${notices}${body}</div>
  </div>`;
}

/** The sidebar's session row: who is signed in to this Hub, and Sign out. */
export function HubSessionMenu() {
  const s = useSession();
  const [busy, setBusy] = useState(false);
  if (s === undefined) return html`<div class="session hub-session"><${Skeleton} variant="inline" lines=${1} /></div>`;
  if (!s) return html`<div class="session hub-session"><span class="side-row"><span class="dot" aria-hidden="true"></span><span class="grow">${hw("signedOutHub")}</span></span></div>`;
  const out = async () => { setBusy(true); await hubClient().signOut(); setBusy(false); setSession(null); };
  // #3226 B: My shared agents and Administration are secondary — in this menu, not the main surface.
  const items = [
    { key: "mine", label: hc("mine"), icon: "globe", onSelect: () => navigate("/ui/hub/exposures") },
    { key: "admin", label: hc("admin"), icon: "key", onSelect: () => navigate("/ui/hub/admin") },
    { key: "out", label: hw("signOut"), icon: "user", onSelect: out, disabled: busy },
  ];
  return html`<div class="session hub-session">
    <span class="side-row"><span class="dot ok" aria-hidden="true"></span><span class="grow">${s.displayName}</span></span>
    <${Menu} items=${items} label=${hc("menu")} icon="settings" cls="hub-menu" />
  </div>`;
}

/**
 * alpha.6 feedback: the signed-out Hub is a sign-in page, in AgEnD's own sign-in style (signin.html: one centred card
 * on the page's background, the brand, the fields, a primary button) — none of the chat app around it: while it is on
 * screen the shell's sidebar and tabs are hidden (not just covered, so focus and screen readers skip them too).
 * Its stylesheet is its own (/assets/hub-signin.css): a tab holding an older hub.css still draws it.
 */
function linkHubSigninCss(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector('link[data-hub-signin-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/hub-signin.css"); link.setAttribute("data-hub-signin-css", "1");
    doc.head.appendChild(link);
  } catch { /* the page still works without it */ }
}
function HubSignIn() {
  useEffect(() => {
    linkHubSigninCss();
    // #3318 review F1: signed out from the phone drawer's session menu (or a session that ended while it was open), the
    // drawer would stay open with <main> inert under it — and this page, inside <main>, would take no input while the
    // sidebar and scrim that used to close it are hidden or covered. The sign-in page closes it.
    closeDrawer();
    const body = typeof document !== "undefined" ? document.body : null;
    if (body) body.classList.add("hub-signed-out");
    return () => { if (body) body.classList.remove("hub-signed-out"); };
  }, []);
  const name = typeof document !== "undefined" ? (document.body.dataset.hubName || "") : "";
  const [form, setForm] = useState({ login: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    // The button is always ready (a disabled one reads as grey, "broken"): an empty field just takes the focus.
    if (!form.login.trim() || !form.password) {
      const doc = typeof document !== "undefined" ? document : null;
      doc?.getElementById(!form.login.trim() ? "hubLogin" : "hubPassword")?.focus();
      return;
    }
    setBusy(true); setMsg(null);
    const r = await hubClient().signIn(form.login.trim(), form.password);
    setBusy(false);
    if (r.ok) { setForm({ login: "", password: "" }); setSession(r); return; }
    setForm((f) => ({ ...f, password: "" }));
    setMsg(r.code === "backpressure" ? hw("errBusyHub") : r.code === "unavailable" ? hw("errDirectory") : hw("errSignIn"));
  };
  return html`<main class="hub-signin-page"><section class="hub-signin hub-signin-card" aria-labelledby="hubSignInTitle">
    <div class="hub-signin-brand"><strong>${t("hubShell.brand")}</strong>${name ? html`<span>${name}</span>` : null}</div>
    <h1 id="hubSignInTitle">${hw("signInTitle")}</h1>
    <p class="hub-signin-lead">${hw("signInLead")}</p>
    <form class="hub-signin-form" onSubmit=${submit}>
      <label for="hubLogin">${hw("login")}</label>
      <input id="hubLogin" autocomplete="username" spellcheck=${false} autocapitalize="none"
        value=${form.login} onInput=${(e) => { const v = e.target.value; setForm((f) => ({ ...f, login: v })); }} />
      <label for="hubPassword">${hw("password")}</label>
      <input id="hubPassword" type="password" autocomplete="current-password"
        value=${form.password} onInput=${(e) => { const v = e.target.value; setForm((f) => ({ ...f, password: v })); }} />
      <button type="submit" class="hub-signin-go" disabled=${busy}>${hw("signIn")}</button>
    </form>
    <p class="hub-signin-msg" role=${msg ? "alert" : undefined}>${msg || ""}</p>
  </section></main>`;
}

/** Load a list from the client; `reload` reads it again. null while loading, { error } on failure. */
function useRead(read) {
  const [data, setData] = useState(null);
  const live = useRef(true);
  const failed = (error) => { if (live.current) setData((old) => ({ ...old, error })); };
  const reload = () => read().then((r) => { if (live.current) { if (r.ok) setData(r); else failed(errText(r)); } }, () => failed(hw("errFailed")));
  useEffect(() => { live.current = true; reload(); return () => { live.current = false; }; }, []);
  return [data, reload];
}

// ── Chats (#3226 B): the conversation list, one room's chat, and the right-hand panel ──
// The list is the shell's sidebar (HubNav, below) on a wide screen and the page itself on a phone; a room is
// /ui/hub?room=<id>. The thread, the composer row, the WorkBar and the rail frame are the fleet chat's own modules
// (/assets/chat-thread.js, chat-composer.js, side-rail.js); the room's data is hub-chat-store.js's.

/** The person's open rooms, as the list shows them: { loaded, rooms, error }; read on demand and every ROOMS_MS. */
export const ROOMS_MS = 30_000;
export function refreshRooms() {
  return roomsReading ??= hubClient().rooms().then((r) => {
    // With group permissions on, a person whose groups don't include chatting is refused the list: that is their access, shown
    // by the welcome, not a failure (Cairn #3372) — the list stays empty and quiet. Every chat action still asks the server.
    if (!r.ok && (r.code === "denied" || r.code === "revoked") && groupPolicyOn(session, hubClient())) roomsStore.set({ loaded: true, rooms: [], error: null, denied: true });
    else roomsStore.set(r.ok ? { loaded: true, rooms: r.rooms || [], error: null } : { ...roomsStore.get(), loaded: true, error: errText(r) });
  }, () => roomsStore.set({ ...roomsStore.get(), loaded: true, error: hw("errFailed") })).finally(() => { roomsReading = null; });
}
/** Keeps the list fresh while something shows it (every ROOMS_MS, paused while the page is hidden). */
function useRooms() {
  const rs = useStore(roomsStore);
  useEffect(() => {
    if (!roomsStore.get().loaded && session) refreshRooms();
    const tick = setInterval(() => { if (session && (typeof document === "undefined" || !document.hidden)) refreshRooms(); }, ROOMS_MS);
    return () => clearInterval(tick);
  }, []);
  return rs;
}
const roomParam = () => { try { const v = new URLSearchParams(location.search).get("room"); return v && /^[a-f0-9-]{36}$/.test(v) ? v : null; } catch { return null; } };
const roomPath = (id) => `/ui/hub?room=${encodeURIComponent(id)}`;
const initial = (name) => (String(name || "?").trim()[0] || "?").toUpperCase();
const AV_TONES = 6;
const tone = (name) => { let h = 0; for (const c of String(name || "")) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % AV_TONES; };
function Avatar({ name, size = "" }) { return html`<span class=${`hub-av t${tone(name)} ${size}`} aria-hidden="true">${initial(name)}</span>`; }
const listTime = (ms) => {
  if (!ms) return "";
  const d = new Date(ms), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
};
const dateOnly = (ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
function daysLeft(ms) {
  const d = Math.ceil((ms - Date.now()) / 86_400_000);
  return d <= 0 ? hc("endsToday") : d === 1 ? hc("dayLeft") : hc("daysLeft", d);
}

/** The conversation list: New chat, a filter, and one row per open room (the most recently active first). */
export function HubNav({ onPick } = {}) {
  const s = useSession();
  const rs = useRooms();
  const [q, setQ] = useState("");
  const [picking, setPicking] = useState(false);
  useEffect(() => { linkHubChatCss(); }, []);
  if (!s) return null;
  const current = roomParam();
  const shown = rs.rooms.filter((r) => !q.trim() || `${r.exposureName} ${r.ownerName}`.toLowerCase().includes(q.trim().toLowerCase()));
  const pick = (e, r) => { if (onPick) onPick(); if (e && (e.metaKey || e.ctrlKey)) return; e && e.preventDefault(); navigate(roomPath(r.id)); };
  return html`<div class="hub-nav">
    <button type="button" class="btn hub-new" onClick=${() => setPicking(true)}><${Icon} name="plus" size=${16} />${hc("newChat")}</button>
    <label class="hub-search"><${Icon} name="search" size=${14} /><input type="search" placeholder=${hc("search")} aria-label=${hc("search")} value=${q}
      onInput=${(e) => setQ(e.target.value)} /></label>
    <div class="hub-sec">${hc("chats")}</div>
    ${rs.error ? html`<${ErrorState} message=${rs.error} onRetry=${refreshRooms} />` : null}
    ${!rs.loaded ? html`<${Skeleton} variant="rows" lines=${4} />` : null}
    ${rs.loaded && !rs.error && !rs.denied && !rs.rooms.length ? html`<p class="note hub-list-empty">${hc("noChatsHint")}</p>` : null}
    ${rs.rooms.length && !shown.length ? html`<p class="note hub-list-empty">${hc("noMatch")}</p>` : null}
    <ul class="hub-rooms" role="list">${shown.map((r) => html`<li key=${r.id}>
      <a class=${`hub-room-row${current === r.id ? " active" : ""}${r.state === "closed" ? " closed" : ""}`} href=${roomPath(r.id)} aria-current=${current === r.id ? "page" : undefined} onClick=${(e) => pick(e, r)}>
        <${Avatar} name=${r.exposureName} />
        <span class="hub-room-text"><span class="t">${r.exposureName}</span><span class="s">${r.state === "closed" ? hc("tagClosed") : r.waiting ? hc("waiting") : r.ownerName ? hc("represents", r.ownerName) : ""}</span></span>
        <span class="hub-room-side"><span class="time">${listTime(r.lastAt)}</span>${r.waiting ? html`<span class="pulse" title=${hc("waiting")}></span>` : null}</span>
      </a></li>`)}</ul>
    ${picking ? html`<${NewChatDialog} onClose=${() => setPicking(false)} />` : null}
  </div>`;
}

/** New chat: the agents someone allowed this person to ask; Ask opens (or reopens) its room. */
function NewChatDialog({ onClose }) {
  const [cat, reload] = useRead(() => hubClient().catalog());
  const rs = useStore(roomsStore);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const open = async (it) => {
    if (busy) return;
    setBusy(true); setMsg(null);
    const r = await hubClient().openRoom(it.exposure.id, it.grant.id);
    setBusy(false);
    if (!r.ok) { setMsg(errText(r)); return; }
    onClose(); await refreshRooms(); navigate(roomPath(r.room.id));
  };
  const all = cat && cat.askable ? cat.askable : [];
  const shown = all.filter((it) => !q.trim() || `${it.exposure.displayName} ${it.ownerName}`.toLowerCase().includes(q.trim().toLowerCase()));
  const hasRoom = (it) => rs.rooms.some((r) => r.exposureId === it.exposure.id && r.grantId === it.grant.id);
  return html`<${Dialog} title=${hc("pickTitle")} onClose=${onClose}>
    <div class="hub-pick">
      <label class="field"><span class="sr-only">${hc("pickSearch")}</span><input type="search" placeholder=${hc("pickSearch")} value=${q} onInput=${(e) => setQ(e.target.value)} /></label>
      ${!cat ? html`<${Skeleton} variant="rows" lines=${4} />` : cat.error ? html`<${ErrorState} message=${cat.error} onRetry=${reload} />` : null}
      ${cat && !cat.error && !all.length ? html`<${Empty} icon="chat" title=${hc("pickEmpty")} hint=${hw("askHint")} />` : null}
      ${all.length && !shown.length ? html`<p class="note">${hc("pickNone")}</p>` : null}
      <ul class="hub-pick-list" role="list">${shown.map((it) => html`<li key=${it.grant.id} class="hub-pick-row">
        <${Avatar} name=${it.exposure.displayName} />
        <span class="hub-room-text"><span class="t">${it.exposure.displayName}</span><span class="s">${hc("pickUntil", it.ownerName || "—", dateOnly(it.grant.expiresAt))}</span></span>
        <button type="button" class=${`btn btn-sm${hasRoom(it) ? "" : " btn-primary"}`} disabled=${busy} onClick=${() => open(it)}>${hasRoom(it) ? hc("pickOpen") : hc("pickAsk")}</button>
      </li>`)}</ul>
      <p class="note">${hc("pickHint")}</p>
      ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
    </div>
  </${Dialog}>`;
}

/** The Ask tab: the chosen room, or (none chosen) the list on a phone and a "pick a chat" note beside it on a wide screen. */
function HubChats() {
  useStore(navStore);                               // ?room= changes without a new route
  const rs = useRooms();
  const s = useSession();
  const [picking, setPicking] = useState(false);
  useEffect(() => { linkHubChatCss(); }, []);
  const id = roomParam();
  const room = id ? rs.rooms.find((r) => r.id === id) || (rs.loaded ? { id, exposureName: "", ownerName: "", features: [] } : null) : null;
  if (id && room) return html`<${HubRoomView} key=${id} room=${room} />`;
  if (id) return html`<${HubRoomLoading} error=${rs.error} />`;
  return html`<${PanelHeader} title=${hc("chats")} />
  <div class=${`hub-home${groupPolicyOn(s, hubClient()) ? " has-welcome" : ""}`}>
    <div class="hub-home-list"><${HubNav} /></div>
    ${groupPolicyOn(s, hubClient()) ? html`<div class="hub-home-pick hub-home-welcome"><${LazyGroups} pick=${(m) => m.HubWelcome} props=${{ name: s.displayName, quick: s.features.includes("quick-pairing-v1"), onChats: () => setPicking(true) }} /></div>`
      : html`<div class="hub-home-pick center">${!rs.loaded ? html`<${Skeleton} variant="rows" lines=${4} />` : rs.error && !rs.rooms.length ? html`<${ErrorState} message=${rs.error} onRetry=${refreshRooms} />` : !rs.rooms.length
      ? html`<${Empty} icon="chat" title=${hc("noChats")} hint=${hc("noChatsHint")} />`
      : html`<${Empty} icon="chat" title=${hc("choose")} hint=${hc("chooseHint")} />`}</div>`}
    ${picking ? html`<${NewChatDialog} onClose=${() => setPicking(false)} />` : null}
  </div>`;
}

const RAIL_KEY = "agend_hub_context";
const railOpen = () => { try { return localStorage.getItem(RAIL_KEY) !== "0"; } catch { return true; } };
const setRailPref = (open) => { try { localStorage.setItem(RAIL_KEY, open ? "1" : "0"); } catch { /* not remembered */ } };
const wideQuery = () => (typeof matchMedia === "function" ? matchMedia("(min-width: 1100px)") : null);
function useWide() {
  const [wide, setWide] = useState(() => !!wideQuery()?.matches);
  useEffect(() => { const q = wideQuery(); if (!q) return undefined; const on = () => setWide(!!q.matches); q.addEventListener?.("change", on); return () => q.removeEventListener?.("change", on); }, []);
  return wide;
}
/** The same room frame while its metadata is unknown: reserve the saved context rail and header width. */
function HubRoomLoading({ error } = {}) {
  const wide = useWide(), [rail, setRail] = useState(railOpen);
  const showRail = wide && rail;
  return html`<div class=${`hub-chat${showRail ? " with-rail" : ""}`}>
    <section class="hub-chat-main"><header class="hub-chat-head"><${Skeleton} variant="inline" lines=${1} /></header>
      <div class="scroller hub-scroller hub-room-loading">${error ? html`<${ErrorState} message=${error} onRetry=${refreshRooms} />` : html`<${Skeleton} variant="rows" lines=${6} />`}</div>
    </section>
    ${showRail ? html`<${RailFrame} trust="hub-context" label=${hc("infoLabel")} title=${hc("info")} closeLabel=${hc("hideInfo")}
      onClose=${() => { setRail(false); setRailPref(false); }}><${Skeleton} variant="rows" lines=${4} /></${RailFrame}>` : null}
  </div>`;
}
/** The thread's words are the fleet chat's; its delivery marks say the Hub's stages. */
const threadT = (key, ...a) => (key.startsWith("chat.tick_") ? hc(key.slice(5), ...a) : t(key, ...a));
const REASONS = { expired: "reason_expired", revoked: "reason_revoked", frozen: "reason_frozen", withdrawn: "reason_withdrawn" };
const reasonText = (code, stage) => (stage === "uncertain" ? hc("uncertain") : hc("notAnswered", hc(REASONS[code] || "reason_unknown")));
async function copyText(text) { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }

/** One room: its header, the thread, what blocks asking, the working line and the composer; the panel beside it. */
function HubRoomView({ room: given }) {
  const s = useSession();
  const wide = useWide();
  const store = useMemo(() => createHubChatStore(given, { me: (s && s.displayName) || "", reason: reasonText }), [given.id]);
  useEffect(() => () => store.stop(), [store]);
  const [, tick] = useState(0);
  useEffect(() => {
    // The list's "waiting" follows this room: read again when a question starts or stops waiting here.
    let was = null;
    const update = () => {
      tick((n) => n + 1);
      const waiting = store.entries().some((e) => ["queued", "delivered", "consumed"].includes(e.receipt && e.receipt.stage));
      if (was !== null && waiting !== was) {
        // The row says so at once; the list is read again behind it.
        roomsStore.set((rs) => ({ ...rs, rooms: rs.rooms.map((r) => (r.id === given.id ? { ...r, waiting } : r)) }));
        void refreshRooms();
      }
      was = waiting;
    };
    const off = store.subscribe(update); update();
    return off;
  }, [store]);
  // The store's room starts as the list's and is the server's latest after each read (its quota included or withdrawn).
  const room = store.room();
  const [rail, setRail] = useState(railOpen);
  const [sheet, setSheet] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState(null);
  // #3226 D: files chosen for the next question (uploaded at once; Send names the uploaded ids).
  const [files, setFilesState] = useState([]);
  const filesRef = useRef([]);
  const setFiles = (next) => { filesRef.current = next; setFilesState(next); };
  // Uploads still queued when the room is left are not started.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const input = useRef(null);
  useEffect(() => { setTitle(room.exposureName || hw("askTitle")); }, [room.exposureName]);
  // #3226 E: the side panel for this room's HTML pages (the fleet's panel). Its "Reply about this page" / Point at it
  // lines go into this composer; leaving the room closes it.
  const split = useRef(null), threadRef = useRef(null);
  const panelKey = roomPanelKey(given.id);
  const [panelOpen, setPanelOpen] = useState(() => panelOpenFor(panelKey));
  useEffect(() => { bootHubPreview(); }, []);
  useEffect(() => {
    setPanelOpen(panelOpenFor(panelKey));
    const off = panelStore.subscribe(() => setPanelOpen(panelOpenFor(panelKey)));
    const release = bindRoomFeedback({
      findMsg: (key) => store.messages().find((x) => msgKey(x) === key) || null,
      addLine: (line) => setDraft((d) => draftWithLine(d, line)),
      focus: () => {
        const el = input.current; if (!el) return;
        el.focus();
        setTimeout(() => { try { const n = el.value.length; el.setSelectionRange(n, n); } catch { /* not a text field */ } }, 0);
      },
    });
    return () => { off(); release(); };
  }, [store]);
  const closed = store.closed() || room.state === "closed";
  const frozen = !closed && room.exposureState === "frozen";
  const working = store.working();
  const name = room.exposureName || "";
  const client = hubClient();
  const pageFiles = pageCarriesFiles(client, store);
  const takesFiles = pageFiles && roomTakesFiles(room) && !closed && !frozen;
  const uploading = files.some((f) => f.state === "uploading");
  const send = async () => {
    const q = draft.trim();
    if (!q || sending || closed || frozen) return;
    if (uploading) { setMsg(hf("waitUpload")); return; }
    // Chosen files are never dropped quietly: while the room can't take them, the question waits (or they are removed).
    const chosen = filesRef.current.filter((f) => f.state === "ready");
    if (chosen.length && !takesFiles) { setMsg(hf("held")); return; }
    setSending(true); setMsg(null);
    const r = await store.send(q, chosen.length ? { files: chosen.map((f) => f.id) } : {});
    setSending(false);
    if (!r.ok) { setMsg(errText(r)); return; }
    // Only the files this question carried; ones chosen while it was on its way stay for the next.
    const sent = new Set(chosen.map((f) => f.key));
    setDraft(""); setFiles(filesRef.current.filter((f) => !sent.has(f.key))); refreshRooms();
  };
  const attach = takesFiles ? { title: hf("attach"), onFiles: async (list) => {
    setMsg(null);
    const refused = await uploadChosen(client, room.id, list, { current: () => filesRef.current, set: setFiles, alive: () => alive.current });
    if (!alive.current) return;
    if (refused.length) setMsg(refused.join(" "));
  } } : null;
  const onKeyDown = (e) => { if (globalThis.AgendChatRender?.composerKey(e, { touch: touchScreen() }) === "send") { e.preventDefault(); send(); } };
  const toggleInfo = () => {
    if (!wide) { setSheet(true); return; }
    // The panel is where the rail was: the info button puts the rail back (and closes the page).
    if (panelOpen) { closePanel(); setRail(true); setRailPref(true); return; }
    setRail((v) => { setRailPref(!v); return !v; });
  };
  const tag = closed ? html`<span class="tag danger">${hc("tagClosed")}</span>` : frozen ? html`<span class="tag warn">${hc("tagFrozen")}</span>`
    : html`<${QuotaChip} room=${room} fallback=${html`<span class="tag ok">${hc("tagCanAsk")}</span>`} />`;
  const back = !wide ? html`<a class="icon-btn hub-back" href="/ui/hub" aria-label=${hc("back")} title=${hc("back")}><${Icon} name="back" /></a>` : null;
  const info = html`<${HubRoomInfo} room=${room} closed=${closed} />`;
  // The panel takes the info rail's place while it shows a page (the rail's button brings the rail back).
  const showRail = wide && rail && !panelOpen;
  return html`<div class=${`hub-chat${showRail ? " with-rail" : ""}`} ref=${split}>
    <section class="hub-chat-main" aria-label=${name}>
      <header class="hub-chat-head" data-trust="panel-content">${back}<${Avatar} name=${name} size="sm" />
        <span class="hub-chat-title"><strong>${name}</strong><span class="s">${room.ownerName ? hc("answersFor", room.ownerName) : ""}</span></span>
        ${tag}
        <button type="button" class="icon-btn" aria-pressed=${wide ? String(showRail) : undefined} aria-label=${hc("showInfo")} title=${hc("showInfo")} onClick=${toggleInfo}><${Icon} name="info" /></button>
      </header>
      <${HubThread} store=${store} name=${name} panelKey=${panelKey} threadRef=${threadRef} />
      <div class="dock hub-dock" data-trust="composer"><div class="dock-col">
        ${closed ? html`<p class="hub-banner danger" role="status">${hc("closed")}</p>` : null}
        ${frozen ? html`<p class="hub-banner warn" role="status">${hc("frozen", name)}</p>` : null}
        ${!closed ? html`<${QuotaBanner} room=${room} />` : null}
        ${working ? html`<${HubWorkBar} name=${name} since=${working.since} />` : null}
        ${!closed && !frozen && !takesFiles ? html`<p class="note hub-files-off" role="status">${hf(pageFiles ? "off" : "reload")}</p>` : null}
        ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
        ${closed ? null : html`<div class="composer-box"><${PendingFiles} files=${files} onRemove=${(key) => setFiles(filesRef.current.filter((f) => f.key !== key))}
          formatSize=${(n) => (globalThis.AgendChatRender?.formatSize ? globalThis.AgendChatRender.formatSize(n) : `${n} B`)} />
          <${ComposerInput} inputRef=${input} value=${draft} placeholder=${hc("composer", name)} onValue=${setDraft}
          onKeyDown=${onKeyDown} onPaste=${() => {}} attach=${attach}
          stop=${{ hidden: true, disabled: true, title: hc("stop"), label: hc("stop"), onClick: () => {} }}
          send=${{ hidden: false, disabled: !draft.trim() || sending || frozen || uploading, label: hc("send"), onClick: send }} /></div>`}
        ${closed ? null : html`<div class="composer-row"><span class="hint hub-identity">${hw("roomNote")}</span></div>`}
      </div></div>
    </section>
    <${PreviewPanel} name=${panelKey} split=${split} msgs=${() => store.messages()} subscribe=${(fn) => store.subscribe(() => fn(panelKey, "msgs"))}
      keyOf=${msgKey} reveal=${(k) => threadRef.current && threadRef.current.reveal(k)} download=${downloadHtml} allow=${(commit) => setHubPreviewOptIn(true, commit)} />
    ${showRail ? html`<${RailFrame} trust="hub-context" label=${hc("infoLabel")} title=${hc("info")} closeLabel=${hc("hideInfo")}
      onClose=${() => { setRail(false); setRailPref(false); }}>${info}</${RailFrame}>` : null}
    ${!wide && sheet ? html`<${Dialog} title=${hc("info")} label=${hc("infoLabel")} onClose=${() => setSheet(false)}><div class="hub-rail-sheet">${info}</div></${Dialog}>` : null}
  </div>`;
}

function HubWorkBar({ name, since }) {
  const [, tick] = useState(0);
  useEffect(() => { const h = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(h); }, []);
  const R = globalThis.AgendChatRender;
  return html`<${WorkBarView} kind="working" label=${hc("working", name)} elapsed=${R && since ? R.formatElapsed(Math.max(0, Date.now() - since)) : ""} elapsedTitle=${hc("elapsed")} />`;
}

/** The thread: the fleet chat's own (createThread), fed by the room's store. */
function HubThread({ store, name, panelKey, threadRef }) {
  const scroller = useRef(null), host = useRef(null);
  const [jump, setJump] = useState({ show: false, unseen: 0 });
  const [empty, setEmpty] = useState(false);
  const th = useRef(null);
  const loaded = typeof store.loaded === "function" ? store.loaded() : true;
  useLayoutEffect(() => {
    const doc = host.current.ownerDocument;
    const list = doc.createElement("div");
    list.className = "thread"; list.setAttribute("role", "log"); list.setAttribute("aria-live", "off"); list.setAttribute("aria-label", name);
    const thread = createThread(list, doc.createElement("div"), {
      t: threadT, tf: threadT, isUser: (x) => x.role === "user", onJump: setJump, onEmpty: setEmpty, canReply: () => false,
      // #3226 E: an HTML page opens in the room's side panel, at the Hub's own preview address (hub-preview.js).
      setPreviewOptIn: setHubPreviewOptIn, copyText, download: downloadHtml, toggleWrap: () => {}, notice: (text) => toast(text, false),
      panel: roomPanelOpts(panelKey),
      clickReplyButton: (id, index) => { void store.clickButton(id, index).then((r) => {
        if (!r.ok && r.code !== "busy" && r.code !== "stopped") { toast(errText(r), false); store.refresh(); }
      }); },
      replyButtonBusy: (id) => store.busy(id), pollMine: (id) => store.mine(id), serverNow: () => Date.now(),
      retryOutgoing: () => {}, deleteOutgoing: () => {}, putBackOutgoing: () => {}, startReply: () => {}, findQuoted: () => null,
      emojis: () => false, mentions: () => null,
    });
    th.current = thread;
    if (threadRef) threadRef.current = thread;
    host.current.append(list);
    thread.attach(scroller.current);
    thread.render(store.messages());
    const off = store.subscribe(() => thread.render(store.messages()));
    // A card shows whether this browser allows previews and whether the panel has its page.
    const P = globalThis.AgendPreview;
    const offOpt = P && typeof P.onChange === "function" ? P.onChange(() => thread.refreshCards()) : () => {};
    const offPanel = panelStore.subscribe(() => thread.refreshCards());
    const sc = scroller.current;
    const onScroll = () => thread.onScroll();
    sc.addEventListener("scroll", onScroll, { passive: true });
    list.addEventListener("click", thread.onClick);
    return () => {
      off(); offOpt(); offPanel(); sc.removeEventListener("scroll", onScroll); list.removeEventListener("click", thread.onClick);
      thread.dispose(true); list.remove(); th.current = null; if (threadRef && threadRef.current === thread) threadRef.current = null;
    };
  }, [store]);
  return html`<div class="scroller hub-scroller" ref=${scroller}>
    <div class="thread-host" ref=${host}></div>
    ${/* #3145: that every asker shares the agent's one conversation is said before anyone types. */ ""}
    ${!loaded && !store.error() && !store.closed() ? html`<${Skeleton} variant="rows" lines=${5} />` : null}
    ${!loaded && store.error() ? html`<${ErrorState} message=${errText({ code: store.error() })} onRetry=${() => store.refresh()} />` : null}
    ${empty && loaded && !store.closed() ? html`<div class="center hub-room-empty"><${Empty} icon="chat" title=${hc("emptyRoom", name)} hint=${`${hc("emptyRoomHint", store.room().ownerName || name)}${lang() === "zh-TW" ? "" : " "}${hw("roomShared")}`} /></div>` : null}
    <div class="jump-dock">${jump.show ? html`<button data-trust="thread-control" type="button" class="jump-latest" onClick=${() => th.current && th.current.jumpLatest()}>
      <${Icon} name="down" size=${16} />${jump.unseen > 0 ? t("chat.newBelow", jump.unseen) : t("chat.jumpLatest")}</button>` : null}</div>
  </div>`;
}

/** The right-hand panel's cards (the usage rail's look): the agent, its quota (G), your access, who sees it, what is not here. */
function HubRoomInfo({ room, closed = false }) {
  const name = room.exposureName || "", owner = room.ownerName || "";
  return html`<section class="u-provider hub-card hub-agent-card"><${Avatar} name=${name} size="lg" /><strong>${name}</strong>
      ${owner ? html`<span class="note">${hc("answersFor", owner)}</span>` : null}</section>
    <${QuotaCard} room=${room} />
    ${room.grantExpiresAt && !closed ? html`<section class="u-provider hub-card"><div class="u-head"><strong>${hc("yourAccess")}</strong></div>
      <dl class="hub-kv"><dt>${hc("canDo")}</dt><dd>${hc("canDoValue")}</dd><dt>${hc("until")}</dt><dd>${dateOnly(room.grantExpiresAt)} <span class="tag">${daysLeft(room.grantExpiresAt)}</span></dd></dl>
    </section>` : null}
    <section class="u-provider hub-card"><div class="u-head"><strong>${hc("whoSees")}</strong></div>
      <ul class="hub-aud" role="list">
        <li><${Icon} name="user" size=${16} /><span><b>${hc("you")}</b><br />${hc("youSee")}</span></li>
        ${owner ? html`<li><${Icon} name="eye" size=${16} /><span><b>${owner}</b><br />${hc("ownerSees", owner)}</span></li>` : null}
        <li><${Icon} name="chat" size=${16} /><span><b>${name}</b><br />${hc("agentShares")}</span></li>
        <li><${Icon} name="key" size=${16} /><span><b>${hc("adminTitle")}</b><br />${hc("adminSees")}</span></li>
      </ul></section>
    <section class="u-provider hub-card"><div class="u-head"><strong>${hc("notHere")}</strong></div>
      <p class="note">${hc("notHereText", name, owner || name)}</p></section>
    <p class="note hub-p1">${hc("oneToOne")}</p>`;
}

// ── My shared agents and Administration (#3226 C): Settings' page layout (PageHead, .s-section-layout cards, .s-row
// rows), a destructive step behind a row's menu and a confirmation ──
const DAYS_LEFT = (ms) => daysLeft(ms);
const stateTag = (state) => state === "published" ? html`<span class="tag ok">${ho("stateShared")}</span>`
  : state === "frozen" ? html`<span class="tag warn">${ho("statePaused")}</span>` : html`<span class="tag">${ho("stateWithdrawn")}</span>`;
const mayAsk = (n) => (n === 0 ? ho("mayAskNone") : n === 1 ? ho("mayAskOne") : ho("mayAsk", n));
const agentParam = () => { try { const v = new URLSearchParams(location.search).get("agent"); return v && /^[a-f0-9-]{36}$/.test(v) ? v : null; } catch { return null; } };

/**
 * The owner's recent questions for one agent. Through the client's own method when it has one; a tab that loaded B's
 * hub-client.js before C has none, so the same GET is made here (same origin, the Hub's cookie; #3261 review).
 */
function readActivity(exposureId) {
  const c = hubClient();
  if (typeof c.activity === "function") return c.activity(exposureId);
  return fetch(`/hub/v1/exposures/${encodeURIComponent(exposureId)}/activity`, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } })
    .then(async (r) => { let j = null; try { j = await r.json(); } catch { /* not JSON */ } return r.ok && j ? { ok: true, ...j } : { ok: false, status: r.status, code: (j && j.code) || "failed" }; },
      () => ({ ok: false, code: "unreachable" }));
}
function HubMine() {
  useStore(navStore);                                 // ?agent= changes without a new route
  const [cat, reload] = useRead(() => hubClient().catalog());
  const [pairings, reloadPairings] = useRead(() => hubClient().pairings());
  const [msg, setMsg] = useState(null);
  useEffect(() => { linkHubChatCss(); linkHubOwnerCss(); }, []);
  const act = async (fn, after = reload, refused = (r) => setMsg(errText(r))) => {
    setMsg(null);
    const r = await fn();
    if (!r.ok) refused(r);
    await after();
    return r;
  };
  const confirmPairing = async (p) => {
    if (!(await confirmDialog({ message: hw("confirmPairingAsk", compareGroups(p.fingerprint)), confirmLabel: hw("confirmPairing") }))) return;
    await act(() => hubClient().confirmPairing(p.id, p.fingerprint), reloadPairings);
  };
  const pend = pairings && pairings.pairings ? pairings.pairings : [];
  const mine = cat && cat.mine ? cat.mine : [];
  const id = agentParam(), x = id ? mine.find((e) => e.id === id) : null;
  // Keyed by the agent: another ?agent= is another page (its reads, its dialog), and a late answer for the previous one
  // lands nowhere (useRead's own liveness ends with that page).
  if (x) return html`<${HubAgentPage} key=${x.id} x=${x} act=${act} msg=${msg} />`;
  return html`<div class="col hub-owner"><${PageHead} title=${hc("mine")} scope=${ho("scopeYou")} lead=${ho("mineLead")} />
    <div class="s-section-layout">
      ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
      ${!pairings ? html`<${Skeleton} lines=${2} />` : pairings.error ? html`<${ErrorState} message=${pairings.error} onRetry=${reloadPairings} />` : null}
      ${pend.length ? html`<section class="card hub-pairings"><h3>${ho("pendingPairings")}</h3><p class="note">${ho("pendingLead")}</p>
        <div class="hub-rows">${pend.map((p) => html`<div key=${p.id} class="s-row hub-row">
          <span class="hub-row-text"><code class="hub-fp-groups">${compareGroups(p.fingerprint)}</code><small class="note">${hw("expires", when(p.expiresAt))}</small></span>
          ${p.ownerConfirmed ? html`<span class="tag ok">${hw("confirmed")}</span>` : html`<button type="button" class="btn btn-sm btn-primary" onClick=${() => confirmPairing(p)}>${hw("confirmPairing")}</button>`}
        </div>`)}</div></section>` : null}
      ${!cat ? html`<${Skeleton} variant="rows" lines=${4} />` : cat.error ? html`<${ErrorState} message=${cat.error} onRetry=${reload} />` : null}
      ${cat && !cat.error && !mine.length ? html`<div class="center hub-empty"><${Empty} icon="globe" title=${hw("exposuresEmpty")} hint=${hw("exposuresHint")} /></div>` : null}
      ${mine.length ? html`<section class="card hub-shared"><h3>${ho("sharedCount", mine.length)}</h3>
        <div class="hub-rows">${mine.map((e) => html`<a key=${e.id} class="s-row hub-row hub-row-link" href=${`/ui/hub/exposures?agent=${encodeURIComponent(e.id)}`}>
          <${Avatar} name=${e.displayName} /><span class="hub-row-text"><strong>${e.displayName}</strong><small class="note">${mayAsk((e.grants || []).length)}</small></span>
          ${stateTag(e.state)}<${Icon} name="next" size=${16} /></a>`)}</div></section>` : null}
    </div></div>`;
}

/** One shared agent: who may ask (allow, revoke), whether askers see its quota (G), who asked lately, pause. */
function HubAgentPage({ x, act, msg }) {
  // #3338: this page is reached only through catalog.mine; the link opens a form, never a grant.
  // Read the closed intent once on this keyed agent page, so cancel/save/reloads never reopen it.
  const [allowing, setAllowing] = useState(() => x.state === "published" && new URLSearchParams(location.search).get("grant") === "1");
  const [activity, reloadActivity] = useRead(() => readActivity(x.id));
  const revoke = async (g) => {
    if (!(await confirmDialog({ message: hw("revokeAsk", g.subjectName || g.subjectLogin), confirmLabel: hw("revoke"), danger: true }))) return;
    await act(() => hubClient().revokeGrant(g.id, g.revision));
  };
  const freeze = async () => {
    if (!(await confirmDialog({ message: hw("freezeAsk", x.displayName), confirmLabel: hw("freeze"), danger: true }))) return;
    await act(() => hubClient().freeze(x.id, x.revision));
  };
  const grants = x.grants || [], shared = x.state === "published";
  const stageWord = (s) => (s === "answered" ? html`<span class="tag ok">${ho("stageAnswered")}</span>`
    : ["queued", "delivered", "consumed"].includes(s) ? html`<span class="tag warn">${ho("stageWaiting")}</span>` : html`<span class="tag danger">${ho("stageNot")}</span>`);
  const acts = activity && activity.activity ? activity.activity : [];
  return html`<div class="col hub-owner">
    <a class="hub-crumb" href="/ui/hub/exposures"><${Icon} name="back" size=${14} />${ho("backToMine")}</a>
    <${PageHead} title=${x.displayName} scope=${stateTag(x.state)} lead=${mayAsk(grants.length)} />
    <div class="s-section-layout">
      ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
      <section class="card"><div class="hub-card-head"><h3>${ho("whoMayAsk")}</h3>${shared ? html`<button type="button" class="btn btn-sm" onClick=${() => setAllowing(true)}><${Icon} name="plus" size=${14} />${ho("allow")}</button>` : null}</div>
        ${grants.length ? html`<div class="hub-rows">${grants.map((g) => html`<div key=${g.id} class="s-row hub-row">
          <${Avatar} name=${g.subjectName || g.subjectLogin} size="sm" />
          <span class="hub-row-text"><strong>${g.subjectName || g.subjectLogin}</strong><small class="note">${g.subjectLogin ? html`<code>${g.subjectLogin}</code> · ` : null}${ho("untilLeft", dateOnly(g.expiresAt), DAYS_LEFT(g.expiresAt))}</small></span>
          <${Menu} label=${ho("rowMenu", g.subjectName || g.subjectLogin)} items=${[{ key: "revoke", label: ho("revokeItem"), icon: "trash", danger: true, onSelect: () => revoke(g) }]} />
        </div>`)}</div>` : html`<p class="note">${hw("noGrants")}</p>`}
      </section>
      <${QuotaVisibilityRow} exposure=${x} onSaved=${() => act(async () => ({ ok: true }))} />
      <section class="card"><h3>${ho("recent")}</h3><p class="note">${ho("recentLead")}</p>
        ${!activity ? html`<${Skeleton} variant="rows" lines=${3} />` : activity.error ? html`<${ErrorState} message=${activity.error} onRetry=${reloadActivity} />` : null}
        ${activity && !activity.error && !acts.length ? html`<p class="note">${ho("recentNone")}</p>` : null}
        ${acts.length ? html`<div class="hub-rows">${acts.map((a, i) => html`<div key=${i} class="s-row hub-row">
          <${Avatar} name=${a.askerName || "?"} size="sm" /><span class="hub-row-text"><strong>${a.askerName || "—"}</strong><small class="note">${when(a.askedAt)}</small></span>${stageWord(a.stage)}
        </div>`)}</div>` : null}
        <div class="field-row"><button type="button" class="btn btn-sm btn-ghost" onClick=${reloadActivity}>${ho("refresh")}</button></div>
      </section>
      ${shared ? html`<section class="card hub-danger"><h3>${ho("pauseTitle")}</h3><p class="note">${ho("pauseLead")}</p>
        <div class="field-row"><button type="button" class="btn btn-sm btn-danger" onClick=${freeze}>${ho("pauseGo")}</button></div></section>` : null}
    </div>
    ${allowing && shared ? html`<${AllowDialog} x=${x} act=${act} onClose=${() => setAllowing(false)} />` : null}
  </div>`;
}

function AllowDialog({ x, act, onClose }) {
  const [form, setForm] = useState({ login: "", days: 7 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e && e.preventDefault && e.preventDefault();
    if (busy || !form.login.trim()) return;
    setError(null);
    setBusy(true);
    const r = await act(() => hubClient().grant({ exposureId: x.id, exposureRevision: x.revision, login: form.login.trim(), days: form.days }), undefined,
      (r) => setError(r.code === "not-found" ? hg("recipientRefused") : r.code === "unavailable" ? hg("directoryUnavailable") : errText(r)));
    setBusy(false);
    if (r && r.ok) onClose();
  };
  return html`<${Dialog} title=${ho("allowTitle", x.displayName)} onClose=${onClose}
    actions=${html`<button type="button" class="btn" onClick=${onClose}>${hw("pickCancel")}</button><button type="button" class="btn btn-primary" disabled=${busy || !form.login.trim()} onClick=${submit}>${ho("allowGo")}</button>`}>
    <form class="form hub-grant" onSubmit=${submit}>
      ${error ? html`<p class="err" role="alert">${error}</p>` : null}
      <label class="field"><span>${ho("allowLogin")}</span><input autocomplete="off" spellcheck=${false} autocapitalize="none" value=${form.login}
        onInput=${(e) => { const v = e.target.value; setError(null); setForm((f) => ({ ...f, login: v })); }} /><small class="note">${ho("allowLoginHint")}</small></label>
      <label class="field"><span>${ho("allowDays")}</span><select value=${String(form.days)} onChange=${(e) => { const v = Number(e.target.value); setForm((f) => ({ ...f, days: v })); }}>
        ${DAYS.map((d) => html`<option value=${String(d)}>${hw("days", d)}</option>`)}</select></label>
    </form>
  </${Dialog}>`;
}

// ── Administration ──
function HubAdmin({ admin }) {
  useStore(navStore);                               // ?view= changes without a new route
  const s = useSession();
  if (!admin) return html`<div class="center hub-empty"><${Empty} icon="key" title=${hw("adminOnly")} hint=${hw("adminOnlyHint")} /></div>`;
  if (groupPolicyOn(s, hubClient()) && adminView() === "groups") return html`<${LazyGroups} pick=${(m) => m.HubGroupPolicyPage} props=${{}} />`;
  // Reached from a fleet's Settings link on a Hub (or a tab) without group permissions: say so instead of a silent admin page.
  const unavailable = adminView() === "groups" && !groupPolicyOn(s, hubClient());
  return html`${unavailable ? html`<p class="note" role="status" data-groups="unavailable">${t("hubGroupsNote.unavailable")}</p>` : null}
    <${HubAdminPage} groups=${groupPolicyOn(s, hubClient())} />`;
}
/** #3298 S-89: Administration's sub-page (?view=groups: Group permissions), from the page's own address. */
function adminView() { try { return new URLSearchParams(location.search).get("view") || ""; } catch { return ""; } }
/** #3298 S-89: the prominent entry to Group permissions at the top of Administration (discovery without docs). */
function GroupPermissionsEntry() {
  return html`<${LazyGroups} pick=${(m) => m.GroupPermissionsCard} props=${{}} />`;
}
function HubAdminPage({ groups = false } = {}) {
  const [view, reload] = useRead(() => hubClient().adminOverview());
  const [login, setLogin] = useState("");
  const [offer, setOffer] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { linkHubChatCss(); linkHubOwnerCss(); }, []);
  const create = async (e) => {
    e.preventDefault();
    if (!login.trim()) return;
    setMsg(null);
    const r = await hubClient().createPairing(login.trim());
    if (!r.ok) { setMsg(errText(r)); return; }
    setOffer({ code: r.code, expiresAt: r.expiresAt, memberOrigin: r.memberOrigin, login: login.trim() }); setLogin(""); reload();
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
  if (!view || (view.error && !view.fleets)) return html`<div class="col hub-owner hub-admin"><${PageHead} title=${hc("admin")} scope=${ho("scopeHub")} lead=${ho("adminLead")} />
    <div class="s-section-layout">${view?.error ? html`<${ErrorState} message=${view.error} onRetry=${reload} />`
      : html`<section class="card"><h3>${ho("pairSteps")}</h3><${Skeleton} variant="rows" lines=${3} /></section><section class="card"><${Skeleton} variant="rows" lines=${3} /></section>`}</div></div>`;
  const fleets = view.fleets || [], pairings = view.pairings || [];
  return html`<div class="col hub-owner hub-admin"><${PageHead} title=${hc("admin")} scope=${ho("scopeHub")} lead=${ho("adminLead")} />
    <div class="s-section-layout">
      ${groups ? html`<${GroupPermissionsEntry} />` : null}
      ${view.error ? html`<${ErrorState} message=${view.error} onRetry=${reload} />` : null}
      ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
      <section class="card"><h3>${ho("pairSteps")}</h3>
        <ol class="hub-steps">
          <li class=${offer || pairings.length ? "done" : "now"}><div class="hub-step-body"><span><b>${ho("stepCode")}</b><small class="note">${ho("stepCodeHint")}</small></span>
            <form class="hub-step-form" onSubmit=${create}><label class="field"><span class="sr-only">${ho("ownerLogin")}</span><input placeholder=${ho("ownerLogin")} autocomplete="off" spellcheck=${false} autocapitalize="none" value=${login} onInput=${(e) => setLogin(e.target.value)} /></label>
              <button type="submit" class="btn btn-sm" disabled=${!login.trim()}>${ho("makeCode")}</button></form>
            ${offer ? html`<div class="hub-offer" role="status"><small class="note">${ho("codeFor", offer.login)}</small><code class="hub-code">${offer.code}</code><small class="note">${hw("expires", when(offer.expiresAt))}</small>
              ${offer.memberOrigin ? html`<div class="field"><span>${ho("memberAddress")}</span><span class="hub-origin"><code>${offer.memberOrigin}</code></span><small class="note">${ho("memberAddressHint")}</small></div>
                <button type="button" class="btn btn-sm" onClick=${async () => { const ok = await copyText(`${ho("memberAddress")}: ${offer.memberOrigin}\n${ho("codeFor", offer.login)}: ${offer.code}\n${hw("expires", when(offer.expiresAt))}`); toast(ho(ok ? "handoffCopied" : "handoffCopyFailed"), !ok); }}><${Icon} name="copy" size=${14} />${ho("copyHandoff")}</button>`
                : html`<small class="note">${ho("memberAddressMissing")}</small>`}</div>` : null}</div></li>
          <li class=${pairings.some((p) => p.ownerConfirmed) ? "done" : pairings.length ? "now" : ""}><div class="hub-step-body"><span><b>${ho("stepOwner")}</b><small class="note">${ho("stepOwnerHint")}</small></span></div></li>
          <li class=${pairings.some((p) => p.ownerConfirmed && !p.adminApproved) ? "now" : ""}><div class="hub-step-body"><span><b>${ho("stepApprove")}</b><small class="note">${ho("stepApproveHint")}</small></span></div></li>
        </ol>
        ${pairings.length ? html`<div class="hub-rows">${pairings.map((p) => html`<div key=${p.id} class="s-row hub-row">
          <${Avatar} name=${p.owner ? p.owner.name : "?"} size="sm" />
          <span class="hub-row-text"><strong>${p.owner ? p.owner.name : "—"}</strong>
            ${p.fingerprint ? html`<code class="hub-fp-groups">${compareGroups(p.fingerprint)}</code>` : html`<small class="note">${ho("codeUnusedYet")}</small>`}</span>
          ${p.adminApproved ? html`<span class="tag ok">${ho("approvedTag")}</span>`
            : p.ownerConfirmed ? html`<button type="button" class="btn btn-sm btn-primary" disabled=${!p.fingerprint} onClick=${() => approve(p)}>${ho("approveGo")}</button>`
            : html`<span class="tag warn">${ho("waitingOwner")}</span>`}
        </div>`)}</div>` : null}
      </section>
      <section class="card"><h3>${ho("pairedFleets", fleets.length)}</h3>
        ${fleets.length ? html`<div class="hub-rows">${fleets.map((f) => html`<div key=${f.id} class="s-row hub-row">
          <${Avatar} name=${f.owner ? f.owner.name : "?"} size="sm" />
          <span class="hub-row-text"><strong>${ho("fleetOf", f.owner ? f.owner.name : "—")}</strong>${f.owner ? html`<small class="note"><code>${f.owner.login}</code></small>` : null}</span>
          ${f.status === "active" ? html`<span class="tag ok">${ho("active")}</span><${Menu} label=${ho("rowMenu", f.owner ? f.owner.name : f.id)} items=${[{ key: "revoke", label: ho("revokeItem"), icon: "trash", danger: true, onSelect: () => revoke(f) }]} />`
            : html`<span class="tag">${ho("revokedTag")}</span>`}
        </div>`)}</div>` : html`<p class="note">${ho("noFleets")}</p>`}
      </section>
    </div></div>`;
}

/** Tests only: forget the page's session view. */
export function resetHubSession() { session = undefined; reading = null; watchingEnd = false; sessionSubs.clear(); roomsStore.set({ loaded: false, rooms: [], error: null }); roomsReading = null; }
