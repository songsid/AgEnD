// #1523 N3 (§3.4): the AI usage dialog, opened from every page's header (◔). Moved from panel-view.js. Public
// (/assets/): View's anonymous reader opens it too. It reads /api/ai-usage every 60 s while open (passive, #1374).
// #1673: its body (UsageBody) is also the wide screen's right rail (header-tools.js UsageRail) — one read, one view.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "./app-html.js";
import { t } from "./app-i18n.js";
import { useLease } from "./app-ctx.js";
import { guestPage } from "./app-store.js";
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
  const m = /^(\S+)(?: [^()]+)? \((\d+(?:\.\d+)?)x\)$/i.exec(String(plan || "").trim());
  return m ? `${m[1]} ×${m[2]}` : String(plan || "");
}
/** "Updated 3 min ago" (#1585): how old the numbers are — the panel may show the last snapshot while a fresh one comes. */
export function updatedAgo(fetchedAt, now = Date.now()) {
  const ms = now - new Date(fetchedAt).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return tn("usageUpdatedJustNow");
  const min = Math.floor(ms / 60_000);
  return tn("usageUpdatedAgo", { age: min < 60 ? tn("usageMinutes", { n: min }) : tn("usageHours", { n: Math.floor(min / 60) }) });
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
    content = html`${!providers.length ? html`<p class="note">${tn("usage.empty_active")}</p>` : null}
      ${providers.map((p, i) => html`<section key=${key(p)} class=${p.stale ? "u-provider is-stale" : "u-provider"}>
        <div class="u-head"><strong title=${p.name}>${providerTitle(p).base}</strong>${p.plan ? html`<span class="pill u-plan" title=${p.plan}><span aria-hidden="true">${planBadge(p.plan)}</span><span class="sr-only">${p.plan}</span></span>` : null}
          <span class="u-order">
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
      </section>`)}
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
  return html`<${Dialog} title=${tn("usage.title")} onClose=${onClose} wide=${true}><${UsageBody} owner=${`usage-dialog:${owner}`} /></${Dialog}>`;
}
