// #1523 N3 (§3.4): the AI usage dialog, opened from every page's header (◔). Moved from panel-view.js. Public
// (/assets/): View's anonymous reader opens it too. It reads /api/ai-usage every 60 s while open (passive, #1374).
// #1673: its body (UsageBody) is also the wide screen's right rail (header-tools.js UsageRail) — one read, one view.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "./app-html.js";
import { t } from "./app-i18n.js";
import { useLease } from "./app-ctx.js";
import { createStore, guestPage, useStore } from "./app-store.js";
import { onPrefsChanged, prefInForce, savePref } from "./app-prefs.js";
import { readStream } from "./read-stream.js";
import { Dialog } from "./ui-dialog.js";
import { ErrorState, Skeleton } from "./ui-states.js";
import { Icon } from "./ui-icons.js";
import "./view-strings.js";

function tn(key, values = {}) {
  let s = t(`view.${key}`);
  for (const [k, v] of Object.entries(values)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* this page only */ } };

// ── AI usage ── Every provider the fleet's logins report; refreshed every 60 s while this dialog is open (passive).
const USAGE_ORDER_KEY = "agend_view_usage_order";
function usageText(fallback, ref) {
  if (!ref || typeof ref.key !== "string") return fallback == null ? "" : String(fallback);
  return (Array.isArray(ref.args) ? ref.args : []).reduce((text, value, i) => text.split(`{${i}}`).join(String(value)), t(`view.${ref.key}`));
}
function usageDuration(ms) {
  const total = Math.max(1, Math.ceil(ms / 60000));
  const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
  if (total >= 2880) return usageText("", { key: "usage.duration.days_hours", args: [d, h] });
  if (total >= 60) return usageText("", { key: "usage.duration.hours_minutes", args: [Math.floor(total / 60), m] });
  return usageText("", { key: "usage.duration.minutes", args: [total] });
}
function resetText(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return tn("usage.reset.soon");
  return usageText("", { key: "usage.reset.in", args: [usageDuration(ms)] });
}
/** "14:05" today, "10/19 14:05" another day, in this browser's time: when last known numbers were read, a window reset. */
export function usageClock(iso, now = Date.now()) {
  const at = new Date(iso || "");
  if (Number.isNaN(at.getTime())) return "";
  const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return new Date(now).toDateString() === at.toDateString() ? hm : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}
/**
 * A row showing its last known numbers (the live read failed; #2236 follow-up): "已過期 · 快取於 14:05" and, for an expiry
 * or another failure, what to do on a second line (its full text is the mark's tooltip too). A row from an older
 * server (no `cachedAt`) says its hint, as before.
 */
