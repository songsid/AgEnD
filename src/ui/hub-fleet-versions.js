// M-3137 (docs/design/hub-fleet-versions.md, phase 1 — see versions): what a Hub page says about Fleets' AgEnD versions.
// - Administration → Connected fleets (§2.2): the summary line above the list, the "Needs update" filter, and per row
//   the AgEnD version, when it last connected and one state tag (a warn tag's sentence under it). The server
//   (M-3136, GET /hub/v1/admin/overview) computes the state; this only words it.
// - The signed-in person's own Fleets (§2.3, GET /hub/v1/me/fleets): one banner when any is behind, closed for the session.
// The user's rule (no unread counts, no red dots): every state is a plain tag, never a badge.
// A module of its own with its own words, so a tab holding an older dictionary still has every word (upgrade skew); an
// overview without the version fields (an older Hub) draws exactly what it drew before.
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t, lang } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { confirmDialog } from "/assets/ui-confirm.js";

register("hubVersions", {
  en: {
    allCurrent: "All {0} Fleets are on the recommended version or newer.", allCurrentOne: "The {0} Fleet is on the recommended version or newer.",
    someBehind: "{0} of {1} Fleets need an update.", someBehindOne: "{0} of {1} Fleets needs an update.",
    // Phase 1 has no recommended version and no way to set one yet (M-3138 adds it, with "Set a recommended version…").
    noRecommended: "{0} active Fleets.", noRecommendedOne: "{0} active Fleet.",
    noRecommendedSet: "{0} active Fleets. Set a recommended version to see which ones are behind.", noRecommendedSetOne: "{0} active Fleet. Set a recommended version to see whether it is behind.",
    recTitle: "Recommended AgEnD version", recHub: "Same as this Hub ({0})", recHubPlain: "Same as this Hub",
    recSpecific: "A specific version", recVersion: "Version", recVersionPh: "e.g. 2.4.0", recNone: "No recommendation",
    recLead: "Fleets below this version tell their owner and offer Update. Nothing is updated without the owner.",
    recPreview: "{0} Fleets will be asked to update.", recPreviewOne: "{0} Fleet will be asked to update.", recPreviewNone: "No Fleet will be asked to update.",
    recChecking: "Checking npm…", recSave: "Save", recSaving: "Saving…", recSaved: "Saved.",
    errInvalid: "Enter a version number such as 2.4.0.", errNotFound: "Version {0} was not found on npm.",
    errNpm: "Couldn't reach npm to check {0}. Try again.", errHubVersion: "This Hub's own version can't be read. Choose a specific version.",
    errConflict: "Someone else changed this just now; their choice is shown. Check it and save again.", errFailed: "It wasn't saved. Try again.",
    notified: "Owner notified · {0}", notNotified: "Not notified yet",
    updateBtn: "Update", ownerUpdates: "Owner updates it", updateMany: "Update {0} Fleets that allow it", updateManyOne: "Update {0} Fleet that allows it",
    askOne: "Update {0} to AgEnD v{1}? It starts when that Fleet's agents are idle. Its owner is told now and when it finishes.",
    askMany: "Update {0} Fleets to AgEnD v{1}?", askOk: "Update",
    replaceBtn: "Update to v{0} instead",
    askReplace: "Update {0} to AgEnD v{1} instead of v{2}? The waiting request is cancelled first. It starts when that Fleet's agents are idle. Its owner is told now and when it finishes.", cancel: "Cancel", tryAgain: "Try again",
    stSending: "Sending…", stConnect: "Waiting for the Fleet to connect", stWaiting: "Waiting for its agents to be idle · since {0}",
    stUpdating: "Updating…", stDone: "Updated to v{0} · {1}", stRolledBack: "Update failed; back on v{0}",
    stBusy: "Did not start: agents were busy for 24 hours", stOffline: "Did not start: the Fleet has not connected for 7 days.",
    stCancelled: "The owner cancelled this update", cancelling: "Cancelling…", stGone: "Update failed and the Fleet has not come back. Contact {0}.",
    startedMany: "Started for {0} Fleets.", startedManyOne: "Started for {0} Fleet.", startedSome: "Started for {0} Fleets; {1} could not start.", startedSomeOne: "Started for {0} Fleet; {1} could not start.",
    rfOwnerOff: "The owner no longer allows updates from the Hub.", rfNotService: "This Fleet was started by hand, so it cannot be updated from here.",
    rfNotFound: "That Fleet could not find v{0} on npm.", rfNpm: "That Fleet could not reach the update source. Nothing was changed.",
    rfPermission: "That Fleet has no permission to install updates. Its owner must update it by hand.", rfCurrent: "Already on v{0}.",
    rfOpen: "An update is already open for this Fleet.", rfUnsupported: "This Fleet's AgEnD is too old to be updated from the Hub.",
    rfGone: "This Fleet is no longer connected to this Hub.", rfRunning: "That Fleet was already updating.",
    rfNoRec: "Set a recommended version first.", rfRevision: "The recommended version changed just now. Check it and try again.",
    rfFailed: "The update did not finish.",
    filter: "Needs update",
    colVersion: "AgEnD version", colLast: "Last connected",
    unknown: "Unknown", now: "Now", never: "Never",
    tagTooOld: "Too old for rooms", tagNeeds: "Needs update", tagUnknown: "Version unknown", tagCurrent: "Up to date",
    whyTooOld: "This Fleet's agents cannot answer in rooms until it is updated.",
    whyNeeds: "This Fleet runs {0}; the recommended version is {1}.",
    whyNeedsNoRec: "This Fleet runs {0}, older than the recommended version.",
    whyUnknown: "This Fleet is too old to report its version. Ask its owner to update it.",
    bannerOne: "Your Fleet “{0}” runs an older AgEnD ({1}). Some features here will not work until you update it. Open your AgEnD dashboard and press Update.",
    bannerOneUnknown: "Your Fleet “{0}” runs an older AgEnD. Some features here will not work until you update it. Open your AgEnD dashboard and press Update.",
    bannerOneNoName: "One of your Fleets runs an older AgEnD. Some features here will not work until you update it. Open your AgEnD dashboard and press Update.",
    bannerMany: "{0} of your Fleets run an older AgEnD. Some features here will not work until you update them. Open your AgEnD dashboard and press Update.",
    close: "Close",
  },
  "zh-TW": {
    allCurrent: "{0} 個 Fleet 都是建議版本或更新的版本。", allCurrentOne: "{0} 個 Fleet 都是建議版本或更新的版本。",
    someBehind: "{1} 個 Fleet 當中有 {0} 個需要更新。", someBehindOne: "{1} 個 Fleet 當中有 {0} 個需要更新。",
    noRecommended: "{0} 個使用中的 Fleet。", noRecommendedOne: "{0} 個使用中的 Fleet。",
    noRecommendedSet: "{0} 個使用中的 Fleet。設定建議版本後，就能看出哪些落後。", noRecommendedSetOne: "{0} 個使用中的 Fleet。設定建議版本後，就能看出哪些落後。",
    recTitle: "建議的 AgEnD 版本", recHub: "與這個 Hub 相同（{0}）", recHubPlain: "與這個 Hub 相同",
    recSpecific: "指定版本", recVersion: "版本", recVersionPh: "例如 2.4.0", recNone: "不建議版本",
    recLead: "低於這個版本的 Fleet 會通知擁有者並提供更新按鈕。沒有擁有者的動作，不會更新任何東西。",
    recPreview: "會有 {0} 個 Fleet 收到更新通知。", recPreviewOne: "會有 {0} 個 Fleet 收到更新通知。", recPreviewNone: "不會通知任何 Fleet。",
    recChecking: "正在檢查 npm…", recSave: "儲存", recSaving: "儲存中…", recSaved: "已儲存。",
    errInvalid: "請輸入版本號，例如 2.4.0。", errNotFound: "在 npm 上找不到 {0} 這個版本。",
    errNpm: "無法連上 npm 檢查 {0}，請再試一次。", errHubVersion: "讀不到這個 Hub 的版本，請改為指定版本。",
    errConflict: "剛剛有人改了這個設定，已顯示最新的選擇。請確認後再儲存。", errFailed: "沒有儲存，請再試一次。",
    notified: "已通知擁有者 · {0}", notNotified: "尚未通知",
    updateBtn: "更新", ownerUpdates: "由擁有者自行更新", updateMany: "更新 {0} 個已允許的 Fleet", updateManyOne: "更新 {0} 個已允許的 Fleet",
    askOne: "要把 {0} 更新到 AgEnD v{1} 嗎？會等那個 Fleet 的 Agent 都閒置才開始。現在和完成時都會通知擁有者。",
    askMany: "要把 {0} 個 Fleet 更新到 AgEnD v{1} 嗎？", askOk: "更新",
    replaceBtn: "改為更新到 v{0}",
    askReplace: "要改把 {0} 更新到 AgEnD v{1}（取代 v{2}）嗎？會先取消等待中的要求，再等那個 Fleet 的 Agent 都閒置才開始。現在和完成時都會通知擁有者。", cancel: "取消", tryAgain: "再試一次",
    stSending: "傳送中…", stConnect: "等待 Fleet 連接", stWaiting: "等待 Agent 閒置 · {0} 起",
    stUpdating: "更新中…", stDone: "已更新到 v{0} · {1}", stRolledBack: "更新失敗，已回到 v{0}",
    stBusy: "沒有開始：Agent 連續 24 小時都在忙", stOffline: "沒有開始：這個 Fleet 已經 7 天沒有連接。",
    stCancelled: "擁有者取消了這次更新", cancelling: "取消中…", stGone: "更新失敗，而且 Fleet 沒有重新連接。請聯絡 {0}。",
    startedMany: "已為 {0} 個 Fleet 開始。", startedManyOne: "已為 {0} 個 Fleet 開始。", startedSome: "已為 {0} 個 Fleet 開始；{1} 個無法開始。", startedSomeOne: "已為 {0} 個 Fleet 開始；{1} 個無法開始。",
    rfOwnerOff: "擁有者已不允許由 Hub 更新。", rfNotService: "這個 Fleet 是手動啟動的，無法從這裡更新。",
    rfNotFound: "那個 Fleet 在 npm 上找不到 v{0}。", rfNpm: "那個 Fleet 連不上更新來源，沒有任何變更。",
    rfPermission: "那個 Fleet 沒有安裝更新的權限，需要擁有者手動更新。", rfCurrent: "已經是 v{0}。",
    rfOpen: "這個 Fleet 已經有一個進行中的更新。", rfUnsupported: "這個 Fleet 的 AgEnD 太舊，無法從 Hub 更新。",
    rfGone: "這個 Fleet 已不再連接到這個 Hub。", rfRunning: "那個 Fleet 已經在更新。",
    rfNoRec: "請先設定建議版本。", rfRevision: "建議版本剛剛改了，請確認後再試一次。",
    rfFailed: "更新沒有完成。",
    filter: "需要更新",
    colVersion: "AgEnD 版本", colLast: "上次連接",
    unknown: "不明", now: "目前已連接", never: "從未連接",
    tagTooOld: "版本太舊，無法使用房間", tagNeeds: "需要更新", tagUnknown: "版本不明", tagCurrent: "已是建議版本",
    whyTooOld: "這個 Fleet 的 Agent 要更新後才能在房間裡回答。",
    whyNeeds: "這個 Fleet 是 {0}，建議版本是 {1}。",
    whyNeedsNoRec: "這個 Fleet 是 {0}，比建議版本舊。",
    whyUnknown: "這個 Fleet 版本太舊，無法回報版本。請通知擁有者更新。",
    bannerOne: "你的 Fleet「{0}」是較舊的 AgEnD（{1}），這裡的部分功能要更新後才能使用。請開啟你的 AgEnD 儀表板，按「更新」。",
    bannerOneUnknown: "你的 Fleet「{0}」是較舊的 AgEnD，這裡的部分功能要更新後才能使用。請開啟你的 AgEnD 儀表板，按「更新」。",
    bannerOneNoName: "你有一個 Fleet 是較舊的 AgEnD，這裡的部分功能要更新後才能使用。請開啟你的 AgEnD 儀表板，按「更新」。",
    bannerMany: "你有 {0} 個 Fleet 是較舊的 AgEnD，這裡的部分功能要更新後才能使用。請開啟你的 AgEnD 儀表板，按「更新」。",
    close: "關閉",
  },
});
export const hv = (key, ...args) => t(`hubVersions.${key}`, ...args);
/** M-3170: a count of Fleets — a one-Fleet sentence (`<key>One`) for 1; zh-TW's is the same sentence as for any count. */
const hvn = (key, n, ...args) => hv(n === 1 ? `${key}One` : key, String(n), ...args);

