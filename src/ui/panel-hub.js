import { IntroNotice, introNoticeOffered } from "./hub-intro-notice.js";
import { AgentIntroEditor, hi } from "./hub-agent-intro.js";
import {hp,personalAgentQuestionHint} from "./hub-personal-agent-strings.js";
import * as ownerEntryWords from "./hub-owner-strings.js";
import * as companyViews from "./hub-company-join.js";
import { hj, joinError } from "./hub-company-join-strings.js";
import { useJoinApproval } from "./hub-join-approval.js";
import { queueMessage } from "./hub-joincode-flow-strings.js";
import { joinRequest, companyInfoRequest, CompanyJoinInfoPage, useCompanyJoinContext, CompanyJoinLead, approveCompanyJoin, HubCompanyJoinPage, CompanyJoinAdminCard } from "./hub-company-join.js";
// AgEnD Hub P1, slice 3: the Hub workspace's pages — the chats (/ui/hub, a room at /ui/hub?room=<id>; #3226 B), My
// exposures and Administration (/ui/hub/exposures, /ui/hub/admin; reached from the session row's menu) — and its session row. Served only by a Hub's own listener at its own origin, over the Hub's /hub/v1/*
// API (hub-client.js createHubWebClient); nothing here reads or reaches a fleet. A lazy module: it imports only names
// every shell has had since #1408, so a tab opened before an upgrade loads it as fresh as the rest.
//
// What people see is what the server says now: every list is read fresh, every change is checked again by the server
// (who, the revision shown, the directory), and a conflict reloads the list instead of guessing.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { DevicePrefs, PanelHeader, closeDrawer, isMacLike, searchShortcut, setTitle } from "/assets/app-shell.js";
import { lang, register, t } from "/assets/app-i18n.js";
import { createStore, useStore } from "/assets/app-store.js";
import { navigate, navStore } from "/assets/app-nav.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { useJumpIdle } from "/assets/jump-idle.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { Dialog } from "/assets/ui-dialog.js";
import { PairingNotices } from "./hub-quick-pairing.js";
import { dn } from "./hub-directory-notice-strings.js";
import { RoleNotices, roleNoticesOffered, roleNoticeLead } from "./hub-role-notices.js";
import { DirectoryNotices, directoryNoticesOffered } from "./hub-directory-notices.js";
import { Menu } from "/assets/ui-menu.js";
import { toast } from "/assets/ui-toast.js";
// #3226 B: the chat is the fleet chat's own drawing (PR A's shared modules), in the fleet chat's words.
import { createThread, msgKey } from "/assets/chat-thread.js";
import { installMessageActions } from "/assets/chat-msg-actions.js";
import { OlderFleetBanner, FleetVersionCells, FleetVersionsSummary, RecommendedVersionCard, FleetUpdateCell, UpdateAllowedButton, hasVersions, hasUpdates, behind } from "./hub-fleet-versions.js";
import { PreviewPanel, closePanel, panelStore } from "/assets/preview-panel.js";
import { ComposerInput, WorkBarView, touchScreen } from "/assets/chat-composer.js";
import { RailFrame } from "/assets/side-rail.js";
import "/assets/chat-strings.js";
import { compareGroups, hubClient } from "./hub-client.js";
import { hw, linkHubCss } from "./hub-strings.js";
import { hc, linkHubChatCss } from "./hub-chat-strings.js";
import { HubRoomRows, readRoomList } from "./hub-room-list.js";
import * as roomFavorites from "./hub-room-favorites.js";
const { useRoomStar } = roomFavorites;
import { HubRoomPage } from "./hub-room-thread.js";
import { TextSizeButton } from "/assets/header-tools.js";
import { HubNotifyToggle, clearHubMeId, noteHubMeId, rememberedMeId, startHubRoomNotifier } from "./hub-room-notify.js";
import { hroom } from "./hub-room-strings.js";
import { ha as hApps } from "./hub-ai-apps-strings.js";
import { hr } from "./hub-read-strings.js";
import { ht } from "./hub-teams-strings.js";
import { ho, linkHubOwnerCss } from "./hub-owner-strings.js";
import { hg } from "./hub-grant-strings.js";
import { createHubChatStore } from "./hub-chat-store.js";
import { QuotaBanner, QuotaCard, QuotaChip, QuotaVisibilityRow } from "./hub-quota.js";
import { PageHead } from "/assets/page-head.js";
import { bindRoomFeedback, bootHubPreview, downloadHtml, draftWithLine, panelOpenFor, roomPanelKey, roomPanelOpts, setHubPreviewOptIn } from "./hub-preview.js";
import { DropOverlay, MAX_FILES, PendingFiles, hf, pageCarriesFiles, pasteToAttach, putBackText, roomTakesFiles, uploadChosen, useFileDrop } from "./hub-attachments.js";
import { composerCaret, insertQuote, installQuoteSelection, showCaret } from "/assets/chat-quote.js";
import { installTableSelection } from "/assets/chat-table-select.js";
import { assetUrl } from "/assets/asset-url.js";
import { dateTimeText } from "/assets/clock-text.js";
register("hubAccess", {
  en: { tag: "Access needs checking", refused: "Asking was refused. Check your access before trying again.", check: "Check access", limited: "Asking was refused; the previous access information needs checking." },
  "zh-TW": { tag: "需要確認權限", refused: "提問遭到拒絕。請先重新檢查權限，再試一次。", check: "重新檢查權限", limited: "提問遭到拒絕，先前的權限資訊需要重新確認。" },
});
const ha = key => t(`hubAccess.${key}`);
// Kept with the fresh renderer: retained owner dictionaries do not know this label.
// M-3162: Administration's tabs (Lumen's names: "Manage" holds today's long page; "This Hub" its name already).
register("hubAdminTabs", {
  en: { label: "Administration", overview: "Overview", manage: "Manage", teams: "Teams", groups: "Groups", roles: "Roles and permissions",allowedList:"Allowed list", thisHub: "This Hub" },
  "zh-TW": { label: "管理", overview: "總覽", manage: "管理項目", teams: "團隊", groups: "群組", roles: "角色與權限",allowedList:"允許清單", thisHub: "這個 Hub" },
});
const hat = (key) => t(`hubAdminTabs.${key}`);
register("hubGrantStatus", {
  en: { grantNeverSignedIn: "Hasn't signed in to Hub yet", grantADGroup: "AD group", grantTeam: "Team", grantSubjects: "People, groups and teams allowed: {0}" },
  "zh-TW": { grantNeverSignedIn: "還沒登入過 Hub", grantADGroup: "AD 群組", grantTeam: "團隊", grantSubjects: "已允許的個人、群組與團隊：{0}" },
});

// These words travel with the renderer; retained dictionaries need no new exports.
register("hubSharing", {
  en: { pause: "Pause sharing", resume: "Resume sharing", paused: "Sharing paused", title: "Pause and resume sharing",
    lead: "Stop new questions and keep the people and AD groups allowed to ask. Their expiry dates keep running while sharing is paused. A question already being handed to the Fleet may still start within a few seconds; work already in progress may finish.",
    waiting: "Saving…", pausedChat: "The owner paused sharing {0}. New questions are stopped; a question already being handed to the Fleet may still start within a few seconds. You can still read this chat while your permission lasts. Sharing can resume; expiry dates keep running.",
  },
  "zh-TW": { pause: "暫停分享", resume: "繼續分享", paused: "分享已暫停", title: "暫停與繼續分享",
    lead: "停止接受新提問，保留允許提問的個人與 AD 群組。暫停期間，授權的到期時間照常計算。已在傳送給 Fleet 的提問，可能仍會在幾秒內開始處理；已在處理的工作可能會完成。",
    waiting: "儲存中…", pausedChat: "擁有者已暫停分享 {0}。不再接受新提問；已在傳送給 Fleet 的提問，可能仍會在幾秒內開始處理。權限有效期間，你仍可閱讀這段對話。之後可以繼續分享；授權的到期時間照常計算。",
  },
});