export function staleNote(p) {
  if (!p.stale) return null;
  if (!p.cachedAt || !p.staleCause) return { mark: usageText(p.hint || "", p.hintI18n), detail: "" };
  const detail = p.staleCause !== "transient" && (p.hint || p.hintI18n) ? usageText(p.hint || "", p.hintI18n) : "";
  return { mark: usageText("", { key: `usage.stale.${p.staleCause}`, args: [usageClock(p.cachedAt)] }), detail };
}
function expiryText(iso) {
  if (!iso) return "";
  const at = new Date(iso), ms = at.getTime() - Date.now();
  if (!(ms > 0)) return "";
  return usageText("", { key: "usage.ticket_expiry", args: [`${at.getMonth() + 1}/${at.getDate()}`, usageDuration(ms)] });
}
export function UsageMetric({ m }) {
  const bar = useRef(null);
  const label = usageText(m.label, m.labelI18n);
  // Its window has reset since these numbers were read: no number and no bar — an old one is never shown as current.
  if (m.resetPassed) return html`<div class="u-metric u-reset-since"><div class="u-row"><span class="u-label">${label}</span><span class="u-val">${usageText("", { key: "usage.metric.reset_since", args: [usageClock(m.resetsAt)] })}</span></div></div>`;
  const note = m.note ? usageText(m.note, m.noteI18n) : "";
  const pct = m.type === "percent" ? Math.min(100, Math.max(0, m.used ?? 0)) : 0;
  useLayoutEffect(() => { if (bar.current) bar.current.style.width = `${pct}%`; }, [pct]);   // CSSOM (#1300)
  if (m.type === "percent") {
    const cls = pct >= 90 ? "crit" : pct >= 70 ? "warn" : "";
    const word = pct >= 90 ? tn("usageNear") : pct >= 70 ? tn("usageHigh") : "";
    const sub = [note, resetText(m.resetsAt)].filter(Boolean).join(" · ");
    return html`<div class="u-metric"><div class="u-row"><span class="u-label">${label}</span>${word ? html`<span class=${`u-status ${cls}`}>${word}</span>` : null}
      <span class=${`u-pct ${cls}`}>${pct.toFixed(0)}<span class="u-unit">%</span></span></div>
      <div class="u-meter"><div ref=${bar} class=${`u-fill ${cls}`}></div></div>${sub ? html`<div class="u-sub">${sub}</div>` : null}</div>`;
  }
  if (m.type === "dollars") {
    const val = m.limit ? `$${(m.used ?? 0).toFixed(2)} / $${m.limit.toFixed(2)}` : `$${(m.used ?? 0).toFixed(2)}`;
    return html`<div class="u-metric"><div class="u-row"><span class="u-label">${label}</span><span class="u-val">${val}</span></div>${note ? html`<div class="u-sub">${note}</div>` : null}</div>`;
  }
  const val = `${usageText(m.value ?? "", m.valueI18n)} ${usageText(m.unit ?? "", m.unitI18n)}`.trim();
  const sub = [note, expiryText(m.expiresAt)].filter(Boolean).join(" · ");
  return html`<div class="u-metric"><div class="u-row"><span class="u-label">${label}</span><span class="u-val">${val}</span></div>${sub ? html`<div class="u-sub">${sub}</div>` : null}</div>`;
}
/**
 * #2014: a row's title. A credential profile's row (`profile`; its API `name` is "Claude (<profile>)") shows the
 * provider name on the title line beside the plan badge, and the profile on its own full-width muted line under it;
 * the full name is the tooltip, and the dialog shows the profile unclipped. The default login's row beside profiles
 * (`defaultLogin`; "Claude (default)", #2236) does the same with "default" in the page's language, never a clipped
 * "Claude (d…". Any other row: its name.
 */
export function providerTitle(p) {
  const name = String((p && p.name) || ""), profile = p && typeof p.profile === "string" && p.profile ? p.profile : "";
  if (!profile && p && p.defaultLogin === true && name.endsWith(" (default)")) return { base: name.slice(0, -" (default)".length), profile: tn("usage.default_login") };
  const suffix = ` (${profile})`;
  return profile && name.endsWith(suffix) ? { base: name.slice(0, -suffix.length), profile } : { base: name, profile };
}

/**
 * #1749: a plan as its badge reads — one short line. "Name [Tier] (N×)" (Claude's "Team Premium (6.25x)", "Max (20x)")
 * becomes "Name ×N"; anything else (Pro, Codex's and muse's labels) as it is. The full name stays on the badge's
 * tooltip and for a screen reader.
 */
export function planBadge(plan) {
  const text = String(plan || "").trim();
  const m = /^(\S+)(?: [^()]+)? \((\d+(?:\.\d+)?)x\)$/i.exec(text);
  if (m) return `${m[1]} ×${m[2]}`;
  // #2412: a long name ("Self Serve Business Usage Based", Codex's plan_type spelled out) says only its kind, so the badge
  // never takes the row from the provider's name; the full name is the badge's tooltip.
  if (text.length > PLAN_BADGE_MAX) {
    for (const [word, short] of PLAN_KINDS) if (word.test(text)) return short;
  }
  return text;
}
const PLAN_BADGE_MAX = 14;
/** The kinds a long plan name is shortened to, the most specific first. */
const PLAN_KINDS = [[/\benterprise\b/i, "Enterprise"], [/\bbusiness\b/i, "Business"], [/\bteam\b/i, "Team"], [/\bedu(?:cation)?\b/i, "Edu"],
  [/\bpro\+/i, "Pro+"], [/\bpro\b/i, "Pro"], [/\bplus\b/i, "Plus"], [/\bmax\b/i, "Max"], [/\bfree\b/i, "Free"]];