// The server's states (M-3136), in its priority order.
const STATES = ["too-old-rooms", "needs-update", "unknown", "current"];
const TAG = { "too-old-rooms": "tagTooOld", "needs-update": "tagNeeds", unknown: "tagUnknown", current: "tagCurrent" };
/** True when the overview carries the version fields (an older Hub's rows do not: nothing new is drawn). */
export const hasVersions = (fleets) => Array.isArray(fleets) && fleets.some((f) => STATES.includes(f?.versionState));
/** A Fleet that needs its owner's Update (the filter's set, and the summary's count): every state but current. */
export const behind = (f) => STATES.includes(f?.versionState) && f.versionState !== "current";

/** The summary's counts, over the active rows (a revoked Fleet is not counted). */
export function versionCounts(fleets) {
  const active = (fleets || []).filter((f) => f && f.status === "active");
  return { total: active.length, needs: active.filter(behind).length };
}

/** The summary line above Connected fleets (§2.2). */
export function summaryText(fleets, recommended, canRecommend = false) {
  const { total, needs } = versionCounts(fleets);
  // M-3141: the clause comes back only where there is a control to set it (this Hub serves the setting).
  if (!recommended) return hvn(canRecommend ? "noRecommendedSet" : "noRecommended", total);
  return needs > 0 ? hvn("someBehind", needs, String(total)) : hvn("allCurrent", total);
}

