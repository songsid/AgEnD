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
    noRecommended: "{0} Fleets connected. Set a recommended version to see which ones are behind.",
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
    noRecommended: "已連接 {0} 個 Fleet。設定建議版本後，就能看出哪些落後。",
    filter: "需要更新",
    colVersion: "AgEnD 版本", colLast: "上次連線",
    unknown: "不明", now: "連線中", never: "從未連線",
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
export function summaryText(fleets, recommended) {
  const { total, needs } = versionCounts(fleets);
  if (!recommended) return hv("noRecommended", String(total));
  return needs > 0 ? hv("someBehind", String(needs), String(total)) : hv("allCurrent", String(total));
}

/** "Now" (with the green dot), a relative time ("3 days ago" / 「3 天前」), or "Never". */
export function lastConnectedText(f, now = Date.now()) {
  if (f?.connected === true) return hv("now");
  const at = Number(f?.lastConnectedAt);
  if (!Number.isFinite(at) || at <= 0) return hv("never");
  const rtf = new Intl.RelativeTimeFormat(lang() === "zh-TW" ? "zh-TW" : "en", { numeric: "always" });
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 3600) return rtf.format(-Math.max(1, Math.round(s / 60)), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  return rtf.format(-Math.round(s / 86400), "day");
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
  </span>`;
}

/** The summary line and the "Needs update" filter (shown while any Fleet needs one). */
export function FleetVersionsSummary({ fleets, recommended = null, filtered = false, onFilter = () => {} }) {
  const { needs } = versionCounts(fleets);
  return html`<div class="hub-fleet-summary"><p class="note" role="status">${summaryText(fleets, recommended)}</p>
    ${needs > 0 ? html`<button type="button" class="btn btn-sm hub-fleet-filter" aria-pressed=${filtered ? "true" : "false"} onClick=${() => onFilter(!filtered)}>${hv("filter")}</button>` : null}</div>`;
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