/** "Updated 3 min ago" (#1585): how old the numbers are — the panel may show the last snapshot while a fresh one comes. */
export function updatedAgo(fetchedAt, now = Date.now()) {
  const ms = now - new Date(fetchedAt).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return tn("usageUpdatedJustNow");
  const min = Math.floor(ms / 60_000);
  return tn("usageUpdatedAgo", { age: min < 60 ? tn("usageMinutes", { n: min }) : tn("usageHours", { n: Math.floor(min / 60) }) });
}

// ── Compact: one line per login (a synced preference, "usage.compact"; the dialog and the rail alike) ──
const COMPACT_KEY = "agend_usage_compact";
function readCompact() {
  const p = prefInForce("usage.compact");
  return (p ? p.value : stored(COMPACT_KEY) === "on" ? true : undefined) === true;
}
export const usageViewStore = createStore({ compact: readCompact() });
export function setUsageCompact(on) {
  usageViewStore.set({ compact: !!on });
  savePref("usage.compact", on ? true : null);   // the full cards are the default: switching back clears it
}
onPrefsChanged((keys) => { if (keys.has("usage.compact")) usageViewStore.set({ compact: readCompact() }); });
/** The header's switch between one line per login and the full cards (beside the title: the dialog's and the rail's). */
export function UsageCompactToggle() {
  const { compact } = useStore(usageViewStore);
  const [label, title] = compact ? [tn("usageFull"), tn("usageFullTitle")] : [tn("usageCompact"), tn("usageCompactTitle")];
  return html`<button type="button" class="btn btn-ghost btn-sm u-compact-toggle" aria-pressed=${compact ? "true" : "false"} title=${title}
    onClick=${() => setUsageCompact(!compact)}>${label}</button>`;
}
const TWO_DAYS = 48 * 3_600_000;
/**
 * A login's two columns on its compact line: `short`, its shortest percent window under two days (the session), and
 * `long`, its longest of two days or more (the week, the month) — null when it has none (a dash in that column). A window
 * that reset since the numbers were read is left out (its full card shows no number); one of unknown length is a long one.
 */
export function compactSlots(p) {
  const pct = ((p && p.metrics) || []).filter((m) => m && m.type === "percent" && !m.resetPassed);
  const isShort = (m) => Number(m.windowMs) > 0 && m.windowMs < TWO_DAYS;
  const short = pct.filter(isShort).sort((a, b) => a.windowMs - b.windowMs)[0] || null;
  const long = pct.filter((m) => !isShort(m)).map((m, i) => ({ m, i }))
    .sort((a, b) => ((Number(b.m.windowMs) || -1) - (Number(a.m.windowMs) || -1)) || a.i - b.i)[0]?.m || null;
  return { short, long };
}
/** The windows a compact line shows, short first. */
export const compactMetrics = (p) => { const { short, long } = compactSlots(p); return [short, long].filter(Boolean); };
/** A window as a few characters ("5h", "7d"); one whose length is not known says its label. */
export function windowTag(m) {
  const ms = Number(m && m.windowMs);
  if (!(ms > 0)) return usageText(m.label, m.labelI18n);
  const h = ms / 3_600_000;
  return h < 48 ? tn("usageWindowHours", { n: Math.round(h) }) : tn("usageWindowDays", { n: Math.round(h / 24) });
}
/** A time ahead in one unit, for the narrow column: "45m", "3h", "4d" (rounded down past an hour; the tooltip is exact). */
function coarseDuration(ms) {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return tn("usageWindowMinutes", { n: min });
  const h = Math.floor(min / 60);
  return h < 48 ? tn("usageWindowHours", { n: h }) : tn("usageWindowDays", { n: Math.floor(h / 24) });
}
/** The soonest reset still ahead among `metrics`: { short: "↻ 2h", full: "resets in 2h 5m" }, or null when none is known. */
export function soonestReset(metrics, now = Date.now()) {
  const at = metrics.map((m) => new Date(m.resetsAt || "").getTime()).filter((t) => Number.isFinite(t) && t > now).sort((a, b) => a - b)[0];
  return at === undefined ? null : { short: `↻ ${coarseDuration(at - now)}`, full: resetText(new Date(at).toISOString()) };
}
/**
 * The logins grouped by provider for the compact view (nine logins, five of them Claude's: the provider once, then a
 * line per login), in the order the person set (↑↓): a group where its first login is, its logins in their order.
 */