// #3298 S-89 (experimental): the group permissions editor and the signed-in welcome are their own LAZY modules, loaded only
// when the Hub's session says "group-policy-v1" and this tab's client has the calls — a Hub without them never serves or loads them.
// The one group-permissions sentence this module draws itself (shown when the lazy modules are NOT loaded: this Hub lacks them).
// Hub UX U2 (spec 1.2): the fleet list's own words (an older cached owner dictionary has none of them).
register("hubFleetList", { en: { revoked: "Revoked ({0})" }, "zh-TW": { revoked: "已撤銷（{0}）" } });
register("hubGroupsNote", {
  en: { unavailable: "Group permissions aren't available on this Hub yet. Update the Hub, then try again." },
  "zh-TW": { unavailable: "這個 Hub 還沒有群組權限。請更新 Hub 後再試。" },
});
const rolesOn = (session,client) => session?.features?.includes("role-settings-v1") && client?.roleSettingsV1 === true;
const manages = session => session?.admin === true || Array.isArray(session?.management) && session.management.length > 0;
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
let unreadOff = null;                            // the list's unread.changed subscription, for the signed-in person
const sessionSubs = new Set();
function setSession(next) {
  const was = session;
  // The notifier's remembered person id belongs to the signed-in login: a sign-out, or in as someone else on the
  // same tab, forgets it (the next login's id is learned again from a room detail or the lazy resolve).
  if (!next || !was || was.login !== next.login) clearHubMeId();
  session = next;
  roomFavorites.configureHubFavorites?.(hubClient(), next);
  // #3226 B: the conversation list is this person's: cleared when no one is signed in, read again when someone is.
  if (!next) roomsStore.set({ loaded: false, rooms: [], error: null });
  else if (!was || was.login !== next.login) void refreshRooms();
  // M-3260: each room's unread as the Hub counts it for this person (unread.changed { roomId, unread }), into the list at once
  // rather than at its next read: the open room's read clears its badge, a message in another room raises it.
  if (!next || !was || was.login !== next.login) {
    unreadOff?.(); unreadOff = null;
    const c = hubClient();
    if (next && typeof c?.subscribeRooms === "function") unreadOff = c.subscribeRooms({ "unread.changed": noteUnread });
  }
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
const when = (ms) => dateTimeText(ms, { dateStyle: "medium", timeStyle: "short" });
// M-2988: words added after a release; a tab holding the older hub-strings dictionary falls back to the older sentence.
const newer = (key, args, older) => { const s = hw(key, ...args); return s === `hub.${key}` ? older() : s; };
const errText = (r) => hw(r.code === "conflict" || r.code === "stale" ? "errConflictHub" : r.code === "not-found" ? "errNotFound"
  : r.code === "backpressure" ? "errBusyHub" : r.code === "revoked" || r.code === "denied" ? "errDenied" : r.code === "unreachable" ? "errUnreachableHub" : "errFailed");

export function HubPanel({ route }) {
  const tab = TITLES[route && route.tab] ? route.tab : "ask";
  const companyPage = tab === "ask" && (companyInfoRequest() || !!joinRequest());
  const s = useSession();
  useStore(navStore);                               // ?view= changes without a new route
  const view = viewParam();
  // The owner stylesheet holds the page column (.hub-owner, 860 px) every page with a column uses — Notices too (Argon #12).
  useEffect(() => { linkHubCss(); linkHubOwnerCss(); if (tab === "ask") linkHubChatCss(); }, [tab]);
  // Rooms desktop notifications (§12): one page-level watcher over every room this person may see. Member ids
  // are per room, so the id is kept per room: from a room detail once read, or lazily by reading that room
  // itself on its first live event while opted in.
  useEffect(() => {
    if (!s || !s.login) return undefined;
    const stop = startHubRoomNotifier({
      client: hubClient(), me: (rid) => { const id = rememberedMeId(rid); return id ? { id } : null; },
      setMe: (rid, m) => noteHubMeId(rid, m && m.id),
      resolveMe: async (rid) => {
        if (typeof hubClient().room !== "function") return null;
        const d = await hubClient().room(rid).catch(() => null);
        return d && d.ok && d.me && d.me.id ? { id: d.me.id } : null;
      },
      roomName: (id) => { const r = (roomsStore.get().rooms || []).find((x) => x.id === id); return (r && r.name) || ""; },
      roomKind: (id) => { const r = (roomsStore.get().rooms || []).find((x) => x.id === id); return (r && r.kind) || ""; },
      open: (rid) => navigate(roomPath(rid)),
    });
    return stop;
  }, [s && s.login]);
  // Join takes precedence over other query views. Rooms and Group permissions otherwise name their own pages.
  const pageName = companyPage ? hj("title") : tab === "ask" && view === "ai-apps" ? hApps("title") : tab === "ask" && view === "app-consent" ? hApps("consentHeading") : tab === "exposures" ? hc("mine") : tab === "admin" ? view === "teams" ? ht("title") : view==="allowed-list"?hat("allowedList") : (view==="roles"||view==="groups"&&rolesOn(s,hubClient()))?hat("roles"):hc("admin") : view === "notices" ? hc("noticesTitle")
    : view === "invitations" ? hroom("invitationsTitle") : view === "teams" ? ht("mine") : hc("chats");
  useEffect(() => { if (companyPage || !(tab === "ask" && roomParam()) && !(tab === "admin" && (view === "groups"&&!rolesOn(s,hubClient())||view==="allowed-list"))) setTitle(pageName); }, [tab, view, pageName, roomParam(), companyPage]);
  let body = tab === "ask" ? roomParam() ? html`<${HubRoomLoading} />`
    : html`<${PanelHeader} title=${hc("chats")} /><div class="hub-home"><${Skeleton} variant="rows" lines=${4} /></div>`
    : html`<${Skeleton} variant="rows" lines=${4} />`;
  // Signed out: the sign-in page alone (no panel header, no chat chrome).
  if (companyInfoRequest()) return html`<div data-effect-panel="hub" class="panel p-hub p-hub-info"><${PanelHeader} title=${hj("title")} /><div data-trust="panel-content" class="panel-body hub-page-body"><${CompanyJoinInfoPage} /></div></div>`;
  if (s === null) return html`<div data-effect-panel="hub" class="panel p-hub p-hub-signin"><${HubSignIn} /></div>`;
  if (s) body = tab === "ask" ? html`<${HubChats} />` : tab === "exposures" ? html`<${HubMine} />` : html`<${HubAdmin} admin=${!!s.admin} />`;
  if (s && tab === "ask" && joinRequest()) return html`<div data-effect-panel="hub" class="panel p-hub p-hub-join">
    <${PanelHeader} title=${hj("title")} /><div data-trust="panel-content" class="panel-body hub-page-body"><${HubCompanyJoinPage} session=${s} /></div></div>`;
  if (s && tab === "ask" && ["ai-apps", "app-consent"].includes(view) && s.features?.includes("mcp-apps-v1")) return html`<div data-effect-panel="hub" class="panel p-hub p-hub-ai-apps">
    <${PanelHeader} title=${pageName}/><div data-trust="panel-content" class="panel-body hub-page-body"><div class="col hub-owner">
      <${LazyRoomPart} load=${()=>import("./hub-ai-apps.js")} name=${view==="app-consent"?"AppConsentPage":"MyAiAppsPage"}
        props=${{client:hubClient(),person:s.displayName,request:new URLSearchParams(location.search).get("request")||""}}/></div></div></div>`;
  // Security notices stay on their own page. The bound join branch above never renders the chat or notices page.
  if (s && tab === "ask" && view === "notices" && noticesOffered(s)) return html`<div data-effect-panel="hub" class="panel p-hub p-hub-notices">
    <${PanelHeader} title=${hc("noticesTitle")}><span class="hub-head-tools"><${HubNotifyToggle} /></span></${PanelHeader}><div data-trust="panel-content" class="panel-body hub-page-body">
      <div class="col hub-owner hub-notices-col"><p class="s-page-lead hub-page-lead">${roleNoticesOffered(s, hubClient()) ? roleNoticeLead() : directoryNoticesOffered(s, hubClient()) ? dn("pageLead") : hc("noticesLead")}</p>
        ${pairingNoticesOffered(s) ? html`<${PairingNotices} admin=${!!s.admin} empty=${introNoticeOffered(s,hubClient()) || directoryNoticesOffered(s, hubClient()) || roleNoticesOffered(s, hubClient()) ? null : html`<${Empty} icon="bell" title=${hc("noNotices")} />`} />` : null}
        ${introNoticeOffered(s,hubClient())?html`<${IntroNotice} client=${hubClient()} />`:null}${directoryNoticesOffered(s, hubClient()) ? html`<${DirectoryNotices} client=${hubClient()} />` : null}${roleNoticesOffered(s, hubClient()) ? html`<${RoleNotices} client=${hubClient()} />` : null}</div></div></div>`;
  // M-3092: the owner's invitations (spec §8), a page of the chats like Notices.
  if (s && tab === "ask" && view === "invitations" && roomsLive()) return html`<div data-effect-panel="hub" class="panel p-hub p-hub-invitations">
    <${PanelHeader} title=${hroom("invitationsTitle")} /><div data-trust="panel-content" class="panel-body hub-page-body"><div class="col hub-owner">
      <${LazyRoomPart} load=${() => import("./hub-invitations.js")} name="InvitationsList" props=${{ client: hubClient(), heading: false }} /></div></div></div>`;
  if (s && tab === "ask" && view === "teams" && teamsLive()) return html`<div data-effect-panel="hub" class="panel p-hub p-hub-teams">
    <${PanelHeader} title=${ht("mine")} /><div data-trust="panel-content" class="panel-body hub-page-body"><div class="col hub-owner">
      <${LazyRoomPart} load=${() => import("./hub-teams.js")} name="HubTeamsPage" props=${{ client: hubClient(), mode: "lead", person: s.person }} /></div></div></div>`;
  // The chats draw their own header (the room's); the other pages keep the panel's.
  if (s !== null && tab === "ask") return html`<div data-effect-panel="hub" class="panel p-hub p-hub-ask"><div data-trust="panel-content" class="panel-body hub-chat-body">${body}</div></div>`;
  // #3226 C: My shared agents and Administration are Settings-like pages. The panel's header names the page once, its scope
  // beside it ("Yours" / "This Hub"); the page itself opens with its lead — no second title repeating the first (Argon #7).
  const scope = s && tab === "exposures" && !agentParam() ? ho("scopeYou") : s && tab === "admin" && s.admin && view !== "groups" ? ho("scopeHub") : null;
  return html`<div data-effect-panel="hub" class=${`panel p-hub p-hub-${tab}`}>
    <${PanelHeader} title=${pageName} sub=${scope ? html`<span class="s-scope">${scope}</span>` : null} />
    <div data-trust="panel-content" class=${`panel-body ${s ? "hub-page-body" : "hub-body"}`}>${body}</div>
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
    ...(s.features?.includes("mcp-apps-v1") ? [{ key:"ai-apps",label:hApps("title"),icon:"globe",onSelect:()=>navigate("/ui/hub?view=ai-apps") }] : []),
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
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", assetUrl("/assets/hub-signin.css")); link.setAttribute("data-hub-signin-css", "1");
    doc.head.appendChild(link);
  } catch { /* the page still works without it */ }
}
function HubSignIn() {
  const company = useCompanyJoinContext();
  const generation = useRef(0);
  const approval = useJoinApproval({ requestId: company.requestId, deadline: company.view?.outerDeadline, approve: approveCompanyJoin, current: () => joinRequest() === company.requestId });
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
  useEffect(() => { setBusy(false); setMsg(null); return () => { generation.current++; }; }, [company.requestId]);
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    // Password managers can fill DOM values without a framework input event. Snapshot the real fields at submit.
    const submittedLogin = e.currentTarget?.querySelector("#hubLogin")?.value ?? form.login;
    const submittedPassword = e.currentTarget?.querySelector("#hubPassword")?.value ?? form.password;
    // The button is always ready (a disabled one reads as grey, "broken"): an empty field just takes the focus.
    if (!submittedLogin.trim() || !submittedPassword) {
      const doc = typeof document !== "undefined" ? document : null;
      doc?.getElementById(!submittedLogin.trim() ? "hubLogin" : "hubPassword")?.focus();
      return;
    }
    const mine = ++generation.current, requestId = company.requestId;
    setForm({ login: submittedLogin, password: submittedPassword });
    setBusy(true); setMsg(null);
    const r = await hubClient().signIn(submittedLogin.trim(), submittedPassword);
    if (mine !== generation.current || joinRequest() !== requestId) return;
    if (r.ok) {
      // Keep the successful identifier as typed (account name, UPN or email), so the browser offers it next time.
      // The fields keep their values until the form goes away; browsers judge a sign-in by them.
      rememberLogin(submittedLogin, submittedPassword);
      if (company.requestId) {
        const joined = await approval.run(r.csrf);
        if (mine !== generation.current || joined.code === "retired") return;
        if (!joined.ok) { setBusy(false); setSession({ ...r, companyJoinFailure: { requestId: company.requestId, code: joined.code, reason: joined.reason } }); return; }
      }
      setBusy(false); setSession(r); return;
    }
    setBusy(false);
    setForm((f) => ({ ...f, password: "" }));
    setMsg(r.code === "backpressure" ? hw("errBusyHub") : r.code === "unavailable" ? hw("errDirectory") : hw("errSignIn"));
  };
  return html`<main class="hub-signin-page"><section class="hub-signin hub-signin-card" aria-labelledby="hubSignInTitle">
    <div class="hub-signin-brand"><strong>${t("hubShell.brand")}</strong>${name ? html`<span>${name}</span>` : null}</div>
    <h1 id="hubSignInTitle">${hw("signInTitle")}</h1>
    ${company.requestId ? html`<${CompanyJoinLead} context=${company.view?.ok ? company.view : null} />` : html`<p class="hub-signin-lead">${hw("signInLead")}</p>`}
    <p class="note hub-signin-preview">${hw("signInPreview")}</p>
    ${company.requestId && company.view === undefined ? html`<${Skeleton} variant="form" lines=${2} label=${hj("loading")} />` : company.requestId && company.view && !company.view.ok ? html`<${ErrorState} message=${joinError(company.view.code)} onRetry=${company.retry} />` : null}
    ${!company.requestId || company.view?.ok && company.view.state === "pending" ? html`<form class="hub-signin-form" onSubmit=${submit}>
      <label for="hubLogin">${hw("login")}</label>
      <input id="hubLogin" name="username" autocomplete="username" spellcheck=${false} autocapitalize="none"
        value=${form.login} onInput=${(e) => { const v = e.target.value; setForm((f) => ({ ...f, login: v })); }} />
      ${typeof document !== "undefined" && document.body?.dataset?.hubLogin === "email-or-account" ? html`<p class="note">${hw("loginEmailHint")}</p>` : null}
      <label for="hubPassword">${hw("password")}</label>
      <input id="hubPassword" name="password" type="password" autocomplete="current-password"
        value=${form.password} onInput=${(e) => { const v = e.target.value; setForm((f) => ({ ...f, password: v })); }} />
      <button type="submit" class="hub-signin-go" disabled=${busy || company.requestId && !company.view?.ok}>${company.requestId ? hj("signInConnect") : hw("signIn")}</button>
    </form>` : company.view?.ok ? html`<p role="status">${joinError(company.view.reason || company.view.state)}</p>` : null}
    ${approval.queued ? html`<p class="note" role="status">${queueMessage(approval.retryAttempt)}</p>` : null}
    <p class="hub-signin-msg" role=${msg ? "alert" : undefined}>${msg || ""}</p>
    ${company.requestId && (msg || company.view?.state !== "pending") && company.view?.returnPath ? html`<a class="btn btn-sm" href=${company.view.returnPath} rel="noreferrer">${hj("return")}</a>` : null}
  </section></main>`;
}

/**
 * M-3565: a room's 「和它一對一對話」 — the viewer's own chat with that agent: the one they have, else one started as 新對話
 * starts it (their grant for that agent, from the catalog). Resolves to whether it opened; says why not when it did not.
 */
export async function openDirectChat(member, rooms = []) {
  const id = member && member.id;
  if (!id) return false;
  const have = rooms.find((r) => r && r.kind === "direct" && !r.archived && (r.agent || r.legacy || {}).exposureId === id);
  if (have) { navigate(roomPath(have.id)); return true; }
  const cat = await hubClient().catalog().catch(() => null);
  const it = cat && Array.isArray(cat.askable) ? cat.askable.find((x) => x && x.exposure && x.exposure.id === id && x.grant) : null;
  if (!it) { toast(hw("errNotFound"), false); return false; }
  const r = await hubClient().openRoom(it.exposure.id, it.grant.id);
  if (!r.ok) { toast(errText(r), false); return false; }
  await refreshRooms(); navigate(roomPath(r.room.id));
  return true;
}

/**
 * M-3563: hand a login that worked to the browser's password manager (Chrome, Edge: the Credential Management API), the
 * account exactly as typed. Where the browser has none, or the person declines, nothing happens; never an error.
 */
export function rememberLogin(login, password) {
  try {
    const PC = globalThis.PasswordCredential, store = globalThis.navigator?.credentials?.store;
    if (typeof PC !== "function" || typeof store !== "function" || !login || !password) return;
    Promise.resolve(globalThis.navigator.credentials.store(new PC({ id: login, password, name: login }))).catch(() => {});
  } catch { /* none */ }
}

/** Load a list from the client; `reload` reads it again. null while loading, { error } on failure. */
export function useRead(read) {
  const [data, setData] = useState(null);
  const live = useRef(true), latest = useRef(0);
  // M-3567 (Prism): only the newest read may answer. A return reads again while the first read can still be on its way; that
  // older answer, success or failure, landing last must not undo the fresh one (a grant given while away would vanish).
  const reload = () => {
    const n = ++latest.current, current = () => live.current && n === latest.current;
    const failed = (error) => { if (current()) setData((old) => ({ ...old, error })); };
    return read().then((r) => { if (current()) { if (r.ok) setData(r); else failed(errText(r)); } }, () => failed(hw("errFailed")));
  };
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
  // M-3092: the rooms list (docs/design/hub-rooms-split.md seam 1). A Hub without rooms yet answers today's chats in the
  // same shape (kind "direct", `limited`, the old item under `legacy`: hub-client.js legacyRoom()).
  return roomsReading ??= readRoomList(hubClient()).then((r) => {
    // With group permissions on, a person whose groups don't include chatting is refused the list: that is their access, shown
    // by the welcome, not a failure (Cairn #3372) — the list stays empty and quiet. Every chat action still asks the server.
    if (!r.ok && (r.code === "denied" || r.code === "revoked") && groupPolicyOn(session, hubClient())) roomsStore.set({ loaded: true, rooms: [], error: null, denied: true });
    else roomsStore.set(r.ok ? { loaded: true, rooms: r.rooms || [], me: r.me || null, invitations: Number(r.invitations) || 0, error: null } : { ...roomsStore.get(), loaded: true, error: errText(r) });
  }, () => roomsStore.set({ ...roomsStore.get(), loaded: true, error: hw("errFailed") })).finally(() => { roomsReading = null; });
}
/** One room's unread from the stream, into the list as it is (a room the list does not hold yet waits for the next read). */
function noteUnread(d) {
  const n = Number(d.unread), s = roomsStore.get();
  if (!Number.isSafeInteger(n) || n < 0 || !s.rooms.some((r) => r.id === d.roomId && r.unread !== n)) return;
  // Read through (0): its @ mark goes too; the next list read has the Hub's own answer for both.
  roomsStore.set({ ...s, rooms: s.rooms.map((r) => (r.id === d.roomId ? { ...r, unread: n, ...(n === 0 ? { mentioned: false } : {}) } : r)) });
}
/** M-3567: the gap between a page left and a page back (another tab, another window) is when a grant or a new room lands. */
export const RETURN_MIN_MS = 5_000;
/**
 * M-3567: `fn` when the person comes back to the page — it is shown again (visibilitychange) or its window gains focus —
 * at most once per RETURN_MIN_MS (both fire on one return). The 30 s poll pauses while the page is hidden, so a grant
 * given meanwhile showed only after a reload.
 */
export function useOnReturn(fn) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    let last = -Infinity;
    const back = () => {
      if (document.hidden) return;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();   // a gap, not a date
      if (now - last < RETURN_MIN_MS) return;
      last = now; latest.current();
    };
    document.addEventListener("visibilitychange", back);
    const w = typeof window !== "undefined" ? window : null;
    w?.addEventListener?.("focus", back);
    return () => { document.removeEventListener("visibilitychange", back); w?.removeEventListener?.("focus", back); };
  }, []);
}
/** Keeps the list fresh while something shows it (every ROOMS_MS, paused while the page is hidden; again on return). */
function useRooms() {
  const rs = useStore(roomsStore);
  useEffect(() => {
    if (!roomsStore.get().loaded && session) refreshRooms();
    const tick = setInterval(() => { if (session && (typeof document === "undefined" || !document.hidden)) refreshRooms(); }, ROOMS_MS);
    return () => clearInterval(tick);
  }, []);
  useOnReturn(() => { if (session) refreshRooms(); });
  return rs;
}
// A room's id as the list gives it (today's are UUIDs; a Hub with rooms may name them otherwise): matched against the list
// and encoded into each call, never trusted as anything else.
const roomParam = () => { try { const v = new URLSearchParams(location.search).get("room"); return v && /^[A-Za-z0-9-]{1,64}$/.test(v) ? v : null; } catch { return null; } };
const roomPath = (id) => `/ui/hub?room=${encodeURIComponent(id)}`;
/** M-3533 R1: a group room's Chat or Office tab (design §2.1). */
const roomViewPath = (id, view) => (view === "office" ? `${roomPath(id)}&view=office` : roomPath(id));
/** cid-hub-shell-parity: the Notices page is /ui/hub?view=notices (the path every Hub listener and router already serves). */
const viewParam = () => { try { return new URLSearchParams(location.search).get("view"); } catch { return null; } };
export const NOTICES_PATH = "/ui/hub?view=notices";
/** M-3092: the owner's invitations (spec §8). */
export const INVITATIONS_PATH = "/ui/hub?view=invitations";
export const MY_TEAMS_PATH = "/ui/hub?view=teams";
const pairingNoticesOffered = (s) => !!s && Array.isArray(s.features) && s.features.includes("quick-pairing-v1") && !!hubClient().quickPairingV1;
const noticesOffered = s => introNoticeOffered(s,hubClient()) || pairingNoticesOffered(s) || directoryNoticesOffered(s, hubClient()) || roleNoticesOffered(s, hubClient());
const initial = (name) => (String(name || "?").trim()[0] || "?").toUpperCase();
const AV_TONES = 6;
const tone = (name) => { let h = 0; for (const c of String(name || "")) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % AV_TONES; };
function Avatar({ name, size = "" }) { return html`<span class=${`hub-av t${tone(name)} ${size}`} aria-hidden="true">${initial(name)}</span>`; }
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
  const star = useRoomStar(rs.rooms, s?.login);
  useEffect(() => { linkHubChatCss(); }, []);
  if (!s) return null;
  const current = roomParam();
  const shown = rs.rooms.filter((r) => !q.trim() || [r.name, r.agent?.owner?.name, r.lastText].some((v) => String(v || "").toLowerCase().includes(q.trim().toLowerCase())));
  const pick = (e, r) => { if (onPick) onPick(); if (e && (e.metaKey || e.ctrlKey)) return; e && e.preventDefault(); navigate(roomPath(r.id)); };
  return html`<div class="hub-nav">
    <button type="button" class="btn hub-new" onClick=${() => { if (onPick) onPick(); navigate(NEW_CHAT_PATH); }}><${Icon} name="plus" size=${16} />${hc("newChat")}</button>
    <label class="hub-search"><${Icon} name="search" size=${14} /><input type="search" placeholder=${hc("search")} aria-label=${hc("search")} value=${q}
      onInput=${(e) => setQ(e.target.value)} /></label>
    <div class="hub-sec">${hc("chats")}</div>
    ${rs.error ? html`<${ErrorState} message=${rs.error} onRetry=${refreshRooms} />` : null}
    ${!rs.loaded ? html`<${Skeleton} variant="rows" lines=${4} />` : null}
    ${rs.loaded && !rs.error && !rs.denied && !rs.rooms.length ? html`<p class="note hub-list-empty">${hc("noChats")}</p>` : null}
    ${rs.rooms.length && !shown.length ? html`<p class="note hub-list-empty">${hc("noMatch")}</p>` : null}
    <div class="view-roster inst-nav hub-side-rooms"><${HubRoomRows} rooms=${rs.rooms} q=${q} current=${current} href=${(r) => roomPath(r.id)} onGo=${pick} star=${star} /></div>
  </div>`;
}

/**
 * cid-hub-shell-parity (the user: 「agend 排得很好看, agend hub 醜到不行」; approved mockup): the Hub's sidebar is the fleet
 * dashboard's own — style guide rule 1, its shell components, not Hub-only ones. Icon rows (`side-row`): Conversations, My
 * shared agents, Administration (the administrator only), Notices (only where the Hub offers its security notices), Search
 * (Ctrl K: the conversation filter) and New conversation (`side-new`); then the conversation list under a `side-label`
 * section, with a one-line empty state. The app shell mounts it (HubSidebar); an older shell keeps HubNav.
 * Notices has no count: the Hub exposes the retained notices, not which of them this person has read.
 */
export function HubSide({ onPick } = {}) {
  const s = useSession();
  const rs = useRooms();
  const { route } = useStore(navStore);
  const [q, setQ] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  // M-3127 C: on a Hub with rooms, Ctrl K is the search dialog (names, then messages); before rooms, the list's filter.
  const [searching, setSearching] = useState(false);
  const filter = useRef(null);
  useEffect(() => { linkHubChatCss(); }, []);
  const openFilter = () => { if (roomsLive()) { setSearching(true); return; } setFiltering(true); setTimeout(() => filter.current?.focus(), 0); };
  // Ctrl K (⌘K): the conversation filter — the dashboard's search shortcut, on the Hub's own search (no fleet search here).
  useEffect(() => {
    const onKey = (e) => {
      if (e.isComposing || e.altKey || e.shiftKey || !(isMacLike() ? e.metaKey : e.ctrlKey) || (e.key || "").toLowerCase() !== "k") return;
      if (typeof document !== "undefined" && document.querySelector("dialog[open]:not(.side-panel)")) return;
      e.preventDefault(); openFilter();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  if (!s) return null;
  const tab = route && route.panel === "hub" ? route.tab : "ask";
  const view = viewParam();
  const here = (key) => ["notices", "invitations", "teams"].includes(key) ? tab === "ask" && view === key : key === "ask" ? tab === "ask" && view !== "notices" && view !== "invitations" && view !== "teams" : tab === key;
  const go = (e, href) => { if (onPick) onPick(); if (e && (e.metaKey || e.ctrlKey)) return; e && e.preventDefault(); navigate(href); };
  const row = (key, href, icon, label) => html`<a class=${`side-row${here(key) ? " active" : ""}`} href=${href} aria-current=${here(key) ? "page" : undefined}
    onClick=${(e) => go(e, href)}><${Icon} name=${icon} /><span class="grow">${label}</span></a>`;
  // On the chats' own home (no room open, no filter) the page already says "No chats yet": the list doesn't say it twice (Argon #19).
  const home = tab === "ask" && view !== "notices" && !roomParam();
  return html`<nav data-trust="navigation" class="side-nav" aria-label=${t("app.menu")}>
      ${row("ask", "/ui/hub", "chat", hc("chats"))}
      ${row("exposures", "/ui/hub/exposures", "globe", hc("mine"))}
      ${teamsLive() ? html`<${LazyRoomPart} load=${() => import("./hub-teams.js")} name="HubMyTeamsEntry" props=${{ client: hubClient(), person: s.person, active: here("teams"), onPick }} />` : null}
      ${roomsLive() && rs.invitations > 0 ? html`<a class=${`side-row${here("invitations") ? " active" : ""}`} href=${INVITATIONS_PATH} aria-current=${here("invitations") ? "page" : undefined}
        onClick=${(e) => go(e, INVITATIONS_PATH)}><${Icon} name="inbox" /><span class="grow">${hroom("invitationsTitle")}</span><span class="nav-count" title=${hroom("invitationsN", String(rs.invitations))}>${rs.invitations}</span></a>` : null}
      ${manages(s) ? row("admin", "/ui/hub/admin", "key", hc("admin")) : null}
      ${noticesOffered(s) ? row("notices", NOTICES_PATH, "bell", hc("notices")) : null}
      <button type="button" class="side-row side-search" onClick=${openFilter} title=${`${hc("search")} (${searchShortcut()})`}
        aria-keyshortcuts=${isMacLike() ? "Meta+K" : "Control+K"}><${Icon} name="search" /><span class="grow">${hc("navSearch")}</span><kbd class="kbd-hint" aria-hidden="true">${searchShortcut()}</kbd></button>
      ${searching ? html`<${LazyRoomPart} load=${() => import("./hub-room-search.js")} name="RoomSearch" props=${{ client: hubClient(), rooms: rs.rooms || [], onClose: () => setSearching(false),
        openRoom: (r) => { if (onPick) onPick(); navigate(roomPath(r.id)); },
        openHit: (h) => { if (onPick) onPick(); navigate(`${roomPath(h.roomId)}&m=${encodeURIComponent(h.messageId)}`); } }} />` : null}
    </nav>

    ${/* M-3190 (Argon): 新對話 and 新房間 head the conversation list, not the primary rows. */ ""}
    <${HubRoomList} rs=${rs} q=${q} setQ=${setQ} filtering=${filtering} setFiltering=${setFiltering} filterRef=${filter} onPick=${onPick} quietEmpty=${home} foot=${roomsLive()}
      onNew=${() => { if (onPick) onPick(); navigate(NEW_CHAT_PATH); }} onNewRoom=${roomsLive() && rs.me?.canCreateRooms ? () => setNewRoom(true) : null} />
    ${newRoom ? html`<${LazyRoomPart} load=${() => import("./hub-room-new.js")} name="NewRoomDialog" props=${{ client: hubClient(), assistant: !!rs.me?.assistant, purposeSupported: roomPurposeLive(),
      onClose: () => setNewRoom(false), onOpenRoom: (id) => { setNewRoom(false); void refreshRooms(); navigate(roomPath(id)); } }} />` : null}`;
}

/**
 * The conversation list, as the dashboard draws its roster (`view-roster inst-nav > side-section`, the section's label and
 * count, one-line empty states) — the sidebar's (HubSide) and, on a phone, the chats' home page's (with its own New chat
 * row and the filter always shown): one drawing, not two (Argon #9). `quietEmpty`: the page beside it already says "No chats yet".
 */
function HubRoomList({ rs, q, setQ, filtering, setFiltering, filterRef, onPick, quietEmpty = false, onNew = null, onNewRoom = null, foot = false, home = false }) {
  const current = roomParam();
  const star = useRoomStar(rs.rooms, useSession()?.login);   // S-145: favourites, as the Fleet sidebar's
  const go = (e, href) => { if (onPick) onPick(); if (e && (e.metaKey || e.ctrlKey)) return; e && e.preventDefault(); navigate(href); };
  const shown = rs.rooms.filter((r) => !q.trim() || [r.name, r.agent?.owner?.name, r.lastText].some((v) => String(v || "").toLowerCase().includes(q.trim().toLowerCase())));
  const always = home;                                // the phone's home list: its filter is always there (when there's a list to filter)
  return html`<div class="view-roster inst-nav hub-side-rooms"><div data-trust="navigation" class="side-section">
      ${onNew ? html`<button type="button" class="side-row side-new" onClick=${onNew}><${Icon} name="plus" /><span class="grow">${hc("newChat")}</span></button>` : null}
      ${/* Lumen (spec §2): on the phone's list too, beside New chat — not only in the drawer. */ ""}
      ${onNewRoom ? html`<button type="button" class="side-row side-new hub-new-room" onClick=${onNewRoom}><${Icon} name="room" /><span class="grow">${hroom("newRoomTitle")}</span></button>` : null}
      ${!rs.rooms.length ? html`<div class="inst-head"><h2 class="side-label">${hc("chats")}</h2></div>` : null}
      ${/* M-3127 C (web-claude): on a Hub with rooms the sidebar's filter is the Fleet's, at its foot, always there (below). */ ""}
      ${!foot && (filtering || q || (always && rs.rooms.length)) ? html`<label class="hub-side-filter"><${Icon} name="search" size=${14} /><input ref=${filterRef} type="search" placeholder=${hc("search")} aria-label=${hc("search")} value=${q}
        onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => { if (e.key === "Escape") { setQ(""); setFiltering(false); } }} /></label>` : null}
      ${rs.error ? html`<${ErrorState} message=${rs.error} onRetry=${refreshRooms} />` : null}
      ${!rs.loaded ? html`<${Skeleton} variant="rows" lines=${4} />` : null}
      ${rs.loaded && !rs.error && !rs.denied && !rs.rooms.length && !quietEmpty ? html`<p class="side-empty muted">${hc("noChats")}</p>` : null}
      ${rs.rooms.length && !shown.length ? html`<p class="side-empty muted">${hc("noMatch")}</p>` : null}
      <${HubRoomRows} rooms=${rs.rooms} q=${q} current=${current} href=${(r) => roomPath(r.id)} onGo=${(e, r) => go(e, roomPath(r.id))} star=${star} />
    </div>
    ${/* The Fleet sidebar's filter box (instance-nav.js .v-filter): a name or an owner; Esc or ✕ clears it. Ctrl K is the search. */ ""}
    ${foot && rs.rooms.length ? html`<div class="v-filter hub-side-foot-filter">
      <label class="v-filter-box"><${Icon} name="search" size=${14} /><span class="sr-only">${hroom("filterPh")}</span>
        <input ref=${filterRef} type="text" autocomplete="off" spellcheck=${false} placeholder=${hroom("filterPh")} value=${q}
          onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => { if (e.key === "Escape" && q) { e.preventDefault(); e.stopPropagation(); setQ(""); } }} />
        ${q ? html`<button type="button" class="icon-btn v-filter-clear" aria-label=${hroom("filterClear")} title=${hroom("filterClear")}
          onClick=${() => { setQ(""); filterRef.current && filterRef.current.focus(); }}><${Icon} name="close" size=${14} /></button>` : null}
      </label></div>` : null}
  </div>`;
}

/** The phone's chats home: the same roster, with New chat at its head and the filter in place. */
function HubHomeList() {
  const rs = useRooms();
  const [q, setQ] = useState(""), [filtering, setFiltering] = useState(false), [newRoom, setNewRoom] = useState(false);
  const filter = useRef(null);
  return html`<${HubRoomList} rs=${rs} q=${q} setQ=${setQ} filtering=${filtering} setFiltering=${setFiltering} filterRef=${filter} home=${true} onNew=${() => navigate(NEW_CHAT_PATH)}
      onNewRoom=${roomsLive() && rs.me?.canCreateRooms ? () => setNewRoom(true) : null} />
    ${newRoom ? html`<${LazyRoomPart} load=${() => import("./hub-room-new.js")} name="NewRoomDialog" props=${{ client: hubClient(), assistant: !!rs.me?.assistant, purposeSupported: roomPurposeLive(),
      onClose: () => setNewRoom(false), onOpenRoom: (id) => { setNewRoom(false); void refreshRooms(); navigate(roomPath(id)); } }} />` : null}`;
}

/**
 * cid-hub-shell-parity: the sidebar's foot, as the dashboard's — Settings (this device's theme and language: the shell's own
 * DevicePrefs) and the session row ("Signed in", the person's name beside it), whose menu holds Sign out.
 */
export function HubFoot() {
  const s = useSession();
  const [busy, setBusy] = useState(false);
  const prefs = html`<details class="prefs-pop hub-prefs"><summary class="side-row"><${Icon} name="settings" /><span class="grow">${hc("settings")}</span></summary>
    <div data-trust="popover" class="pop" role="group" aria-label=${t("app.devicePrefs")}><${DevicePrefs} labels=${true} fields=${["theme", "language"]} /></div></details>`;
  if (s === undefined) return html`${prefs}<div class="session"><${Skeleton} variant="inline" lines=${1} /></div>`;
  if (!s) return prefs;
  const out = async () => { setBusy(true); await hubClient().signOut(); setBusy(false); setSession(null); };
  // Who is signed in heads the menu — their name and sign-in name (the foot's row says "Signed in", as the dashboard's) — then
  // Sign out. My shared agents and Administration are the sidebar's own rows, not repeated here (Argon #10).
  const items = [
    { key: "who", label: s.login && s.login !== s.displayName ? `${s.displayName} (${s.login})` : s.displayName, icon: "user", disabled: true },
    { key: "out", label: hc("signOut"), icon: "back", onSelect: out, disabled: busy },
  ];
  return html`${prefs}<div class="session hub-session-row"><${Menu} items=${items} label=${hc("signedIn")} cls="hub-session-menu" triggerClass="side-row"
    trigger=${html`<span class="dot ok" aria-hidden="true"></span><span class="grow">${hc("signedIn")}</span><span class="meta" title=${s.displayName}>${s.displayName}</span>`} /></div>`;
}

/** M-3190: 新對話 is the launcher's own address (the sidebar's and the phone list's 新對話 open it). */
const NEW_CHAT_PATH = "/ui/hub?view=new";
/**
 * Once per page load (this window): 對話 opens the most recent room or 1:1 chat, by when it last moved; back on 對話 later shows
 * the list / launcher. M-3204: by recency, never by preview text — the Hub sends a 1:1 chat without one. The one exception is the
 * Hub assistant's chat, which the Hub makes for everyone when the list is read: unused (no message yet) it is not a chat to open.
 */
const openedIn = new WeakSet();
const thisWindow = () => (typeof window !== "undefined" ? window : globalThis);
const autoOpened = () => openedIn.has(thisWindow());
const recentRoom = (rooms) => rooms.filter((r) => !r.archived && (!r.assistant || !!r.lastText))
  .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))[0] || null;

/**
 * The Ask tab: the chosen room; else (M-3190, Argon's chat-first review) the most recent room once per visit, and otherwise the
 * launcher — beside the sidebar's list on a wide screen; on a phone the list, or the launcher on 新對話 or with nothing to list.
 */
function HubChats() {
  useStore(navStore);                               // ?room= changes without a new route
  const rs = useRooms();
  const s = useSession();
  useEffect(() => { linkHubChatCss(); }, []);
  const id = roomParam(), launch = viewParam() === "new";
  const opening = !id && !launch && !autoOpened();
  useLayoutEffect(() => {
    if (!rs.loaded || autoOpened()) return;
    openedIn.add(thisWindow());
    const recent = !id && !launch ? recentRoom(rs.rooms) : null;
    if (recent) navigate(roomPath(recent.id), { replace: true });
  }, [rs.loaded, id, launch]);
  // Today's chats (the list's `legacy` item) open the room view they always had; a room of a Hub with rooms opens the
  // shared thread (M-3092 PR 2).
  const listed = id ? rs.rooms.find((r) => r.id === id) : null;
  const room = id ? (listed ? listed.legacy || listed : rs.loaded ? { id, exposureName: "", ownerName: "", features: [] } : null) : null;
  // A room of a Hub with rooms: the shared thread with the room's store, composer and members panel (hub-room-thread.js).
  if (id && listed && !listed.legacy) return html`<${HubRoomPage} key=${id} roomId=${id} listed=${listed} Thread=${HubThread} client=${hubClient()}
    rooms=${rs.rooms} openRoom=${(rid) => navigate(roomPath(rid))} openDirect=${(m) => openDirectChat(m, rs.rooms)} goList=${() => navigate("/ui/hub")}
    onLeft=${() => { void refreshRooms(); navigate("/ui/hub"); }} onMe=${noteHubMeId} pinsOn=${roomPinsLive()}
    view=${viewParam() === "office" ? "office" : "chat"} officeHref=${(v) => roomViewPath(id, v)} onView=${(v) => navigate(roomViewPath(id, v))} />`;
  if (id && room) return html`<${HubRoomView} key=${id} room=${room} />`;
  if (id) return html`<${HubRoomLoading} error=${rs.error} />`;
  if (opening && (!rs.loaded || recentRoom(rs.rooms))) return html`<${PanelHeader} title=${hc("chats")} /><div class="hub-home"><div class="hub-home-pick center"><${Skeleton} variant="rows" lines=${4} /></div></div>`;
  // On a phone the launcher takes the page on 新對話 and when there is nothing to list; otherwise the list does.
  const alone = launch || (rs.loaded && !rs.error && !rs.rooms.length);
  return html`<${PanelHeader} title=${launch ? hc("newChat") : hc("chats")} />
  ${/* M-3137 (versions spec §2.3): the signed-in person whose own Fleet is behind is told here, once per sign-in. */ ""}
  <${OlderFleetBanner} client=${hubClient()} signIn=${s?.csrf || ""} />
  <div class=${`hub-home${alone ? " is-launch" : ""}`}>
    <div class="hub-home-list"><${HubHomeList} /></div>
    <div class="hub-home-pick hub-home-launch">${rs.error && !rs.rooms.length ? html`<${ErrorState} message=${rs.error} onRetry=${refreshRooms} />` : html`<${ChatLauncher} />`}</div>
  </div>`;
}

/**
 * M-3190: the launcher — one centred column, 「今天想找哪位 Agent？」, one row per agent this person can talk to: shared with them
 * (one-to-one), the Hub's own (the assistant's chat) and the agents in their rooms (the five most recent rooms, read from each
 * room's members); a row opens (or reopens) its chat or room. With no agent shared directly, a compact card says the next step.
 * On a Hub with group permissions the welcome's frame adds its notes and the Fleet status line (hub-welcome.js).
 */
function ChatLauncher() {
  const s = useSession(), rs = useRooms();
  const [cat, reloadCat] = useRead(() => hubClient().catalog());
  // M-3567: a grant given while the page was away (a Team's, a person's) is listed on return, with no reload.
  useOnReturn(() => reloadCat());
  const [inRooms, setInRooms] = useState([]);
  const [q, setQ] = useState(""), [busy, setBusy] = useState(false), [msg, setMsg] = useState(null), [newRoom, setNewRoom] = useState(false);
  const groups = rs.rooms.filter((r) => r.kind === "group" && !r.archived).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 5);
  const groupKey = groups.map((r) => r.id).join(",");
  useEffect(() => {
    let live = true;
    if (typeof hubClient().room !== "function") return undefined;
    Promise.all(groups.map((r) => hubClient().room(r.id).then((d) => (d && Array.isArray(d.members) ? d.members : [])
      .filter((m) => m && m.kind === "agent" && !m.mine).map((m) => ({ key: `room:${r.id}:${m.id}`, name: m.name || "", sub: [m.intro,hc("launchInRoom", r.name)].filter(Boolean).join(" · "), href: roomPath(r.id) })), () => [])))
      .then((all) => { if (live) setInRooms(all.flat()); });
    return () => { live = false; };
  }, [groupKey]);
  const askable = cat && Array.isArray(cat.askable) ? cat.askable : [];
  const open = async (it) => {
    if (busy) return;
    setBusy(true); setMsg(null);
    const r = await hubClient().openRoom(it.exposure.id, it.grant.id);
    setBusy(false);
    if (!r.ok) { setMsg(errText(r)); return; }
    await refreshRooms(); navigate(roomPath(r.room.id));
  };
  const chats = rs.rooms.filter((r) => r.kind !== "group" && !r.archived);
  const shownIn = new Set(chats.map((r) => (r.legacy || r.agent || {}).exposureId).filter(Boolean));
  const rows = [
    ...chats.map((r) => ({ key: r.id, name: r.assistant ? hroom("hubAssistant") : r.name, sub: r.assistant ? hi("assistant") : [r.agent?.intro,r.agent?.owner?.name ? hc("launchOwner", r.agent.owner.name) : ""].filter(Boolean).join(" · "),
      href: roomPath(r.id), online: r.assistant ? (r.presence || "idle") !== "unavailable" : r.agent?.presence === "online" })),
    ...askable.filter((it) => !shownIn.has(it.exposure.id)).map((it) => ({ key: it.grant.id, name: it.exposure.displayName, sub: [it.exposure.intro,it.exposure.answerOnly ? hp("answerOnlyAsker") : hc("launchOwner", it.ownerName || "—")].filter(Boolean).join(" · "), ask: it })),
    ...inRooms,
  ];
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => !needle || `${r.name} ${r.sub}`.toLowerCase().includes(needle));
  const go = (e, r) => { if (r.ask) { e.preventDefault(); void open(r.ask); return; } if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(r.href); };
  const list = html`<h2 class="hub-launch-title">${hc("launchTitle")}</h2>
    ${rows.length > 8 ? html`<label class="field hub-launch-filter"><span class="sr-only">${hc("launchFilter")}</span><input type="search" placeholder=${hc("launchFilter")} value=${q} onInput=${(e) => setQ(e.target.value)} /></label>` : null}
    ${!cat || !rs.loaded ? html`<${Skeleton} variant="rows" lines=${3} />` : html`<div class="hub-launch-rows" role="list">${shown.map((r) => html`<a key=${r.key} role="listitem" class="hub-launch-row"
        href=${r.href || NEW_CHAT_PATH} aria-disabled=${r.ask && busy ? "true" : undefined} onClick=${(e) => go(e, r)}>
        <span class="hub-launch-av"><${Avatar} name=${r.name} />${r.online ? html`<span class="dot ok" aria-hidden="true"></span>` : null}</span>
        <span class="hub-launch-text"><strong>${r.name}</strong><small>${r.sub}</small></span><span class="hub-launch-go" aria-hidden="true">${hc("launchGo")}</span></a>`)}</div>
      ${rows.length && !shown.length ? html`<p class="note">${hc("launchNoMatch")}</p>` : null}`}
    ${cat && cat.error ? html`<${ErrorState} message=${cat.error} onRetry=${reloadCat} />` : null}
    ${cat && !cat.error && !askable.length ? html`<section class="hub-launch-empty" data-launch="none-shared"><strong><${Icon} name="chat" size=${18} />${hc("launchNone")}</strong>
      <p>${hc("launchNoneHint")}</p>
      <div class="hub-launch-actions">${roomsLive() && rs.me?.canCreateRooms ? html`<button type="button" class="btn btn-primary hub-launch-pill" onClick=${() => setNewRoom(true)}><${Icon} name="room" size=${16} />${hc("launchNewRoom")}</button>` : null}
        <a class="btn hub-launch-pill" href="/ui/hub/exposures" onClick=${(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate("/ui/hub/exposures"); }}><${Icon} name="globe" size=${16} />${hc("launchShare")}</a></div></section>` : null}
    ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
    ${newRoom ? html`<${LazyRoomPart} load=${() => import("./hub-room-new.js")} name="NewRoomDialog" props=${{ client: hubClient(), assistant: !!rs.me?.assistant, purposeSupported: roomPurposeLive(),
      onClose: () => setNewRoom(false), onOpenRoom: (rid) => { setNewRoom(false); void refreshRooms(); navigate(roomPath(rid)); } }} />` : null}`;
  return html`<div class="hub-launch">${groupPolicyOn(s, hubClient())
    ? html`<${LazyGroups} pick=${(m) => m.ChatLauncherFrame || (({ children }) => children)} props=${{ admin: s.admin === true, features: s.features, children: list }} />` : list}</div>`;
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
const REASONS = { "share-needs-reshare": "reason_reshare", expired: "reason_expired", revoked: "reason_revoked", frozen: "reason_frozen", withdrawn: "reason_withdrawn" };
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
        roomsStore.set((rs) => ({ ...rs, rooms: rs.rooms.map((r) => (r.id === given.id ? (r.legacy ? { ...r, legacy: { ...r.legacy, waiting } } : { ...r, waiting }) : r)) }));
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
  const denied = store.accessDenied?.() === true;
  useEffect(() => {
    if (!denied) setMsg(current => current === errText({ code: "denied" }) ? null : current);
  }, [denied]);
  const paused = !closed && room.exposureState === "paused";
  const frozen = !closed && (room.exposureState === "frozen" || paused);
  const working = store.working();
  const name = room.exposureName || "";
  const client = hubClient();
  const pageFiles = pageCarriesFiles(client, store);
  const takesFiles = pageFiles && roomTakesFiles(room) && !closed && !frozen && !denied;
  const uploading = files.some((f) => f.state === "uploading");
  const send = async () => {
    const q = draft.trim();
    if (!q || sending || closed || frozen || denied) return;
    if (uploading) { setMsg(hf("waitUpload")); return; }
    // Chosen files are never dropped quietly: while the room can't take them, the question waits (or they are removed).
    const chosen = filesRef.current.filter((f) => f.state === "ready");
    if (chosen.length && !takesFiles) { setMsg(hf("held")); return; }
    setSending(true); setMsg(null);
    const r = await store.send(q, chosen.length ? { files: chosen.map((f) => f.id) } : {});
    setSending(false);
    if (!r.ok) { setMsg(r.code === "sharing-paused" ? null : errText(r)); return; }
    // Only the files this question carried; ones chosen while it was on its way stay for the next.
    const sent = new Set(chosen.map((f) => f.key));
    setDraft(""); setFiles(filesRef.current.filter((f) => !sent.has(f.key))); refreshRooms();
  };
  // M-3311: a paste (#4151 review: this composer's was empty) and a drop attach as the Fleet chat's — `left` and `notice` for them.
  const attach = takesFiles ? { title: hf("attach"), left: () => MAX_FILES - filesRef.current.length, notice: (text) => { if (alive.current) toast(text); },
    onFiles: async (list) => {
      setMsg(null);
      const refused = await uploadChosen(client, room.id, list, { current: () => filesRef.current, set: setFiles, alive: () => alive.current });
      if (!alive.current) return refused;
      if (refused.length) setMsg(refused.join(" "));
      return refused;
    } } : null;
  const mainRef = useRef(null);
  useFileDrop(mainRef, attach);
  // M-3311 (2): 「引用」 on a selected passage goes into this question's box (the thread reads it at selection time; the box is
  // there only while the conversation is open).
  const askExtra = useMemo(() => ({ quote: { field: () => input.current } }), []);
  const onKeyDown = (e) => { if (globalThis.AgendChatRender?.composerKey(e, { touch: touchScreen() }) === "send") { e.preventDefault(); send(); } };
  const toggleInfo = () => {
    if (!wide) { setSheet(true); return; }
    // The panel is where the rail was: the info button puts the rail back (and closes the page).
    if (panelOpen) { closePanel(); setRail(true); setRailPref(true); return; }
    setRail((v) => { setRailPref(!v); return !v; });
  };
  const tag = closed ? html`<span class="tag danger">${hc("tagClosed")}</span>` : frozen ? html`<span class="tag warn">${paused ? t("hubSharing.paused") : hc("tagFrozen")}</span>`
    : denied ? html`<span class="tag warn">${ha("tag")}</span>` : html`<${QuotaChip} room=${room} fallback=${html`<span class="tag ok">${hc("tagCanAsk")}</span>`} />`;
  const back = !wide ? html`<a class="icon-btn hub-back" href="/ui/hub" aria-label=${hc("back")} title=${hc("back")}><${Icon} name="back" /></a>` : null;
  const info = html`<${HubRoomInfo} room=${room} closed=${closed} denied=${denied} />`;
  // The panel takes the info rail's place while it shows a page (the rail's button brings the rail back).
  const showRail = wide && rail && !panelOpen;
  return html`<div class=${`hub-chat${showRail ? " with-rail" : ""}`} ref=${split}>
    <section class="hub-chat-main" aria-label=${name} ref=${mainRef}>
      ${attach ? html`<${DropOverlay} />` : null}
      <header class=${`hub-chat-head${room.answerOnly?" hub-answer-only-head":""}`} data-trust="panel-content">${back}<${Avatar} name=${name} size="sm" />
        <span class="hub-chat-title"><strong>${name}</strong><span class=${`s${room.answerOnly?" hub-answer-only-note":""}`}>${room.answerOnly?hp("answerOnlyAsker"):room.ownerName ? hc("answersFor", room.ownerName) : ""}</span>${room.intro?html`<span class="s hub-agent-intro-line">${room.intro}</span>`:null}</span>
        ${tag}
        <button type="button" class="icon-btn" aria-pressed=${wide ? String(showRail) : undefined} aria-label=${hc("showInfo")} title=${hc("showInfo")} onClick=${toggleInfo}><${Icon} name="info" /></button>
        <span class="hub-head-tools"><${TextSizeButton} /></span>
      </header>
      <${HubThread} store=${store} name=${name} panelKey=${panelKey} threadRef=${threadRef} extra=${askExtra} />
      <div class="dock hub-dock" data-trust="composer"><div class="dock-col">
        ${closed ? html`<p class="hub-banner danger" role="status">${hc("closed")}</p>` : null}
        ${frozen ? html`<p class="hub-banner warn" role="status">${paused ? t("hubSharing.pausedChat", name) : hc("frozen", name)}</p>` : null}
        ${!closed ? html`<${QuotaBanner} room=${room} />` : null}
        ${denied && !closed ? html`<div class="hub-banner warn" role="status">${ha("refused")}<div class="n-actions"><button type="button" class="btn btn-sm" onClick=${() => store.refresh()}>${ha("check")}</button></div></div>` : null}
        ${working ? html`<${HubWorkBar} name=${name} since=${working.since} />` : null}
        ${!closed && !frozen && !denied && !takesFiles ? html`<p class="note hub-files-off" role="status">${hf(pageFiles ? "off" : "reload")}</p>` : null}
        ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
        ${closed ? null : html`<div class="composer-box"><${PendingFiles} files=${files} onRemove=${(key) => setFiles(filesRef.current.filter((f) => f.key !== key))}
          onAsText=${(key) => { const f = filesRef.current.find((x) => x.key === key); if (!f) return; setFiles(filesRef.current.filter((x) => x.key !== key)); putBackText(input.current, f.text); input.current?.focus(); }}
          formatSize=${(n) => (globalThis.AgendChatRender?.formatSize ? globalThis.AgendChatRender.formatSize(n) : `${n} B`)} />
          <${ComposerInput} inputRef=${input} value=${draft} placeholder=${hc("composer", name)} onValue=${setDraft}
          onKeyDown=${onKeyDown} onPaste=${(e) => { if (!frozen && !denied) pasteToAttach(e, attach); }} attach=${attach}
          stop=${{ hidden: true, disabled: true, title: hc("stop"), label: hc("stop"), onClick: () => {} }}
          send=${{ hidden: false, disabled: !draft.trim() || sending || frozen || denied || uploading, label: hc("send"), onClick: send }} /></div>`}
        ${closed ? null : html`<div class="composer-row hub-hints"><span class="hint hub-enter-hint">${t(touchScreen() ? "chat.nativeComposerHintTouch" : "chat.nativeComposerHint")}</span><span class="hint hub-identity">${hw("roomNote")}</span></div>`}
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
function HubThread({ store, name, panelKey, threadRef, extra = null, emptyView = null }) {
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
      // M-3092: a room of a Hub with rooms (hub-room-thread.js) says whose messages are mine, and replies and quotes.
      ...(extra || {}),
    });
    th.current = thread;
    if (threadRef) threadRef.current = thread;
    host.current.append(list);
    thread.attach(scroller.current);
    thread.render(store.messages());
    const sc = scroller.current;
    // The next `before=` page when the reader is at the top, or when the held messages do not fill the view. createThread
    // already grows through what is held; a tall room at the bottom must not fetch the whole history on open.
    let paging = true;
    const maybeOlder = () => {
      if (!paging || !sc || typeof store.older !== "function" || !store.more?.()) return;
      const high = sc.scrollHeight, view = sc.clientHeight;
      if (high > view && sc.scrollTop >= 96) return;
      void store.older();
    };
    const off = store.subscribe(() => { thread.render(store.messages()); maybeOlder(); });
    requestAnimationFrame(() => requestAnimationFrame(maybeOlder));
    // A card shows whether this browser allows previews and whether the panel has its page.
    const P = globalThis.AgendPreview;
    const offOpt = P && typeof P.onChange === "function" ? P.onChange(() => thread.refreshCards()) : () => {};
    const offPanel = panelStore.subscribe(() => thread.refreshCards());
    const onScroll = () => { thread.onScroll(); maybeOlder(); };
    sc.addEventListener("scroll", onScroll, { passive: true });
    list.addEventListener("click", thread.onClick);
    // S-152 (M-3117): the Fleet chat's message menu — right-click, a phone's long press (where the hover strip is hidden),
    // swipe left to reply, R on a focused message. Reply where this page may reply (a room), Copy text everywhere; no Copy
    // link (a Hub message has no address). React (the picker) when the page gives extra.react (M-3127).
    const ex = extra || {};
    const offActions = installMessageActions(list, {
      t: threadT, messageOf: thread.messageOf, rove: thread.rove, copyText, notice: (text, ok = true) => toast(text, ok),
      canReply: () => (typeof ex.canReply === "function" ? ex.canReply() !== false : false) && typeof ex.startReply === "function",
      reply: (x) => ex.startReply?.(x),
      // React opens the thread's picker for that message (extra.react is the thread's own add/remove call, with an emoji).
      ...(typeof ex.react === "function" ? { react: (x) => thread.pickReaction?.(msgKey(x)), canReact: (x) => !!x.roomMessage && ex.canReact?.(x) !== false, reactLabel: ex.reactLabel } : {}),
      // M-3311 (3): Copy link where the page gives a message an address (a room: extra.linkOf).
      ...(typeof ex.linkOf === "function" ? { linkOf: (x) => ex.linkOf(x) } : {}),
      // M-3340: Pin / Unpin where the page keeps pins (a room of a Hub with room-pins-v1: extra.pin), mine only.
      ...(typeof ex.pin === "function" ? { pin: (x) => ex.pin(x), pinned: (x) => ex.pinned?.(x) === true, canPin: (x) => ex.canPin?.(x) !== false } : {}),
    });
    // M-3311 (2): the Fleet chat's 「引用」 — a passage selected in one message goes into this conversation's composer as a quote
    // at the caret (chat-quote.js; panel-chat.js's own install), through the box's typing path. `extra.quote.field()`: the box.
    const q = ex.quote;
    const phone = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    const offQuote = q ? installQuoteSelection(list, {
      field: () => q.field(), canQuote: () => !!q.field() && q.can?.() !== false, phone,
      composerBox: () => q.field()?.closest?.(".composer-box") || null, threadBox: () => sc,
      insert: (text) => {
        const field = q.field(); if (!field) return;
        const value = field.value || "";
        // The caret where the person left it in the box (kept when it lost the focus); never touched: the end.
        const caret = field.dataset.touched === "1" ? composerCaret(field, value) : value.length;
        const r = insertQuote(value, caret, text); if (!r) return;
        const set = typeof HTMLTextAreaElement === "function" ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set : null;
        if (set) set.call(field, r.value); else field.value = r.value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        // After the box redraws: the caret after the quote, in view. A phone keeps its keyboard down.
        setTimeout(() => {
          if (q.field() !== field) return;
          field.dataset.touched = "1";
          try { field.setSelectionRange(r.caret, r.caret); } catch { /* not a text field */ }
          if (!phone()) field.focus();
          showCaret(field, r.caret);
        }, 0);
      },
    }) : () => {};
    // M-3326: the Fleet chat's table cell selection (a desk; chat-table-select.js), in every Hub conversation.
    const offCells = installTableSelection(list, { phone });
    return () => {
      offActions(); offQuote(); offCells();
      paging = false;
      off(); offOpt(); offPanel(); sc.removeEventListener("scroll", onScroll); list.removeEventListener("click", thread.onClick);
      thread.dispose(true); list.remove(); th.current = null; if (threadRef && threadRef.current === thread) threadRef.current = null;
    };
  }, [store]);
  // M-3493: the Fleet chat's 最新 (M-3492): it fades out JUMP_IDLE_MS after the last scroll (shared/jump-idle.js).
  const jumpIdle = useJumpIdle(scroller, jump.show, store);
  return html`<div class="scroller hub-scroller" ref=${scroller}>
    <div class="thread-host" ref=${host}></div>
    ${/* #3145: that every asker shares the agent's one conversation is said before anyone types. */ ""}
    ${!loaded && !store.error() && !store.closed() ? html`<${Skeleton} variant="rows" lines=${5} />` : null}
    ${store.error() === "backpressure" ? html`<p class="hub-banner warn" role="status">${hr("busy")}</p>`
      : !loaded && store.error() ? html`<${ErrorState} message=${errText({ code: store.error() })} onRetry=${() => store.refresh()} />` : null}
    ${empty && loaded && !store.closed() && emptyView ? html`<div class="center hub-room-empty">${emptyView}</div>` : null}
    ${empty && loaded && !store.closed() && !emptyView ? html`<div class="center hub-room-empty"><${Empty} icon="chat" title=${hc("emptyRoom", name)} hint=${personalAgentQuestionHint(store.room())??`${hc("emptyRoomHint", store.room().ownerName || name)}${lang() === "zh-TW" ? "" : " "}${hw("roomShared")}`} /></div>` : null}
    <div class="jump-dock">${jump.show ? html`<button data-trust="thread-control" type="button" ref=${jumpIdle.ref} class=${`jump-latest${jumpIdle.idle ? " is-idle" : ""}`}
      onClick=${() => th.current && th.current.jumpLatest()} onFocus=${jumpIdle.onFocus} onBlur=${jumpIdle.onBlur}>
      <${Icon} name="down" size=${16} />${jump.unseen > 0 ? t("chat.newBelow", jump.unseen) : t("chat.jumpLatest")}</button>` : null}</div>
  </div>`;
}