/** "Now" (with the green dot), a relative time ("3 days ago" / 「3 天前」), or "Never". */
/** "5 minutes ago" / 「5 分鐘前」, in hours then days past those. */
function ago(at, now) {
  const rtf = new Intl.RelativeTimeFormat(lang() === "zh-TW" ? "zh-TW" : "en", { numeric: "always" });
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 3600) return rtf.format(-Math.max(1, Math.round(s / 60)), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  return rtf.format(-Math.round(s / 86400), "day");
}

export function lastConnectedText(f, now = Date.now()) {
  if (f?.connected === true) return hv("now");
  const at = Number(f?.lastConnectedAt);
  if (!Number.isFinite(at) || at <= 0) return hv("never");
  return ago(at, now);
}

/**
 * §3.4: under a behind Fleet's tag once a recommendation is set — "Owner notified · {when}" (the Fleet acknowledged the
 * offer for the current recommendation), else "Not notified yet" (too old to be told, or not online since). None for a
 * Fleet that is current, or with no recommendation.
 */
export function notifiedText(f, recommended, now = Date.now()) {
  if (!recommended || !behind(f)) return "";
  const at = Number(f?.recommendationNotifiedAt);
  return Number.isFinite(at) && at > 0 ? hv("notified", ago(at, now)) : hv("notNotified");
}