export function compactGroups(providers) {
  const groups = new Map();
  providers.forEach((p, i) => {
    const base = providerTitle(p).base;
    if (!groups.has(base)) groups.set(base, { base, items: [] });
    groups.get(base).items.push({ p, i });
  });
  return [...groups.values()];
}
const level = (pct) => (pct >= 90 ? "crit" : pct >= 70 ? "warn" : "");
/**
 * #2240: an account whose percent windows come from several pools (agy: Gemini, Claude & others, Gemini 4 Argon) — each
 * pool with its windows and the tighter one (the most used); null for an account of one pool (its 5h / 7d lines).
 */
export function compactPools(p) {
  const pct = ((p && p.metrics) || []).filter((m) => m && m.type === "percent" && !m.resetPassed);
  const pools = new Map();
  for (const m of pct) {
    if (!m.pool || typeof m.pool.label !== "string") return null;
    if (!pools.has(m.pool.label)) pools.set(m.pool.label, { pool: m.pool, metrics: [] });
    pools.get(m.pool.label).metrics.push(m);
  }
  if (pools.size < 2) return null;
  return [...pools.values()].map((x) => ({ ...x, worst: x.metrics.reduce((a, b) => ((b.used ?? 0) > (a.used ?? 0) ? b : a)) }));
}
const pctOf = (m) => Math.min(100, Math.max(0, m.used ?? 0));
/** When a window resets, at the clock ("14:05", "10/19 14:05"), for a tooltip; "" when unknown or already past. */
function resetClock(m, now = Date.now()) {
  const at = new Date((m && m.resetsAt) || "").getTime();
  return Number.isFinite(at) && at > now ? `↻ ${usageClock(m.resetsAt, now)}` : "";
}
/**
 * One window on its own line: its few characters ("5h"), a full-width bar, the percent coloured as the full card, and
 * when this window resets ("↻ 8m"; the user's ask, 2026-10-23: a week's reset was hidden behind the 5 h one's). A pool's
 * line (#2240): the pool's name in place of the window, the reset of the window its percent is, every window (with its
 * reset time) in the tooltip.
 */