/** The right-hand panel's cards (the usage rail's look): the agent, its quota (G), your access, who sees it, what is not here. */
function HubRoomInfo({ room, closed = false, denied = false }) {
  const name = room.exposureName || "", owner = room.ownerName || "";
  return html`<section class="u-provider hub-card hub-agent-card"><${Avatar} name=${name} size="lg" /><strong>${name}</strong>${room.intro?html`<p class="note">${room.intro}</p>`:null}
      ${owner ? html`<span class="note">${hc("answersFor", owner)}</span>` : null}</section>
    <${QuotaCard} room=${room} />
    ${room.grantExpiresAt && !closed ? html`<section class="u-provider hub-card"><div class="u-head"><strong>${hc("yourAccess")}</strong></div>
      <dl class="hub-kv"><dt>${hc("canDo")}</dt><dd>${denied ? ha("limited") : hc("canDoValue")}</dd><dt>${hc("until")}</dt><dd>${dateOnly(room.grantExpiresAt)} <span class="tag">${daysLeft(room.grantExpiresAt)}</span></dd></dl>
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
const stateTag = (state, personal = false) => state === "published" ? html`<span class="tag ok">${personal ? hp("publicationSaved") : ho("stateShared")}</span>`
  : state === "paused" ? html`<span class="tag warn">${t("hubSharing.paused")}</span>`
  : state === "frozen" ? html`<span class="tag warn">${ho("statePaused")}</span>` : html`<span class="tag">${ho("stateWithdrawn")}</span>`;
const mayAsk = (n) => (n === 0 ? ho("mayAskNone") : n === 1 ? ho("mayAskOne") : ho("mayAsk", n));
const grantSummary = (grants = []) => grants.some(g => ["group", "team"].includes(g.subject?.kind)) ? t("hubGrantStatus.grantSubjects", grants.length) : mayAsk(grants.length);
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
  const introSession=useSession();
  useStore(navStore);                                 // ?agent= changes without a new route
  const [cat, reload] = useRead(() => hubClient().catalog());
  const [pairings, reloadPairings] = useRead(() => hubClient().pairings());
  const [msg, setMsg] = useState(null);
  const [allowTarget, setAllowTarget] = useState(null);
  const modernSharing = session?.features?.includes("agent-sharing-v1") && hubClient()?.agentSharingV1 === true;
  useEffect(() => {
    linkHubChatCss(); linkHubOwnerCss();
    if (!document.querySelector('link[data-hub-sharing-css="1"]')) {
      const link = document.createElement("link"); link.rel = "stylesheet"; link.href = assetUrl("/assets/hub-sharing.css");
      link.setAttribute("data-hub-sharing-css", "1"); document.head.appendChild(link);
    }
  }, []);
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
  // Nothing shared yet: the empty state below says where to share from, so the lead doesn't say it too (Argon #20).
  return html`<div class="col hub-owner">${!modernSharing ? html`<${OlderFleetBanner} client=${hubClient()} signIn=${session?.csrf || ""} />` : null}<p class="s-page-lead hub-page-lead">${modernSharing ? ho("mineLeadNew") : ho(cat && !cat.error && !mine.length ? "mineLeadShort" : "mineLead")}</p>
    <div class="s-section-layout">
      ${/* M-3190: 「我的 Fleet」 moved here from 對話 — the person's Fleets and the steps to connect one. */ ""}
      ${groupPolicyOn(session, hubClient()) ? html`<${LazyGroups} pick=${(m) => m.MyFleetsCard || (() => null)} props=${{ quick: session.features.includes("quick-pairing-v1"), admin: session.admin === true, features: session.features, compact: modernSharing }} />` : null}
      ${session?.features?.includes("personal-agents-v1") ? html`<${LazyRoomPart} load=${() => import("./hub-personal-agent.js")} name="HubPersonalAgent" props=${{client:hubClient(),scope:session.csrf,isAdmin:session.admin===true,onSaved:reload}} />` : null}
      ${roomsLive() ? html`<${LazyRoomPart} load=${() => import("./hub-invitations.js")} name="InvitationsList" props=${{ client: hubClient(), heading: true }} />` : null}
      ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
      ${!pairings ? html`<${Skeleton} lines=${2} />` : pairings.error ? html`<${ErrorState} message=${pairings.error} onRetry=${reloadPairings} />` : null}
      ${pend.length ? html`<section class="card hub-pairings"><h3>${ho("pendingPairings")}</h3><p class="note">${ho("pendingLead")}</p>
        <div class="hub-rows">${pend.map((p) => html`<div key=${p.id} class="s-row hub-row">
          <span class="hub-row-text"><code class="hub-fp-groups">${compareGroups(p.fingerprint)}</code><small class="note">${hw("expires", when(p.expiresAt))}</small></span>
          ${p.ownerConfirmed ? html`<span class="tag ok">${hw("confirmed")}</span>` : html`<button type="button" class="btn btn-sm btn-primary" onClick=${() => confirmPairing(p)}>${hw("confirmPairing")}</button>`}
        </div>`)}</div></section>` : null}
      ${!cat ? html`<${Skeleton} variant="rows" lines=${4} />` : cat.error ? html`<${ErrorState} message=${cat.error} onRetry=${reload} />` : null}
      ${introNoticeOffered(introSession,hubClient())?html`<${IntroNotice} client=${hubClient()} />`:null}
      ${modernSharing ? html`<${LazyRoomPart} load=${() => import("./hub-my-agents.js")} name="HubMyAgents" props=${{ client: hubClient(), scope: session.csrf, shared: mine, policy: groupPolicyOn(session, hubClient()), personal: session.features.includes("personal-agents-v1"), apps: session.features.includes("mcp-apps-v1"), pausable: session.features.includes("sharing-pause-v1"), subjects: session.features.includes("grant-subjects-v1"), onChanged: reload, onAllow: setAllowTarget }} />` : null}
      ${!modernSharing && cat && !cat.error && !mine.length ? html`<div class="center hub-empty"><${Empty} icon="globe" title=${hw("exposuresEmpty")} hint=${hw("exposuresHint")} /></div>` : null}
      ${!modernSharing && mine.length ? html`<section class="card hub-shared"><h3>${ho(mine.some(e => e.kind === "personal") ? "yourAgentsCount" : "sharedCount", mine.length)}</h3>
        <div class="hub-rows">${mine.map((e) => html`<a key=${e.id} class="s-row hub-row hub-row-link" href=${`/ui/hub/exposures?agent=${encodeURIComponent(e.id)}`}>
          <${Avatar} name=${e.displayName} /><span class="hub-row-text"><strong>${e.displayName}</strong>${e.intro?html`<small class="note">${e.intro}</small>`:null}<small class="note">${grantSummary(e.grants)}</small></span>
          ${stateTag(e.state, e.kind === "personal")}<${Icon} name="next" size=${16} /></a>`)}</div></section>` : null}
      ${mine.length > 0 && session?.features?.includes("room-owner-requests-v1") ? html`<${LazyRoomPart} load=${() => import("./hub-room-owner-requests.js")} name="OwnerAgentRequestSetting" props=${{ client: hubClient(), scope: session.csrf }} />` : null}
    </div>${allowTarget ? html`<${AllowDialog} x=${allowTarget} act=${act} onClose=${() => setAllowTarget(null)} />` : null}</div>`;
}

