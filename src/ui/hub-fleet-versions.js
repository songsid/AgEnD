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

register("hubVersions", {
  en: {
    allCurrent: "All {0} Fleets are on the recommended version or newer.",
    someBehind: "{0} of {1} Fleets need an update.",
    // Phase 1 has no recommended version and no way to set one yet (M-3138 adds it, with "Set a recommended version…").
    noRecommended: "{0} active Fleets.",
    noRecommendedSet: "{0} active Fleets. Set a recommended version to see which ones are behind.",
    recTitle: "Recommended AgEnD version", recHub: "Same as this Hub ({0})", recHubPlain: "Same as this Hub",
    recSpecific: "A specific version", recVersion: "Version", recVersionPh: "e.g. 2.4.0", recNone: "No recommendation",
    recLead: "Fleets below this version tell their owner and offer Update. Nothing is updated without the owner.",
    recPreview: "{0} Fleets will be asked to update.", recPreviewNone: "No Fleet will be asked to update.",
    recChecking: "Checking npm…", recSave: "Save", recSaving: "Saving…", recSaved: "Saved.",
    errInvalid: "Enter a version number such as 2.4.0.", errNotFound: "Version {0} was not found on npm.",
    errNpm: "Couldn't reach npm to check {0}. Try again.", errHubVersion: "This Hub's own version can't be read. Choose a specific version.",
    errConflict: "Someone else changed this just now; their choice is shown. Check it and save again.", errFailed: "It wasn't saved. Try again.",
    notified: "Owner notified · {0}", notNotified: "Not notified yet",
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
    allCurrent: "{0} 個 Fleet 都是建議版本或更新的版本。",
    someBehind: "{1} 個 Fleet 當中有 {0} 個需要更新。",
    noRecommended: "{0} 個使用中的 Fleet。",
    noRecommendedSet: "{0} 個使用中的 Fleet。設定建議版本後，就能看出哪些落後。",
    recTitle: "建議的 AgEnD 版本", recHub: "與這個 Hub 相同（{0}）", recHubPlain: "與這個 Hub 相同",
    recSpecific: "指定版本", recVersion: "版本", recVersionPh: "例如 2.4.0", recNone: "不建議版本",
    recLead: "低於這個版本的 Fleet 會通知擁有者並提供更新按鈕。沒有擁有者的動作，不會更新任何東西。",
    recPreview: "會有 {0} 個 Fleet 收到更新通知。", recPreviewNone: "不會通知任何 Fleet。",
    recChecking: "正在檢查 npm…", recSave: "儲存", recSaving: "儲存中…", recSaved: "已儲存。",
    errInvalid: "請輸入版本號，例如 2.4.0。", errNotFound: "在 npm 上找不到 {0} 這個版本。",
    errNpm: "無法連上 npm 檢查 {0}，請再試一次。", errHubVersion: "讀不到這個 Hub 的版本，請改為指定版本。",
    errConflict: "剛剛有人改了這個設定，已顯示最新的選擇。請確認後再儲存。", errFailed: "沒有儲存，請再試一次。",
    notified: "已通知擁有者 · {0}", notNotified: "尚未通知",
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
  if (!recommended) return hv(canRecommend ? "noRecommendedSet" : "noRecommended", String(total));
  return needs > 0 ? hv("someBehind", String(needs), String(total)) : hv("allCurrent", String(total));
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
      : preview.error ? preview.error : mode === "none" || preview.affected === 0 ? hv("recPreviewNone") : hv("recPreview", String(preview.affected))}</p>` : null}
    ${msg ? html`<p class=${msg.ok ? "note" : "err"} role=${msg.ok ? "status" : "alert"}>${msg.text}</p>` : null}
    ${changed ? html`<div class="save-row"><button type="button" class="btn btn-primary" disabled=${saving || !!preview?.pending || !!preview?.error || (mode === "specific" && !target)} onClick=${save}>${saving ? hv("recSaving") : hv("recSave")}</button></div>` : null}
  </section>`;
}