function CompactMeter({ m, tag, title }) {
  const bar = useRef(null);
  const pct = Math.min(100, Math.max(0, m.used ?? 0)), cls = level(pct);
  useLayoutEffect(() => { if (bar.current) bar.current.style.width = `${pct}%`; }, [pct]);   // CSSOM (#1300)
  const word = cls === "crit" ? tn("usageNear") : cls === "warn" ? tn("usageHigh") : "";
  const reset = soonestReset([m]), clock = resetClock(m);
  return html`<span class="u-cm" title=${title || `${usageText(m.label, m.labelI18n)}: ${pct.toFixed(0)}%${word ? ` (${word})` : ""}${clock ? ` · ${clock}` : ""}`}>
    <span class="u-cm-tag">${tag || windowTag(m)}</span><span class="u-cm-bar"><span ref=${bar} class=${`u-cm-fill ${cls}`}></span></span>
    <span class=${`u-cm-pct ${cls}`}>${pct.toFixed(0)}%</span>
    <span class="u-cm-reset">${reset ? html`${reset.short}<span class="sr-only"> (${reset.full})</span>` : null}</span></span>`;
}
/** What a login says instead of numbers (not logged in, an error), or "" when it has numbers. */
function rowNote(p) {
  if (p.status === "error") return usageText(p.error || tn("usage.error_fallback"), p.errorI18n);
  if (p.status === "no-credentials") return tn("usage.not_logged_in");
  return "";
}
/**
 * A login in three short lines, under its provider's name (the user's pick, 2026-10-22): its name and plan; then its
 * short window and its long one, each a labelled full-width bar, the percent and that window's own reset.
 * Numbers not current, a failed read or no login: one muted line in place of the bars, what is wrong as its tooltip.
 * Pressed, it opens its full card.
 */
export function CompactRow({ p, onExpand }) {
  const title = providerTitle(p), failed = p.status === "error" || p.status === "no-credentials";
  // Last known numbers (stale, e.g. an expired token) show as the others do (the user, 2026-10-23; the full card has since
  // #2386), with a small "cached at 07:47" on the name line; a window that reset since is left out (compactSlots).
  const pools = failed ? null : compactPools(p);
  const metrics = failed ? [] : pools ? pools.flatMap((x) => x.metrics) : compactMetrics(p);
  const note = rowNote(p), stale = p.stale ? staleNote(p) : null;
  const say = stale ? stale.mark : note || tn("usage.no_data");
  const detail = stale ? [stale.mark, stale.detail].filter(Boolean).join(" — ") : say;
  const name = title.profile || title.base;
  return html`<button type="button" class=${`u-crow${p.stale ? " is-stale" : ""}${pools ? " is-pooled" : ""}`} aria-expanded="false" title=${`${p.name} — ${tn("usageExpand")}`} onClick=${onExpand}>
    <span class="u-crow-head"><span class="u-crow-name">${name}</span>
      ${p.plan ? html`<span class="pill u-plan" title=${p.plan}><span aria-hidden="true">${planBadge(p.plan)}</span><span class="sr-only">${p.plan}</span></span>` : null}
      ${stale && metrics.length ? html`<span class="u-crow-stale" title=${detail}>${p.cachedAt ? tn("usageCachedAt", { at: usageClock(p.cachedAt) }) : stale.mark}<span class="sr-only"> (${detail})</span></span>` : null}</span>
    ${pools ? pools.map((x) => html`<${CompactMeter} key=${x.pool.label} m=${x.worst} tag=${usageText(x.pool.label, x.pool.labelI18n)}
        title=${x.metrics.map((m) => { const c = resetClock(m); return `${usageText(m.label, m.labelI18n)}: ${pctOf(m).toFixed(0)}%${c ? ` (${c})` : ""}`; }).join(" · ")} />`)
      : metrics.length ? metrics.map((m, j) => html`<${CompactMeter} key=${j} m=${m} />`)
      : html`<span class=${`u-crow-note${(stale || (p.status === "error" && !p.transient)) ? " is-alert" : ""}`} title=${detail}>${say}</span>`}
  </button>`;
}
/** A provider's logins: its name once (×N), in small capitals, then each login (or the full card of one opened). */
export function CompactGroup({ group, line }) {
  return html`<section class="u-cgroup">
    <div class="u-cg-head"><span class="u-cg-name" title=${group.base}>${group.base}</span>${group.items.length > 1 ? html`<span class="u-cg-count">×${group.items.length}</span>` : null}</div>
    ${group.items.map(line)}
  </section>`;
}