/** One shared agent: who may ask (allow, revoke), whether askers see its quota (G), who asked lately, pause. */
function HubAgentPage({ x, act, msg }) {
  const session = useSession(), client = hubClient();
  const resumable = session?.features?.includes("sharing-pause-v1") && client?.sharingPauseV1 === true && typeof client.sharing === "function";
  const [sharingBusy, setSharingBusy] = useState(false);
  // M-3092: how many rooms this agent is in — reported by its 「在這些房間裡」 section's own read (one read, no second count).
  const [roomCount, setRoomCount] = useState(null);
  const sharing = async () => {
    if (sharingBusy) return; setSharingBusy(true);
    try { await act(() => client.sharing(x.id, x.revision, x.sharingEpoch ?? 0, x.state !== "paused")); }
    finally { setSharingBusy(false); }
  };
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
    <${PageHead} title=${x.displayName} scope=${stateTag(x.state, x.kind === "personal")} lead=${!grants.length && roomCount > 0
      ? `${hroom("agentNoOneToOne")} · ${roomCount === 1 ? hroom("inRoomsOne") : hroom("inRoomsMany", String(roomCount))}` : grantSummary(grants)} />
    <div class="s-section-layout">
      ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
      ${session?.features?.includes("agent-intros-v1") && client.agentIntrosV1 ? html`<${AgentIntroEditor} exposure=${x} client=${client} onSaved=${()=>act(async()=>({ok:true}))} />` : null}
      <section class="card"><div class="hub-card-head"><h3>${ho("whoMayAsk")}</h3>${shared ? html`<button type="button" class="btn btn-sm" onClick=${() => setAllowing(true)}><${Icon} name="plus" size=${14} />${ho("allow")}</button>` : null}</div>
        ${grants.length ? html`<div class="hub-rows">${grants.map((g) => html`<div key=${g.id} class="s-row hub-row">
          <${Avatar} name=${g.subjectName || g.subjectLogin} size="sm" />
          <span class="hub-row-text"><strong>${g.subjectName || g.subjectLogin}</strong><small class="note">${g.subjectLogin ? html`<code>${g.subjectLogin}</code> · ` : null}${ho("untilLeft", dateOnly(g.expiresAt), DAYS_LEFT(g.expiresAt))}</small>${g.subject?.kind === "group" ? html`<small class="tag">${t("hubGrantStatus.grantADGroup")}</small>` : g.subject?.kind === "team" ? html`<small class="tag">${t("hubGrantStatus.grantTeam")}</small>` : g.subjectSignedIn === false ? html`<small class="tag warn">${t("hubGrantStatus.grantNeverSignedIn")}</small>` : null}</span>
          <${Menu} label=${ho("rowMenu", g.subjectName || g.subjectLogin)} items=${[{ key: "revoke", label: ho("revokeItem"), icon: "trash", danger: true, onSelect: () => revoke(g) }]} />
        </div>`)}</div>` : html`<p class="note">${roomCount > 0 ? hroom("agentNoOneToOne") : hw("noGrants")}</p>`}
        ${roomCount > 0 ? html`<p class="note hub-rooms-can-ask">${hroom("roomsCanAskIt")}</p>` : null}
      </section>
      ${session?.features?.includes("room-agent-discovery-v1") && typeof client.agentRoomDiscovery === "function" ? html`<${LazyRoomPart} load=${() => import("./hub-room-owner-requests.js")} name="OwnerAgentDiscoverySetting" props=${{ client, scope: session.csrf, exposure: x }} />` : null}
      ${roomsLive() ? html`<${LazyRoomPart} load=${() => import("./hub-invitations.js")} name="AgentRoomsSection" props=${{ client: hubClient(), exposureId: x.id, onRooms: setRoomCount }} />` : null}
      <${QuotaVisibilityRow} exposure=${x} onSaved=${() => act(async () => ({ ok: true }))} />
      <section class="card"><h3>${ho("recent")}</h3><p class="note">${ho("recentLead")}</p>
        ${!activity ? html`<${Skeleton} variant="rows" lines=${3} />` : activity.error ? html`<${ErrorState} message=${activity.error} onRetry=${reloadActivity} />` : null}
        ${activity && !activity.error && !acts.length ? html`<p class="note">${ho("recentNone")}</p>` : null}
        ${acts.length ? html`<div class="hub-rows">${acts.map((a, i) => html`<div key=${i} class="s-row hub-row">
          <${Avatar} name=${a.askerName || "?"} size="sm" /><span class="hub-row-text"><strong>${a.askerName || "—"}</strong><small class="note">${when(a.askedAt)}</small></span>${stageWord(a.stage)}
        </div>`)}</div>` : null}
        <div class="field-row"><button type="button" class="btn btn-sm btn-ghost" onClick=${reloadActivity}>${ho("refresh")}</button></div>
      </section>
      ${resumable && (shared || x.state === "paused") ? html`<section class="card hub-sharing-control"><h3>${t("hubSharing.title")}</h3><p class="note">${t("hubSharing.lead")}</p>
        <div class="field-row"><button type="button" class="btn btn-sm btn-primary" disabled=${sharingBusy} onClick=${sharing}>${t(sharingBusy ? "hubSharing.waiting" : x.state === "paused" ? "hubSharing.resume" : "hubSharing.pause")}</button></div></section>` : null}
      ${shared || x.state === "paused" ? html`<section class="card hub-danger"><h3>${ho("pauseTitle")}</h3><p class="note">${ho("pauseLead")}</p>
        <div class="field-row"><button type="button" class="btn btn-sm btn-danger" onClick=${freeze}>${ho("pauseGo")}</button></div></section>` : null}
    </div>
    ${allowing && shared ? html`<${AllowDialog} x=${x} act=${act} onClose=${() => setAllowing(false)} />` : null}
  </div>`;
}

function AllowDialog({ x, act, onClose }) {
  const s = useSession(), client = hubClient(), marked = s?.features?.includes("grant-subjects-v1") && client?.grantSubjectsV1 === true && typeof client.searchGrantSubjects === "function";
  const [Picker, setPicker] = useState(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!marked) return; let live = true;
    import("./hub-grant-picker.js").then(m => { if (live) { if (typeof m.HubGrantPicker === "function") setPicker(() => m.HubGrantPicker); else setFailed(true); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [marked]);
  if (!marked || failed) return html`<${LegacyAllowDialog} x=${x} act=${act} onClose=${onClose} />`;
  if (Picker) return html`<${Picker} x=${x} client=${client} act=${act} onClose=${onClose} />`;
  return html`<${Dialog} title=${ho("allowTitle", x.displayName)} onClose=${onClose}><${Skeleton} rows=${2} /></${Dialog}>`;
}
function LegacyAllowDialog({ x, act, onClose }) {
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
/**
 * M-3162 (Lumen): Administration's tabs — Overview (the counts dashboard, the default where this Hub serves it), Manage
 * (today's long page, unchanged), Teams, Groups and This Hub (with its directory page); a tab whose feature is off is not
 * drawn. The tab is the address's ?view=, so a reload or a shared link lands on it. On a phone the row scrolls sideways.
 */
const ADMIN_TAB_VIEWS = { overview: "overview", manage: "manage", teams: "teams", groups: "groups", roles: "roles", "this-hub": "this-hub", directory: "this-hub" };
let pendingAnchor = "";   // M-3162: a card on Manage to bring into view once it is drawn (Overview's links: "join", "fleets")
export function takeAdminAnchor() { const a = pendingAnchor; pendingAnchor = ""; return a; }
function openAdminTab(view, anchor = "") { pendingAnchor = anchor; navigate(`/ui/hub/admin?view=${view}`); }
function AdminTabs({ tabs, current }) {
  const row = useRef(null);
  useEffect(() => { row.current?.querySelector?.('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [current]);
  const label = { overview: hat("overview"), manage: hat("manage"), teams: hat("teams"), groups: hat("groups"), roles: hat("roles"), "this-hub": hat("thisHub") };
  return html`<div class="hub-admin-tabs-wrap"><nav class="hub-admin-tabs" aria-label=${hat("label")} ref=${row}>
    ${tabs.map((k) => html`<a key=${k} href=${`/ui/hub/admin?view=${k}`} class=${`hub-admin-tab${k === current ? " active" : ""}`} aria-current=${k === current ? "page" : undefined}
      onClick=${(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); openAdminTab(k); }}>${label[k]}</a>`)}
  </nav></div>`;
}
function HubAdmin({ admin }) {
  useStore(navStore);                               // ?view= changes without a new route
  const s = useSession();
  const [overviewGone, setOverviewGone] = useState(false);   // the route answered 404: an older Hub after all
  useEffect(() => { linkHubOwnerCss(); }, []);             // the tab row and Overview are styled there too (not only Manage)
  if (!admin && !manages(s)) return html`<div class="center hub-empty"><${Empty} icon="key" title=${hw("adminOnly")} hint=${hw("adminOnlyHint")} /></div>`;
  const directory = s?.features?.includes("directory-editor-v1") && hubClient()?.directoryEditorV1 === true;
  const groups = groupPolicyOn(s, hubClient()), teams = teamsLive(), roles = rolesOn(s,hubClient());
  const canRole = admin || s?.management?.some(p => ["roles.assign","audit.view"].includes(p));
  const canManage = admin || s?.management?.some(p => ["fleets.manage","join.manage"].includes(p));
  const overview = !overviewGone && s?.features?.includes("admin-dashboard-v1") && typeof hubClient()?.adminDashboard === "function";
  const tabs = [admin && overview ? "overview" : null, canManage ? "manage" : null, admin && teams ? "teams" : null, roles && canRole ? "roles" : admin && groups ? "groups" : null, admin ? "this-hub" : null].filter(Boolean);
  const view = adminView();
  const selected = roles && ["groups","allowed-list"].includes(view) ? "roles" : ADMIN_TAB_VIEWS[view];
  const current = view === "" ? tabs[0] : tabs.includes(selected) ? selected : tabs[0];
  const bar = html`<${AdminTabs} tabs=${tabs} current=${current} />`;
  if (current === "overview") return html`${bar}<div class="col hub-owner hub-admin-ov-col"><${LazyRoomPart} load=${() => import("./hub-admin-overview.js")} name="HubAdminOverview"
    props=${{ client: hubClient(), onOpen: openAdminTab, onGone: () => { setOverviewGone(true); openAdminTab("manage"); } }} /></div>`;
  if (current === "this-hub") return html`${bar}${directory && view === "directory" ? html`<${LazyDirectory} session=${s} />` : html`<div class="col hub-owner"><div class="s-section-layout"><${LazyThisHub} directory=${directory} />${s?.features?.includes("mcp-apps-v1")?html`<${LazyRoomPart} load=${()=>import("./hub-ai-apps.js")} name="AiAppsAdminCard" props=${{client:hubClient()}}/>`:null}</div></div>`}`;
  if(current==="roles"&&view==="allowed-list"&&admin&&groups)return html`${bar}<${LazyGroups} pick=${m=>m.HubGroupPolicyPage} props=${{roleShortcut:true}} />`;
  if (current === "roles") return html`${bar}<div class="col hub-owner"><${LazyRoomPart} load=${() => import("./hub-roles.js")} name="HubRoles" props=${{client:hubClient()}} /></div>`;
  if (current === "groups") return html`${bar}<${LazyGroups} pick=${(m) => m.HubGroupPolicyPage} props=${{}} />`;
  if (current === "teams") return html`${bar}<div class="col hub-owner"><h2 class="sr-only">${ht("title")}</h2><${LazyRoomPart} load=${() => import("./hub-teams.js")} name="HubTeamsPage" props=${{ client: hubClient(), mode: "admin", person: s?.person }} /></div>`;
  // Reached from a fleet's Settings link on a Hub (or a tab) without group permissions: say so instead of a silent admin page.
  const unavailable = view === "groups" && !groups;
  return html`${bar}${unavailable ? html`<p class="note" role="status" data-groups="unavailable">${t("hubGroupsNote.unavailable")}</p>` : null}
    <${HubAdminPage} groups=${groups} companyJoin=${s?.features?.includes("company-join-v1")} directory=${directory} />`;
}
function LazyDirectory({ session }) {
  const [Page, setPage] = useState(null);
  useEffect(() => { let live = true; import("./hub-directory-editor.js").then(m => { if (live) setPage(() => m.HubDirectoryPage); }, () => {}); return () => { live = false; }; }, []);
  return Page ? html`<${Page} client=${hubClient()} offered=${true} login=${session.login} afterSave=${async () => !!(await readSession())} />` : null;
}
/** M-2682: Administration → This Hub, its own lazy module (an older server doesn't serve it: then it's left out). */
/**
 * M-3092: one of the Hub rooms' own screens (dev-claude2's modules: new room, invitations, administration → rooms), loaded
 * when first shown; nothing while it loads or if this Hub does not serve it.
 */
function LazyRoomPart({ load, name, props = {} }) {
  const [C, setC] = useState(null);
  useEffect(() => { let live = true; load().then((m) => { if (live && typeof m[name] === "function") setC(() => m[name]); }, () => {}); return () => { live = false; }; }, []);
  return C ? html`<${C} ...${props} />` : null;
}
const teamsLive = () => { const c = hubClient(); return typeof c.teamsLive === "function" && c.teamsLive() === true; };
const roomPurposeLive=()=>session?.features?.includes("room-purpose-v1")&&hubClient().roomPurposeV1===true;
// M-3340: personal pins — a Hub that keeps them (room-pins-v1) and a client that can ask; an older Hub shows no Pin at all.
const roomPinsLive=()=>session?.features?.includes("room-pins-v1")===true&&typeof hubClient().roomPins==="function";
const roomsLive = () => { const c = hubClient(); return typeof c.roomsLive === "function" && c.roomsLive() === true; };
function LazyThisHub({ directory }) {
  const [C, setC] = useState(null);
  useEffect(() => { let live = true; import("./hub-this-hub.js").then((m) => { if (live) setC(() => m.ThisHubCard); }, () => {}); return () => { live = false; }; }, []);
  return C ? html`<${C} directory=${directory} />` : null;
}
function LazyAssistantAdmin() {
  const [C, setC] = useState(null);
  useEffect(() => { let live = true; import("./hub-assistant-admin.js").then(m => { if (live) setC(() => m.HubAssistantAdmin); }, () => {}); return () => { live = false; }; }, []);
  return C ? html`<${C} client=${hubClient()} />` : null;
}
/** #3298 S-89: Administration's sub-page (?view=groups: Group permissions), from the page's own address. */
function adminView() { try { return new URLSearchParams(location.search).get("view") || ""; } catch { return ""; } }
/** #3298 S-89: the prominent entry to Group permissions at the top of Administration (discovery without docs). */
function GroupPermissionsEntry() {
  return html`<${LazyGroups} pick=${(m) => m.GroupPermissionsCard} props=${{}} />`;
}
function HubAdminPage({ groups = false, companyJoin = false, directory = false } = {}) {
  const assistantSession = useSession();
  const fullAdmin=assistantSession?.admin===true;
  const [view, reload] = useRead(() => hubClient().adminOverview());
  const canFleets=Array.isArray(view?.permissions)?view.permissions.includes("fleets.manage"):fullAdmin;
  const canJoin=Array.isArray(view?.permissions)?view.permissions.includes("join.manage"):fullAdmin;
  const [needsOnly, setNeedsOnly] = useState(false);   // M-3137: Connected fleets' "Needs update" filter
  const [canRecommend, setCanRecommend] = useState(false);   // M-3141: this Hub serves the recommended-version setting
  const [login, setLogin] = useState("");
  const [offer, setOffer] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { linkHubChatCss(); linkHubOwnerCss(); }, []);
  const create = async (e) => {
    e.preventDefault();
    // The button is always ready (a disabled one reads as grey, "broken" — Argon #16): an empty field just takes the focus.
    if (!login.trim()) { (typeof document !== "undefined" ? document.getElementById("hubOwnerLogin") : null)?.focus(); return; }
    setMsg(null);
    const r = await hubClient().createPairing(login.trim());
    if (!r.ok) { setMsg(errText(r)); return; }
    setOffer({ code: r.code, expiresAt: r.expiresAt, memberOrigin: r.memberOrigin, login: login.trim() }); setLogin(""); reload();
  };
  const approve = async (p) => {
    if (!(await confirmDialog({ message: hw("approveAsk", compareGroups(p.fingerprint)), confirmLabel: hw("approve") }))) return;
    setMsg(null);
    const r = await hubClient().approvePairing(p.id, p.fingerprint);
    // M-2988 #12: "denied" here is the owner — no longer eligible in the directory, or blocked from connecting a Fleet — not you.
    if (!r.ok) setMsg(r.code === "denied" && p.owner && p.owner.name ? newer("approveOwnerDenied", [p.owner.name], () => errText(r)) : errText(r));
    reload();
  };
  const revoke = async (f) => {
    // M-2988 #16: name the Fleet as the list does, so one owner's two Fleets can be told apart.
    const who = f.owner ? f.owner.name : f.id;
    const message = typeof f.label === "string" && f.label ? newer("revokeFleetNamedAsk", [f.label, who], () => hw("revokeFleetAsk", who)) : hw("revokeFleetAsk", who);
    if (!(await confirmDialog({ message, confirmLabel: hw("revoke"), danger: true }))) return;
    setMsg(null);
    const r = await hubClient().revokeFleet(f.id);
    if (!r.ok) setMsg(errText(r));
    reload();
  };
  const lead = html`<p class="s-page-lead hub-page-lead">${ho("adminLead")}</p>`;
  if (!view || (view.error && !view.fleets)) return html`<div class="col hub-owner hub-admin">${lead}
    <div class="s-section-layout">${view?.error ? html`<${ErrorState} message=${view.error} onRetry=${reload} />`
      : html`<section class="card"><h3>${ho("pairSteps")}</h3><${Skeleton} variant="rows" lines=${3} /></section><section class="card"><${Skeleton} variant="rows" lines=${3} /></section>`}</div></div>`;
  const fleets = view.fleets || [], pairings = view.pairings || [];
  const anchorAsked = takeAdminAnchor();   // M-3162: Overview's "See Connected Fleets" / "Let colleagues join"
  const anchorSel = { fleets: "#hub-admin-fleets", join: '[data-entry="let-colleagues-join"]' }[anchorAsked];
  if (anchorSel) setTimeout(() => { try { document.querySelector(anchorSel)?.scrollIntoView?.({ block: "start" }); } catch { /* none */ } }, 0);
  const accessEntry = companyJoin && companyViews.companyJoinAdminEntryV1 === true && ownerEntryWords.ownerAdminEntryV1 === true;
  const ManualFrame = accessEntry ? "details" : "div";
  return html`<div class="col hub-owner hub-admin">${lead}
    <div class="s-section-layout">
      ${fullAdmin && groups && !accessEntry ? html`<${GroupPermissionsEntry} />` : null}
      ${canJoin && companyJoin ? html`<${CompanyJoinAdminCard} entry=${accessEntry} groups=${groups} />` : null}
      ${/* Lumen's order: Let colleagues join → Teams → Rooms → Room assistant → Connected fleets → pairing. */ ""}
      ${fullAdmin && session?.features?.includes("personal-agents-v1") ? html`<${LazyRoomPart} load=${() => import("./hub-personal-agent.js")} name="HubPersonalAgentAdmin" props=${{client:hubClient(),scope:session.csrf}} />` : null}
      ${fullAdmin && teamsLive() ? html`<${LazyRoomPart} load=${() => import("./hub-teams.js")} name="HubTeamsEntry" props=${{ client: hubClient() }} />` : null}
      ${fullAdmin && roomsLive() ? html`<${LazyRoomPart} load=${() => import("./hub-admin-rooms.js")} name="AdminRooms" props=${{ client: hubClient() }} />` : null}
      ${fullAdmin && assistantSession?.features?.includes("room-assistant-v1") && hubClient().assistantAdminV1 === true ? html`<${LazyAssistantAdmin} />` : null}
      ${/* M-3592: how long a sign-in lasts; nothing from a Hub without the setting (the card's read fails). */ ""}
      ${fullAdmin ? html`<${LazyRoomPart} load=${() => import("./hub-session-limits.js")} name="HubSessionLimitsCard" props=${{ client: hubClient() }} />` : null}
      ${view.error ? html`<${ErrorState} message=${view.error} onRetry=${reload} />` : null}
      ${msg ? html`<p class="err" role="alert">${msg}</p>` : null}
      ${/* M-3141 (versions spec §3.1): the recommended version, a small card above the list. */ ""}
      ${fullAdmin && hasVersions(fleets) ? html`<${RecommendedVersionCard} client=${hubClient()} onSaved=${reload} onAvailable=${setCanRecommend} />` : null}
      ${canFleets?html`<section class="card hub-fleet-list" id="hub-admin-fleets"><h3>${ho("pairedFleets", fleets.filter((f) => f.status !== "revoked").length)}</h3>
        ${/* M-3137 (versions spec §2.2): the summary line and its filter, when this Hub reports versions. */ ""}
        ${hasVersions(fleets) ? html`<${FleetVersionsSummary} fleets=${fleets} recommended=${view.recommendedVersion ?? null} canRecommend=${canRecommend} filtered=${needsOnly} onFilter=${setNeedsOnly} />` : null}
        ${/* M-3145 (§4.2): "Update {n} Fleets that allow it", while at least one qualifies. */ ""}
        ${hasUpdates(fleets) ? html`<${UpdateAllowedButton} fleets=${fleets} recommended=${view.recommendedVersion ?? null} revision=${view.recommendationRevision ?? 0} client=${hubClient()} onChanged=${reload} />` : null}
        ${fleets.length ? (() => {
          // Spec 1.2: the row's title is the Fleet's label (S1 overview), its subtitle the owner; active first, revoked folded.
          const row = (f) => html`<div key=${f.id} class="s-row hub-row" data-fleet=${f.id}>
            <${Avatar} name=${f.owner ? f.owner.name : "?"} size="sm" />
            <span class="hub-row-text"><strong>${typeof f.label === "string" && f.label ? f.label : ho("fleetOf", f.owner ? f.owner.name : "—")}</strong>${f.owner ? html`<small class="note">${f.owner.name}${f.owner.login ? html` · <code>${f.owner.login}</code>` : null}</small>` : null}</span>
            ${hasVersions(fleets) && f.status !== "revoked" ? html`<${FleetVersionCells} fleet=${f} recommended=${view.recommendedVersion ?? null} />` : null}
            ${hasUpdates(fleets) && f.status === "active" ? html`<${FleetUpdateCell} fleet=${f} recommended=${view.recommendedVersion ?? null} revision=${view.recommendationRevision ?? 0} client=${hubClient()} onChanged=${reload} />` : null}
            ${f.status === "active" ? html`<span class="tag ok">${ho("active")}</span><${Menu} label=${ho("rowMenu", f.label || (f.owner ? f.owner.name : f.id))} items=${[{ key: "revoke", label: ho("revokeItem"), icon: "trash", danger: true, onSelect: () => revoke(f) }]} />`
              : html`<span class="tag">${ho("revokedTag")}</span>`}
          </div>`;
          const current = fleets.filter((f) => f.status !== "revoked" && (!needsOnly || behind(f))).sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1));
          const revoked = fleets.filter((f) => f.status === "revoked");
          return html`${current.length ? html`<div class="hub-rows">${current.map(row)}</div>` : html`<p class="note">${ho("noFleets")}</p>`}
            ${revoked.length ? html`<details class="s-ui-disclosure hub-fleets-revoked"><summary>${t("hubFleetList.revoked", revoked.length)}</summary><div class="hub-rows">${revoked.map(row)}</div></details>` : null}`;
        })() : html`<p class="note">${ho("noFleets")}</p>`}
      </section>`:null}
      ${canJoin?html`<${ManualFrame} class=${accessEntry ? "s-ui-disclosure hub-admin-manual" : ""} open=${accessEntry && (!!offer || pairings.some(p => p.ownerConfirmed && !p.adminApproved))}>${accessEntry ? html`<summary>${ho("manualAdvanced")}</summary>` : null}<section class="card"><h3>${ho("pairSteps")}</h3>
        <ol class="hub-steps">
          <li class=${offer || pairings.length ? "done" : "now"}><div class="hub-step-body"><span><b>${ho("stepCode")}</b><small class="note">${ho("stepCodeHint")}</small></span>
            <form class="hub-step-form" onSubmit=${create}><label class="field"><span class="sr-only">${ho("ownerLogin")}</span><input id="hubOwnerLogin" placeholder=${ho("ownerLogin")} autocomplete="off" spellcheck=${false} autocapitalize="none" value=${login} onInput=${(e) => setLogin(e.target.value)} /></label>
              <button type="submit" class="btn btn-sm btn-primary">${ho("makeCode")}</button></form>
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
      </section></${ManualFrame}>`:null}
      ${fullAdmin?html`<${LazyThisHub} directory=${directory} />`:null}
    </div></div>`;
}

/** Tests only: forget the page's session view. */
export function resetHubSession() { session = undefined; reading = null; watchingEnd = false; sessionSubs.clear(); roomsStore.set({ loaded: false, rooms: [], error: null }); roomsReading = null; }