/** One warn tag's sentence (shown under the row), or "" for Up to date. */
export function tagWhy(f, recommended) {
  if (f?.versionState === "too-old-rooms") return hv("whyTooOld");
  if (f?.versionState === "needs-update") return recommended ? hv("whyNeeds", f.version || hv("unknown"), recommended) : hv("whyNeedsNoRec", f.version || hv("unknown"));
  if (f?.versionState === "unknown") return hv("whyUnknown");
  return "";
}

/**
 * A row's version facts: AgEnD version, last connected, its state tag and, for a warn tag, its sentence under them
 * (shown, not hidden behind a hover: a tap target the size of a tag cannot be one on a phone).
 */
export function FleetVersionCells({ fleet, recommended = null, now }) {
  const state = STATES.includes(fleet?.versionState) ? fleet.versionState : null;
  const why = tagWhy(fleet, recommended);
  return html`<span class="hub-fleet-version">
    ${state ? html`<span class=${`tag hub-fleet-tag${why ? " warn" : ""}`}>${hv(TAG[state])}</span>` : null}
    <span class="hub-fleet-ver"><small class="note">${hv("colVersion")}</small> <span>${fleet?.version || hv("unknown")}</span></span>
    <span class="hub-fleet-last"><small class="note">${hv("colLast")}</small> ${fleet?.connected === true ? html`<span class="dot ok" aria-hidden="true"></span> ` : null}<span>${lastConnectedText(fleet, now)}</span></span>
    ${why ? html`<small class="note hub-fleet-why">${why}</small>` : null}
    ${notifiedText(fleet, recommended, now) ? html`<small class="note hub-fleet-notified">${notifiedText(fleet, recommended, now)}</small>` : null}
  </span>`;
}