/**
 * The usage read and its rows: the dialog's body and the rail's (#1673). `owner`: its lease's key — the reads and the
 * minute's timer live and end with it.
 */
export function UsageBody({ owner }) {
  const lease = useLease(owner);
  const [data, setData] = useState(undefined);       // undefined: loading; null: failed, with nothing read before
  // The last read failed while numbers were already shown: they stay, with a quiet note (#2236/#2289 for the server's
  // rows; here for the read itself — a dropped or failed read must not flash the error over numbers already on screen).
  const [failed, setFailed] = useState(false);
  const [order, setOrder] = useState(() => { try { const a = JSON.parse(stored(USAGE_ORDER_KEY) || "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch { return []; } });
  const reads = useMemo(() => readStream(lease), [lease]);
  // Compact (one line per login): a line pressed opens its full card here, until folded or the mode changes.
  const { compact } = useStore(usageViewStore);
  const [expanded, setExpanded] = useState(() => new Set());
  useEffect(() => { setExpanded(new Set()); }, [compact]);
  const toggleOne = (id) => setExpanded((was) => { const next = new Set(was); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  // Refresh (force) supersedes a read on its way; the minute's tick waits for it.
  const load = async (force) => {
    const token = reads.begin(force);
    if (!token) return;
    try {
      const r = await lease.fetch(`/api/ai-usage${force ? "?force=1" : ""}`);
      if (!reads.live(token)) return;
      // A refused or failed answer (a 500, a proxy's 502 page, a session that lapsed) is a failed read, not numbers.
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (!d || !Array.isArray(d.providers)) throw new Error("no providers");
      if (reads.live(token)) { setData(d); setFailed(false); }
    } catch {
      if (!reads.live(token)) return;
      setData((had) => (had && Array.isArray(had.providers) ? had : null));   // the last numbers stay; none: the error
      setFailed(true);
    }
    finally { reads.end(token); }
  };
  useEffect(() => { load(false); lease.interval(() => load(false), 60_000); }, [lease]);
  // #1585: the server answered with the last snapshot while it fetches a fresh one — read again shortly (the same
  // cache: no vendor call of its own) so the fresh numbers replace it without waiting for the minute's tick.
  useEffect(() => {
    if (!data || !data.refreshing || failed) return undefined;
    const timer = setTimeout(() => load(false), 4_000);
    return () => clearTimeout(timer);
  }, [data, failed]);
  const key = (p) => String(p.id || p.name || "");
  const ordered = (providers) => {
    const rank = new Map(order.map((id, i) => [id, i]));
    return providers.map((p, i) => ({ p, i })).sort((a, b) => {
      const ar = rank.has(key(a.p)) ? rank.get(key(a.p)) : Infinity, br = rank.has(key(b.p)) ? rank.get(key(b.p)) : Infinity;
      return ar === br ? a.i - b.i : ar - br;
    }).map((e) => e.p);
  };
  const move = (id, delta, providers) => {
    const ids = ordered(providers).map(key);
    const from = ids.indexOf(id), to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    setOrder(ids); store(USAGE_ORDER_KEY, JSON.stringify(ids));
  };
  let content;
  if (data === undefined) content = html`<${Skeleton} lines=${4} />`;
  else if (!data || !Array.isArray(data.providers)) content = html`<${ErrorState} message=${tn("usageFail")} onRetry=${() => load(true)} />`;
  else {
    const providers = ordered(data.providers);
    const card = (p, i) => html`<section key=${key(p)} class=${p.stale ? "u-provider is-stale" : "u-provider"}>
        <div class="u-head"><strong title=${p.name}>${providerTitle(p).base}</strong>${p.plan ? html`<span class="pill u-plan" title=${p.plan}><span aria-hidden="true">${planBadge(p.plan)}</span><span class="sr-only">${p.plan}</span></span>` : null}
          <span class="u-order">${compact ? html`<button type="button" class="icon-btn u-collapse" aria-expanded="true" aria-label=${tn("usageCollapse")} title=${tn("usageCollapse")}
              onClick=${() => toggleOne(key(p))}><${Icon} name="minus" size=${14} /></button>` : null}
            <button type="button" class="icon-btn" disabled=${i === 0} aria-label=${tn("usageMoveUp")} title=${tn("usageMoveUp")} onClick=${() => move(key(p), -1, data.providers)}><${Icon} name="up" size=${14} /></button>
            <button type="button" class="icon-btn" disabled=${i === providers.length - 1} aria-label=${tn("usageMoveDown")} title=${tn("usageMoveDown")} onClick=${() => move(key(p), 1, data.providers)}><${Icon} name="down" size=${14} /></button>
          </span></div>
        ${providerTitle(p).profile ? html`<div class="u-profile" title=${p.name}>${providerTitle(p).profile}</div>` : null}
        ${p.stale ? html`<p class="note u-stale" title=${staleNote(p).detail || null}>${staleNote(p).mark}</p>${staleNote(p).detail ? html`<p class="note u-stale-detail">${staleNote(p).detail}</p>` : null}` : null}
        ${p.status === "error" && !p.transient ? html`<p class="u-err">${usageText(p.error || tn("usage.error_fallback"), p.errorI18n)}</p>`
          : p.status === "error" && p.transient ? html`<p class="note">${usageText(p.error || tn("usage.error_fallback"), p.errorI18n)}</p>`
          : p.status === "no-credentials" ? html`<p class="note">${tn("usage.not_logged_in")}</p>${p.hint ? html`<p class="note">${usageText(p.hint, p.hintI18n)}</p>` : null}`
          : html`${(p.metrics || []).map((m, j) => html`<${UsageMetric} key=${j} m=${m} />`)}
            ${!p.stale && p.hint ? html`<p class="note">${usageText(p.hint, p.hintI18n)}</p>` : !(p.metrics || []).length ? html`<p class="note">${tn("usage.no_data")}</p>` : null}`}
      </section>`;
    content = html`${!providers.length ? html`<p class="note">${tn("usage.empty_active")}</p>` : null}
      ${compact ? compactGroups(providers).map((g) => html`<${CompactGroup} key=${g.base} group=${g}
          line=${({ p, i }) => (expanded.has(key(p)) ? card(p, i) : html`<${CompactRow} key=${key(p)} p=${p} onExpand=${() => toggleOne(key(p))} />`)} />`)
        : providers.map((p, i) => card(p, i))}
      <div class="u-foot"><span class="note" title=${new Date(data.fetchedAt).toLocaleString()}>${updatedAgo(data.fetchedAt)}${failed ? html` · <span class="u-refresh-failed" role="status">${tn("usageRefreshFailed")}</span>` : data.refreshing ? html` · <span class="u-refreshing">${tn("usageRefreshing")}</span>` : null}</span>
        ${byAgent() ? html`<a class="btn btn-ghost btn-sm u-by-agent" href="/ui/fleet/usage" title=${tn("usageByAgentTitle")}>${tn("usageByAgent")}</a>` : null}
        <button type="button" class="btn btn-sm" onClick=${() => load(true)}>${tn("usageRefresh")}</button></div>`;
  }
  return content;
}

/**
 * #2122: the plans above are per login; each agent's own tokens and API-equivalent are Fleet → Usage — linked from the
 * app (not View's anonymous reader, not a guest, who has no Fleet).
 */
const byAgent = () => !guestPage() && typeof location !== "undefined" && location.pathname.startsWith("/ui");

/** `owner`: the navigation that opened it — its reads and the minute's timer live and end with it. */
export function UsageDialog({ onClose, owner = "" }) {
  return html`<${Dialog} title=${tn("usage.title")} tools=${html`<${UsageCompactToggle} />`} onClose=${onClose} wide=${true}><${UsageBody} owner=${`usage-dialog:${owner}`} /></${Dialog}>`;
}