/** The summary line and the "Needs update" filter (shown while any Fleet needs one). */
export function FleetVersionsSummary({ fleets, recommended = null, canRecommend = false, filtered = false, onFilter = () => {} }) {
  const { needs } = versionCounts(fleets);
  return html`<div class="hub-fleet-summary"><p class="note" role="status">${summaryText(fleets, recommended, canRecommend)}</p>
    ${/* Pressed, it stays (Fable): the last Fleet that needed an update may be updated meanwhile, and the list must come back. */ ""}
    ${needs > 0 || filtered ? html`<button type="button" class="btn btn-sm hub-fleet-filter" aria-pressed=${filtered ? "true" : "false"} onClick=${() => onFilter(!filtered)}>${hv("filter")}</button>` : null}</div>`;
}

const SEEN_KEY = "agend_hub_versions_banner_closed";
/** One sign-in's mark: a one-way digest of what tells it from the next (never the value itself in storage). */
function signInMark(v) {
  let h = 0x811c9dc5;
  for (const c of String(v)) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
/**
 * §2.3: a signed-in person whose own Fleet is behind is told once, here. Closed, it stays away for this sign-in
 * (`signIn`: what tells one sign-in from the next — the session's CSRF token, new at every sign-in) and comes back on
 * the next while still true.
 */
export function OlderFleetBanner({ client, signIn = "" }) {
  const [mine, setMine] = useState(null);
  const mark = signInMark(signIn);
  const seen = () => { try { return sessionStorage.getItem(SEEN_KEY) === mark; } catch { return false; } };
  const [, redraw] = useState(0);
  const closed = seen();                                    // read each time: a new sign-in has a new mark
  useEffect(() => {
    if (closed || typeof client?.myFleets !== "function") return undefined;
    let live = true;
    client.myFleets().then((r) => { if (live && r && r.ok !== false && Array.isArray(r.fleets)) setMine(r.fleets.filter(behind)); }, () => {});
    return () => { live = false; };
  }, [closed, mark]);
  if (closed || !mine || !mine.length) return null;
  const one = mine.length === 1 ? mine[0] : null;
  const text = one ? (!one.label ? hv("bannerOneNoName") : one.version ? hv("bannerOne", one.label, one.version) : hv("bannerOneUnknown", one.label))
    : hv("bannerMany", String(mine.length));
  const close = () => { try { sessionStorage.setItem(SEEN_KEY, mark); } catch { /* this page only */ } setMine([]); redraw((n) => n + 1); };
  return html`<div class="hub-banner warn hub-versions-banner" role="status"><span>${text}</span>
    <button type="button" class="icon-btn" aria-label=${hv("close")} title=${hv("close")} onClick=${close}><${Icon} name="close" size=${14} /></button></div>`;
}

const REFUSAL = { "version-invalid": "errInvalid", "version-not-found": "errNotFound", "npm-unavailable": "errNpm", "hub-version-unknown": "errHubVersion", "revision-conflict": "errConflict" };
/** A refusal in this card's words; the version named is the one the person entered (the server echoes it validated). */
export function refusalText(r, version) {
  const key = REFUSAL[r?.code] || "errFailed";
  return hv(key, version || "");
}

/**
 * M-3141 (versions spec §3.1): Administration's "Recommended AgEnD version" card, above Connected fleets. Three choices —
 * Same as this Hub (the default once first saved; it follows the Hub), A specific version (checked on npm), No
 * recommendation (the state before anyone set it). The effect is shown before it applies (the group-permissions
 * preview's style): the server's preview of the draft, refreshed as it changes, then one Save (its revision guards a
 * concurrent change). A Hub without the setting (older): nothing is drawn, and `onAvailable(false)` says so.
 */
export function RecommendedVersionCard({ client, onSaved = () => {}, onAvailable = () => {} }) {
  const [state, setState] = useState(null);                // the saved setting (GET), or { missing: true }
  const [mode, setMode] = useState("hub"), [version, setVersion] = useState("");
  const [preview, setPreview] = useState(null);            // { pending } | { ok, affected, recommendedVersion } | { error }
  const [saving, setSaving] = useState(false), [msg, setMsg] = useState(null);
  // Nothing is previewed (an npm check) only for opening the page: once the person changes the form, or presses Save.
  const [touched, setTouched] = useState(false);
  const load = async () => {
    const r = typeof client?.recommendedVersion === "function" ? await client.recommendedVersion() : { ok: false };
    if (!r || r.ok === false) { setState({ missing: true }); onAvailable(false); return null; }
    setState(r); onAvailable(true);
    // Unsaved (configured: false): the form starts on Same as this Hub (V1); saved: on what was saved.
    setMode(r.configured ? r.mode : "hub"); setVersion(r.mode === "specific" && r.version ? r.version : "");
    return r;
  };
  useEffect(() => { void load(); }, []);
  const target = version.trim();
  const changed = !!state && !state.missing && (!state.configured || mode !== state.mode || (mode === "specific" && target !== (state.version || "")));
  // The server's preview of the draft (a stale answer, for an older draft, is dropped).
  useEffect(() => {
    if (!touched || !changed || (mode === "specific" && !target)) { setPreview(null); return undefined; }
    let live = true;
    setPreview({ pending: true });
    const t = setTimeout(async () => {
      const r = await client.previewRecommendedVersion({ mode, ...(mode === "specific" ? { version: target } : {}) });
      if (!live) return;
      setPreview(r && r.ok !== false ? { ok: true, affected: Number(r.affected) || 0, recommendedVersion: r.recommendedVersion ?? null } : { error: refusalText(r, target) });
    }, mode === "specific" ? 500 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [touched, changed, mode, target]);
  if (!state || state.missing) return null;
  const save = async () => {
    if (saving) return;
    if (!preview?.ok) { setTouched(true); return; }     // first the effect (the preview), then Save applies it
    setSaving(true); setMsg(null);
    const r = await client.saveRecommendedVersion({ mode, ...(mode === "specific" ? { version: target } : {}), ifRevision: state.revision });
    setSaving(false);
    if (r && r.ok !== false) { setMsg({ ok: true, text: hv("recSaved") }); await load(); setPreview(null); setTouched(false); onSaved(); return; }
    setMsg({ ok: false, text: refusalText(r, target) });
    if (r?.code === "revision-conflict") { await load(); onSaved(); }      // their choice is shown
  };
  const radio = (value, label, extra = null) => html`<label class="check hub-rec-choice"><input type="radio" name="hubRecMode" value=${value}
      checked=${mode === value} onChange=${() => { setMode(value); setMsg(null); setTouched(true); }} /><span>${label}</span>${extra}</label>`;
  return html`<section class="card hub-rec-card"><h3>${hv("recTitle")}</h3>
    <div class="hub-rec-choices" role="radiogroup" aria-label=${hv("recTitle")}>
      ${radio("hub", state.hubVersion ? hv("recHub", state.hubVersion) : hv("recHubPlain"))}
      ${radio("specific", hv("recSpecific"), mode === "specific" ? html`<span class="field hub-rec-version"><span class="sr-only">${hv("recVersion")}</span>
        <input id="hubRecVersion" type="text" inputmode="text" autocomplete="off" spellcheck=${false} placeholder=${hv("recVersionPh")} value=${version}
          onInput=${(e) => { setVersion(e.target.value); setMsg(null); setTouched(true); }} /></span>` : null)}
      ${radio("none", hv("recNone"))}
    </div>
    <p class="note">${hv("recLead")}</p>
    ${changed && preview ? html`<p class=${preview.error ? "err" : "note hub-rec-preview"} role="status" aria-live="polite">${preview.pending ? hv("recChecking")
      : preview.error ? preview.error : mode === "none" || preview.affected === 0 ? hv("recPreviewNone") : hvn("recPreview", preview.affected)}</p>` : null}
    ${msg ? html`<p class=${msg.ok ? "note" : "err"} role=${msg.ok ? "status" : "alert"}>${msg.text}</p>` : null}
    ${changed ? html`<div class="save-row"><button type="button" class="btn btn-primary" disabled=${saving || !!preview?.pending || !!preview?.error || (mode === "specific" && !target)} onClick=${save}>${saving ? hv("recSaving") : hv("recSave")}</button></div>` : null}
  </section>`;
}

// ── M-3145 (versions spec §4.2, §4.5; API M-3144): updating Fleets whose owner allows it ─────────────────────────────

const RF = { "owner-disabled": "rfOwnerOff", "not-service": "rfNotService", "version-not-found": "rfNotFound", "npm-unavailable": "rfNpm",
  "no-permission": "rfPermission", "already-current": "rfCurrent", "request-open": "rfOpen", unsupported: "rfUnsupported", revoked: "rfGone",
  "not-found": "rfGone", "update-running": "rfRunning", "no-recommendation": "rfNoRec", "revision-conflict": "rfRevision" };
/** A refusal or a Fleet's reason in words ({0}: the version it names); anything else, generically. */
export function updateReasonText(code, version = "") { return hv(RF[code] || "rfFailed", version); }

/** True when the overview carries phase 3's fields (an older Hub: no buttons, no lines). */
export const hasUpdates = (fleets) => Array.isArray(fleets) && fleets.some((f) => f && "updatesAllowed" in f);
const OPEN = new Set(["queued", "waiting", "updating"]);
/** A Fleet the administrator may update now: active, behind, its owner allows it, nothing open for it. */
export const updatable = (f, recommended) => !!recommended && f?.status === "active" && behind(f) && f.updatesAllowed === true
  && !(f.updateRequest && OPEN.has(f.updateRequest.state));

/**
 * §5's replacement: a request not yet started (queued or waiting, no cancel pending) for another version than the saved
 * recommendation can be replaced by one for the recommendation — the Hub cancels the old one first. Never while updating.
 */
export const replaceable = (f, recommended) => !!recommended && f?.status === "active" && behind(f) && f.updatesAllowed === true
  && !!f.updateRequest && (f.updateRequest.state === "queued" || f.updateRequest.state === "waiting")
  && f.updateRequest.cancelRequested !== true && f.updateRequest.version !== recommended;

/** §4.5: the request's one status line (and its one action: Cancel while waiting, Try again after a failure). */
export function updateStatus(f, now = Date.now()) {
  const r = f?.updateRequest;
  if (!r) return null;
  const owner = f.owner?.name || "";
  switch (r.state) {
    // Not yet accepted by the Fleet (held up to 7 days while it is offline): it can be withdrawn, as a waiting one can.
    case "queued": return { text: f.connected === true ? hv("stSending") : hv("stConnect"), action: "cancel" };
    case "waiting": return { text: hv("stWaiting", r.waitingSince ? ago(r.waitingSince, now) : ""), action: "cancel" };
    case "updating": return { text: hv("stUpdating") };
    case "done": return { text: hv("stDone", r.version || "", ago(r.updatedAt || now, now)) };
    case "rolled-back": return { text: hv("stRolledBack", r.currentVersion || ""), action: "retry" };
    case "expired": return { text: hv(r.reasonCode === "offline-7d" ? "stOffline" : "stBusy"), action: "retry" };
    case "cancelled": return { text: hv("stCancelled") };
    case "failed": return r.reasonCode === "rollback-failed" ? { text: hv("stGone", owner) } : { text: updateReasonText(r.reasonCode, r.version), action: "retry" };
    case "refused": return { text: updateReasonText(r.reasonCode, r.reasonCode === "already-current" ? r.currentVersion : r.version), action: r.reasonCode === "already-current" ? null : "retry" };
    default: return null;
  }
}

const newKey = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
/**
 * Ask, then start: one or many Fleets, the target always the saved recommendation (its revision guards a change made
 * meanwhile). Resolves { ok, text } for the page to say, or null when the administrator said no.
 */
export async function startUpdates(client, fleets, recommended, revision, replacing = null) {
  if (!fleets.length) return null;
  const one = fleets.length === 1 ? fleets[0] : null, name = one ? one.label || one.owner?.name || "" : "";
  const message = one && replacing ? hv("askReplace", name, recommended, replacing) : one ? hv("askOne", name, recommended) : hv("askMany", String(fleets.length), recommended);
  const yes = await confirmDialog({ title: hv("askOk"), message, confirmLabel: hv("askOk") });
  if (!yes) return null;
  const r = await client.updateFleets({ fleetIds: fleets.map((f) => f.id), ifRevision: revision, idempotencyKey: newKey() });
  if (!r || r.ok === false) return { ok: false, text: updateReasonText(r?.code, recommended) };
  const started = Array.isArray(r.requests) ? r.requests.length : 0, refused = Array.isArray(r.refused) ? r.refused : [];
  if (one) return refused.length ? { ok: false, text: updateReasonText(refused[0].code, recommended) } : { ok: true, text: "" };
  return { ok: refused.length === 0, text: refused.length ? hvn("startedSome", started, String(refused.length)) : hvn("startedMany", started) };
}

/** A Connected fleets row's update part: its status line, else Update (the owner allows it) or "Owner updates it". */
export function FleetUpdateCell({ fleet, recommended = null, revision = 0, client, onChanged = () => {}, now }) {
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(null);
  if (!recommended || !behind(fleet) && !fleet?.updateRequest) return null;
  const status = updateStatus(fleet, now);
  const run = async (fn) => { if (busy) return; setBusy(true); setMsg(null); const r = await fn(); setBusy(false); if (r) { if (r.text) setMsg(r); onChanged(); } };
  const start = () => run(() => startUpdates(client, [fleet], recommended, revision));
  const replace = () => run(() => startUpdates(client, [fleet], recommended, revision, fleet.updateRequest.version));
  const cancel = () => run(async () => { const r = await client.cancelFleetUpdate(fleet.updateRequest.id); return r && r.ok !== false ? { ok: true, text: "" } : { ok: false, text: updateReasonText(r?.code) }; });
  return html`<span class="hub-fleet-update">
    ${status ? html`<small class="note hub-fleet-update-status">${status.text}</small>
      ${/* A cancel the Fleet has not confirmed yet (it may already have claimed the request): Cancelling…, once. */ ""}
      ${status.action === "cancel" ? html`<button type="button" class="btn btn-sm" disabled=${busy || fleet.updateRequest?.cancelRequested === true} onClick=${cancel}>${fleet.updateRequest?.cancelRequested === true ? hv("cancelling") : hv("cancel")}</button>` : null}
      ${replaceable(fleet, recommended) ? html`<button type="button" class="btn btn-sm hub-fleet-update-replace" disabled=${busy} onClick=${replace}>${hv("replaceBtn", recommended)}</button>` : null}
      ${status.action === "retry" && updatable(fleet, recommended) ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${start}>${hv("tryAgain")}</button>` : null}`
    : fleet.updatesAllowed === true ? html`<button type="button" class="btn btn-sm hub-fleet-update-btn" disabled=${busy} onClick=${start}>${hv("updateBtn")}</button>`
    : html`<small class="note hub-fleet-owner-updates">${hv("ownerUpdates")}</small>`}
    ${msg ? html`<small class=${msg.ok ? "note" : "err"} role=${msg.ok ? "status" : "alert"}>${msg.text}</small>` : null}
  </span>`;
}

/** Above the list (§4.2): "Update {n} Fleets that allow it", while at least one qualifies. */
export function UpdateAllowedButton({ fleets, recommended = null, revision = 0, client, onChanged = () => {} }) {
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(null);
  const ready = (fleets || []).filter((f) => updatable(f, recommended));
  if (!ready.length && !msg) return null;
  const go = async () => { if (busy) return; setBusy(true); setMsg(null); const r = await startUpdates(client, ready, recommended, revision); setBusy(false); if (r) { setMsg(r.text ? r : null); onChanged(); } };
  return html`<div class="hub-fleet-update-all">
    ${ready.length ? html`<button type="button" class="btn btn-sm btn-primary" disabled=${busy} onClick=${go}>${hvn("updateMany", ready.length)}</button>` : null}
    ${msg ? html`<p class=${msg.ok ? "note" : "err"} role=${msg.ok ? "status" : "alert"}>${msg.text}</p>` : null}
  </div>`;
}
