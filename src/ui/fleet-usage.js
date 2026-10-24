// #2122: Fleet → Usage (/ui/fleet/usage) — each agent's tokens, requests, delivered messages and their API-equivalent
// at list price over a range of days, ranked; a daily trend, a calendar heatmap and a CSV of the same answer. Behind the
// session gate (/ui/js/), imported by the Fleet panel. Read-only: it changes nothing.
//
// One GET /ui/usage-report?… per opening and per choice of range or grouping (a person's navigation); no timer re-reads
// it (#1374). Every amount says what it is: "API-equivalent at list price — not money spent" (design §3).
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { money, tokens } from "./fleet-cache.js";

register("fusage", {
  en: {
    range: "Range", today: "Today", r7d: "7 days", month: "This month", all: "All", custom: "Custom", from: "From", to: "To", apply: "Apply",
    group: "Group by", g_instance: "Agent", g_backend: "Backend", g_model: "Model", g_profile: "Credential profile", g_team: "Team (as configured now)",
    csv: "Download CSV", basis: "API-equivalent at list price (checked {0}) — not money spent. Subscriptions are not billed per token.",
    amount: "API-equivalent", input: "Input", output: "Output", reasoning: "Reasoning", read: "Cache read", write: "Cache write", total: "Total tokens", requests: "Requests", messages: "Messages",
    notPriced: "not priced", partial: "partial", noTeam: "(no team)", unknown: "unknown",
    f_cache_write_not_reported: "cache writes not reported (Codex, Muse) — an estimate", f_not_priced: "not priced: {0}", f_source_unknown: "read before backend and profile were recorded",
    f_estimated: "estimated from text size — Kiro records no token counts", f_includes_estimates: "includes estimates (Kiro)", f_cost_reported: "amount as the CLI reported it (no list price for this model)", estimatedPart: "of which estimated: {0}",
    scanning: "Scanning — totals may still grow.", updated: "Updated {0} · read every 10 min", since: "Collected since {0}", notYet: "Not collected yet",
    refresh: "Refresh",
    notMeasured: "Not measured", nm_credit_billed: "Kiro is credit-billed and records no tokens", nm_unsupported: "AgEnD can't read this CLI's usage yet", nm_no_data: "nothing read yet",
    shared: "shares its working directory with {0}; their transcripts can't be told apart",
    empty: "Nothing recorded yet", emptyHint: "Usage is read from Claude Code, Codex, Grok and Muse transcripts, and estimated for Kiro, from when the fleet started.",
    blocked: "Not offered over the public link", blockedHint: "Usage is offered over the public link only when \"Usage report over the public link\" is on in Settings → Web dashboard — on the dashboard reached directly, on the computer running AgEnD.",
    openSettings: "Open Settings → Web dashboard on that computer",
    partialDays: "Daily detail from {0}: the earlier days in this range are too many rows to send. The rows and totals above cover the whole range; the trend, the heatmap and the CSV start at {0}.",
    csvFrom: "Download CSV (from {0})",
    noDaily: "No daily detail for this range: even its latest day has more rows than one answer carries, and a part of a day is never shown as the day. The rows and totals above are complete; the trend, the heatmap and the CSV need the daily detail and are not shown.",
    zoneChanged: "The fleet's timezone changed: these days were made in {0}. A day keeps the zone it was made in, so a day made in two shows each part (see the heatmap). Days from now on are in {1}.",
    dayTokens: "{0} tokens", partNotPriced: "part not priced",
    trendUnpriced: "Not priced, so not in these bars: {0}. Their tokens are in the rows and the heatmap.",
    off: "Usage is turned off", offHint: "web.usage_panel: false hides it.",
    trend: "Daily trend", trendTokens: "tokens (nothing here is priced)", others: "Others", heatmap: "Daily totals",
    h_idle: "{0}: read, nothing used", h_gap: "{0}: not collected", h_day: "{0}: {1}", keyGap: "not collected", keyIdle: "read, nothing used", keyUsed: "used (stronger: more tokens)", scale: "Tallest day: {0}", earlier: "← Scroll for earlier days",
    trendLabel: "Daily {0} for the top {1} and others, {2} to {3}.", trendLabelAll: "Daily {0} for {1} agents, {2} to {3}.", heatLabel: "{0} days; {1} with usage, {2} not collected.",
    zoneNote: "Days in {0}, whole hours.", teamsNote: "Teams as configured now.",
    noRows: "Nothing in this range.",
  },
  "zh-TW": {
    range: "期間", today: "今天", r7d: "7 天", month: "本月", all: "全部", custom: "自訂", from: "從", to: "到", apply: "套用",
    group: "分組", g_instance: "Agent", g_backend: "Backend", g_model: "模型", g_profile: "憑證 profile", g_team: "Team（依目前設定）",
    csv: "下載 CSV", basis: "依牌價換算的 API 等值（查證日期 {0}）——不是實際花費。訂閱方案不按 token 計費。",
    amount: "API 等值", input: "輸入", output: "輸出", reasoning: "推理", read: "快取讀取", write: "快取寫入", total: "token 總計", requests: "請求數", messages: "訊息數",
    notPriced: "未定價", partial: "部分", noTeam: "（不屬於任何 team）", unknown: "未知",
    f_cache_write_not_reported: "未回報快取寫入（Codex、Muse）——是估算", f_not_priced: "未定價：{0}", f_source_unknown: "讀取時尚未記錄 backend 與 profile",
    f_estimated: "依文字長度估算——Kiro 不記錄 token 數", f_includes_estimates: "含估算值（Kiro）", f_cost_reported: "金額為 CLI 自行回報（價目表沒有此模型）", estimatedPart: "其中估算：{0}",
    scanning: "掃描中——總數可能還會增加。", updated: "更新於 {0} · 每 10 分鐘讀取一次", since: "自 {0} 起收集", notYet: "尚未收集",
    refresh: "重新整理",
    notMeasured: "未量測", nm_credit_billed: "Kiro 以 credit 計費，不記錄 token", nm_unsupported: "AgEnD 目前還讀不到這個 CLI 的用量", nm_no_data: "尚未讀到任何資料",
    shared: "與 {0} 共用工作目錄，無法分辨各自的 transcript",
    empty: "還沒有任何紀錄", emptyHint: "用量從 Claude Code、Codex、Grok 與 Muse 的 transcript 讀取，Kiro 則為估算，自 fleet 啟動起計。",
    blocked: "公開連結上不提供", blockedHint: "只有在設定 → 網頁儀表板裡開啟「透過公開連結提供用量報告」時，公開連結才會提供用量；這個設定要在執行 AgEnD 的那台電腦上、直接開啟的儀表板裡變更。",
    openSettings: "在那台電腦上開啟設定 → 網頁儀表板",
    partialDays: "每日明細從 {0} 起：這段期間更早的日子資料列太多，無法一次送出。上方的各列與總計涵蓋整段期間；趨勢、熱度圖與 CSV 則從 {0} 開始。",
    csvFrom: "下載 CSV（從 {0} 起）",
    noDaily: "這段期間沒有每日明細：連最近的一天，資料列都超過一次回答能帶的數量，而不完整的一天絕不會被當成那一天顯示。上方的各列與總計是完整的；趨勢、熱度圖與 CSV 需要每日明細，所以不顯示。",
    zoneChanged: "fleet 的時區曾經變更：這些日子分別依 {0} 計算。每一天保留它當初計算時的時區，所以跨兩個時區的日子會分別列出各部分（見熱度圖）。之後的日子依 {1} 計算。",
    dayTokens: "{0} 個 token", partNotPriced: "部分未定價",
    trendUnpriced: "未定價，所以不在這些長條裡：{0}。它們的 token 列在各列與熱度圖中。",
    off: "用量已關閉", offHint: "已設定 web.usage_panel: false。",
    trend: "每日趨勢", trendTokens: "token（這裡沒有任何已定價的用量）", others: "其他", heatmap: "每日總計",
    h_idle: "{0}：已讀取，沒有用量", h_gap: "{0}：未收集", h_day: "{0}：{1}", keyGap: "未收集", keyIdle: "已讀取，沒有用量", keyUsed: "有用量（顏色越濃，token 越多）", scale: "最高的一天：{0}", earlier: "← 往左捲動可看較早的日子",
    trendLabel: "前 {1} 名與其他的每日{0}，{2} 至 {3}。", trendLabelAll: "{1} 個 agent 的每日{0}，{2} 至 {3}。", heatLabel: "{0} 天；{1} 天有用量，{2} 天未收集。",
    zoneNote: "日期依 {0}，以整點小時計。", teamsNote: "Team 依目前設定。",
    noRows: "這段期間沒有任何紀錄。",
  },
});
const tu = (k, ...v) => t(`fusage.${k}`, ...v);

export const USAGE_RANGES = ["today", "7d", "month", "all", "custom"];
export const USAGE_GROUPS = ["instance", "backend", "model", "profile", "team"];
const TOP = 5;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const n = (v) => Number(v || 0).toLocaleString("en-US");

/** The query for a choice of range and grouping. */
export function usageQuery({ range, group, from, to }) {
  const q = new URLSearchParams({ range, group });
  if (range === "custom") { q.set("from", from); q.set("to", to); }
  return `/ui/usage-report?${q}`;
}

/** A row's or a day's amount as shown: the API-equivalent, or why there is none. */
export function amountText(r) {
  if (r.amount === null || r.amount === undefined) return tu("notPriced");
  return `${money(r.amount)}${r.priced === "partial" ? ` (${tu("partial")})` : ""}`;
}
/** A group key as shown: "" is no team, "unknown" says what it is. */
export function keyText(group, key) {
  if (group === "team" && key === "") return tu("noTeam");
  if (key === "unknown") return tu("unknown");
  return key;
}
const writes = (r) => (r.cacheWrite5m || 0) + (r.cacheWrite1h || 0) + (r.cacheWrite || 0);
function flagText(f, r) {
  if (f === "not_priced") return tu("f_not_priced", (r.unpriced || []).join(", "));
  return ["cache_write_not_reported", "source_unknown", "estimated", "includes_estimates", "cost_reported"].includes(f) ? tu(`f_${f}`) : f;
}

// ── CSV (design §4): the daily rows of this same answer; messages on their own rows (they are per agent, not per model).
const CSV_COLUMNS = ["date", "zone", "instance", "backend", "model", "tier", "profile", "input", "output", "reasoning", "cache_read", "cache_write_5m", "cache_write_1h", "cache_write", "requests", "messages", "amount", "basis", "flags", "estimated"];
/** One CSV field: quoted when it must be, and never read as a formula by a spreadsheet (=, +, -, @, tab, CR first). */
export function csvField(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function usageCsv(report) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const d of report.daily || []) {
    lines.push([d.date, d.zone, d.instance, d.backend, d.model, d.tier, d.profile, d.input, d.output, d.reasoning, d.cacheRead, d.cacheWrite5m, d.cacheWrite1h, d.cacheWrite,
      d.requests, "", d.amount === null ? "" : d.amount.toFixed(6), report.basis, (d.flags || []).join(" "), d.estimated ? "yes" : "no"].map(csvField).join(","));
  }
  for (const m of report.messagesDaily || []) {
    lines.push([m.date, report.zone, m.instance, "", "", "", "", "", "", "", "", "", "", "", "", m.count, "", report.basis, "", ""].map(csvField).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.className = "offscreen";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Days: the range's local dates, which of them were read (coverage, §5.5), and what each one holds.
const shift = (date, k) => new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + k)).toISOString().slice(0, 10);
/** The local dates from `from` to `to` (inclusive), at most `max`, the latest kept. */
export function datesBetween(from, to, max = 400) {
  if (!DATE.test(from) || !DATE.test(to) || from > to) return [];
  const out = [];
  for (let d = to; d >= from && out.length < max; d = shift(d, -1)) out.unshift(d);
  return out;
}
/** The local dates in `zone` that some coverage interval reaches (hour by hour, as days are made, §5.3). */
export function coveredDates(coverage, zone) {
  let fmt;
  try { fmt = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }); } catch { fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }); }
  const out = new Set();
  for (const c of coverage || []) for (const [a, b] of c.intervals || []) {
    for (let h = Math.floor(a / 3_600_000) * 3_600_000; h <= b; h += 3_600_000) out.add(fmt.format(new Date(h)));
  }
  return out;
}
/** Intensity 1–4 for a day's value against the range's non-zero days (quartiles, as tokscale's heatmap); 0 for none. */
export function levels(values) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => nz[Math.max(0, Math.ceil(p * nz.length) - 1)];
  const cut = nz.length ? [q(0.25), q(0.5), q(0.75)] : [];
  return (v) => (!(v > 0) ? 0 : v <= cut[0] ? 1 : v <= cut[1] ? 2 : v <= cut[2] ? 3 : 4);
}

const tokensOf = (d) => d.input + d.output + (d.reasoning || 0) + d.cacheRead + d.cacheWrite5m + d.cacheWrite1h + d.cacheWrite;
/**
 * Each day of the answer: its tokens (whether it was used at all), the priced part of its amount, whether part of it is
 * not priced, and its parts by zone (a day folded before the fleet's timezone changed keeps its own zone, §5.3).
 */
export function dayTotals(report) {
  const m = new Map();
  for (const d of report.daily || []) {
    let e = m.get(d.date);
    if (!e) { e = { tokens: 0, amount: 0, unpriced: false, zones: new Map() }; m.set(d.date, e); }
    const t = tokensOf(d);
    e.tokens += t;
    if (d.amount === null) e.unpriced = true; else e.amount += d.amount;
    const z = e.zones.get(d.zone) || { tokens: 0, amount: 0 };
    z.tokens += t; z.amount += d.amount || 0; e.zones.set(d.zone, z);
  }
  return m;
}
/** A day in words: its tokens, its API-equivalent where priced, what is not priced, and each zone's part. */
export function dayText(date, e) {
  const parts = [tu("dayTokens", tokens(e.tokens))];
  if (e.amount > 0) parts.push(money(e.amount));
  if (e.unpriced) parts.push(tu(e.amount > 0 ? "partNotPriced" : "notPriced"));
  const zones = e.zones.size > 1 ? ` (${[...e.zones].map(([z, p]) => `${z}: ${tokens(p.tokens)}`).join(", ")})` : "";
  return tu("h_day", date, parts.join(" · ") + zones);
}
/** The zones the answer's days were made in, when they are not all the fleet's current one (§5.3). */
export function zonesChanged(report) {
  const zones = [...new Set((report.daily || []).map((d) => d.zone))];
  return zones.length > 1 || (zones.length === 1 && zones[0] !== report.zone) ? zones : null;
}

/** Estimated pixel width of one character in the 9 px `.us-axis` label. */
const LABEL_CHAR_W = 5.5;

/**
 * The 0-based indices of dates that should receive an x-axis label.
 * Keeps the first (0) and last (n-1) when they are far enough apart not to
 * overlap. When first and last are too close (n-1 < step), only the last
 * (most recent) is shown — overlap-free takes precedence over keeping both
 * ends. Intermediate labels are thinned so that no two consecutive shown
 * labels are closer than `labelWidthPx` pixels apart.
 *
 * @param {number} n            Number of data points (dates).
 * @param {number} slotPx       Pixels per slot (bar + gap).
 * @param {number} labelWidthPx Estimated rendered width of one label.
 * @returns {Set<number>}
 */
export function thinXLabels(n, slotPx, labelWidthPx) {
  if (n <= 0) return new Set();
  if (n === 1) return new Set([0]);
  // Minimum slot steps between label centres (+ 2 px breathing room).
  const step = Math.max(1, Math.ceil((labelWidthPx + 2) / slotPx));
  // If first and last are too close to both be shown without overlap, keep
  // only the last (most recent). The caller's "always first+last" contract
  // is relaxed here: overlap-free takes precedence.
  if (n - 1 < step) return new Set([n - 1]);
  const idx = [0];
  // Add intermediates that are at least `step` slots away from n-1.
  for (let i = step; i < n - step; i += step) idx.push(i);
  idx.push(n - 1); // always include last
  return new Set(idx);
}

/** The trend's series: the top `TOP` agents by the measure over the range, then "others"; one value per date. */
export function trendSeries(report, dates) {
  const priced = report.totals && report.totals.amount !== null && report.totals.amount > 0;
  const measure = (d) => (priced ? d.amount || 0 : tokensOf(d));
  const byAgent = new Map();
  for (const d of report.daily || []) byAgent.set(d.instance, (byAgent.get(d.instance) || 0) + measure(d));
  const ranked = [...byAgent.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked.slice(0, TOP).map(([k]) => k);
  const names = ranked.length > TOP ? [...top, tu("others")] : top;
  const at = new Map(dates.map((d, i) => [d, i]));
  const values = names.map(() => dates.map(() => 0));
  for (const d of report.daily || []) {
    const i = at.get(d.date);
    if (i === undefined) continue;
    const s = top.indexOf(d.instance);
    values[s >= 0 ? s : names.length - 1][i] += measure(d);
  }
  return { priced, names, values, totals: names.map((_, s) => values[s].reduce((a, b) => a + b, 0)) };
}
const fmtMeasure = (priced, v) => (priced ? money(v) : tokens(v));

/**
 * A chart wider than its box opens at its latest days (the right end), as a person reads a trend, and says that the
 * earlier days are a scroll away.
 */
function useLatestFirst(deps) {
  const ref = useRef(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current, over = !!el && el.scrollWidth > el.clientWidth;
    if (over) el.scrollLeft = el.scrollWidth;
    setWide(over);
  }, deps);
  return [ref, wide];
}
const EarlierHint = ({ wide }) => (wide ? html`<p class="note us-earlier">${tu("earlier")}</p>` : null);

function Trend({ report, dates }) {
  const s = useMemo(() => trendSeries(report, dates), [report, dates]);
  const [scroller, wide] = useLatestFirst([report, dates]);
  if (!s.names.length || !dates.length) return null;
  // A value scale on the left (the day with the most, and zero), the bars after it.
  const slot = 14, left = 52, right = 24, W = Math.max(320, left + dates.length * slot + right), H = 170, top = 16, base = 146;
  const sums = dates.map((_, i) => s.values.reduce((a, v) => a + v[i], 0));
  const max = Math.max(...sums, 0) || 1;
  const what = s.priced ? tu("amount") : tu("trendTokens"), others = s.names.length > TOP;
  const label = others ? tu("trendLabel", what, TOP, dates[0], dates[dates.length - 1]) : tu("trendLabelAll", what, s.names.length, dates[0], dates[dates.length - 1]);
  // Thin x-axis labels: "MM-DD" (5 chars) × LABEL_CHAR_W ≈ 27.5 px at 9 px sans-serif.
  const shownLabels = thinXLabels(dates.length, slot, 5 * LABEL_CHAR_W);
  return html`<section class="us-trend card" aria-labelledby="us-trend-h">
    <h3 id="us-trend-h">${tu("trend")} <span class="note">· ${s.priced ? tu("amount") : tu("trendTokens")}</span></h3>
    <p class="note us-scale">${tu("scale", fmtMeasure(s.priced, max))}</p>
    <div class="us-scroll" ref=${scroller}><svg class="us-chart" viewBox=${`0 0 ${W} ${H}`} width=${W} height=${H} role="img" aria-label=${label}>
      <line class="us-grid" x1=${left - 4} x2=${W} y1=${top} y2=${top} /><line class="us-base" x1=${left - 4} x2=${W} y1=${base} y2=${base} />
      <text class="us-axis" x=${left - 8} y=${top + 3} text-anchor="end">${fmtMeasure(s.priced, max)}</text>
      <text class="us-axis" x=${left - 8} y=${base + 3} text-anchor="end">0</text>
      ${dates.map((date, i) => {
        let y = base;
        return html`<g key=${date}>${s.values.map((v, k) => {
          const h = v[i] > 0 ? Math.max(1, ((base - top) * v[i]) / max) : 0;
          y -= h;
          return h ? html`<rect key=${k} class=${`us-s${k}`} x=${left + i * slot + 2} y=${y} width=${slot - 4} height=${h}><title>${`${date} · ${s.names[k]}: ${fmtMeasure(s.priced, v[i])}`}</title></rect>` : null;
        })}${shownLabels.has(i) ? html`<text class="us-axis us-xlabel" x=${left + i * slot + slot / 2} y=${H - 6} text-anchor="middle">${date.slice(5)}</text>` : null}</g>`;
      })}
    </svg></div>
    <${EarlierHint} wide=${wide} />
    ${s.priced && (report.totals.unpriced || []).length ? html`<p class="note us-unpriced">${tu("trendUnpriced", report.totals.unpriced.join(", "))}</p>` : null}
    <ul class="us-legend">${s.names.map((name, k) => html`<li key=${name}><span class=${`us-sw us-s${k}`} aria-hidden="true"></span><span class="mono">${name}</span> <span class="note">${fmtMeasure(s.priced, s.totals[k])}</span></li>`)}</ul>
  </section>`;
}

function Heatmap({ report, dates }) {
  const covered = useMemo(() => coveredDates(report.coverage, report.zone), [report]);
  // Whether a day was used, and how much, is its tokens: a day used only by a model not in the price table is used,
  // never "nothing used" (its title says it is not priced).
  const byDate = useMemo(() => dayTotals(report), [report]);
  const [scroller, wide] = useLatestFirst([report, dates]);
  if (!dates.length) return null;
  const level = levels(dates.map((d) => byDate.get(d)?.tokens || 0));
  // Weeks as columns, Monday first (a date's weekday from its own Y-M-D: no zone involved).
  const dow = (d) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
  // Weeks as columns under a month row (its short name where a month begins).
  const lead = dow(dates[0]), cell = 16, head = 14, W = (Math.ceil((lead + dates.length) / 7)) * cell + 2, H = head + 7 * cell + 2;
  let used = 0, gaps = 0;
  const months = [];
  const cells = dates.map((d, i) => {
    const e = byDate.get(d), v = e ? e.tokens : 0, k = lead + i, x = Math.floor(k / 7) * cell + 1, y = head + (k % 7) * cell + 1;
    if (i === 0 || d.endsWith("-01")) months.push(html`<text key=${`m${d}`} class="us-axis" x=${x} y=${10}>${new Date(`${d}T12:00:00Z`).toLocaleDateString([], { month: "short", timeZone: "UTC" })}</text>`);
    const state = v > 0 ? `l${level(v)}` : covered.has(d) ? "idle" : "gap";
    if (v > 0) used++; else if (state === "gap") gaps++;
    const title = v > 0 ? dayText(d, e) : state === "idle" ? tu("h_idle", d) : tu("h_gap", d);
    return html`<rect key=${d} class=${`us-h ${state}`} x=${x} y=${y} width=${cell - 3} height=${cell - 3} rx="2"><title>${title}</title></rect>`;
  });
  return html`<section class="us-heat card" aria-labelledby="us-heat-h">
    <h3 id="us-heat-h">${tu("heatmap")}</h3>
    <div class="us-scroll" ref=${scroller}><svg class="us-heatmap" viewBox=${`0 0 ${W} ${H}`} width=${W} height=${H} role="img" aria-label=${tu("heatLabel", dates.length, used, gaps)}>${months}${cells}</svg></div>
    <${EarlierHint} wide=${wide} />
    <p class="note us-heat-key"><span class="us-h-sw gap" aria-hidden="true"></span>${tu("keyGap")} · <span class="us-h-sw idle" aria-hidden="true"></span>${tu("keyIdle")} · <span class="us-h-sw l4" aria-hidden="true"></span>${tu("keyUsed")}</p>
  </section>`;
}

function Row({ r, group, max, measure }) {
  const share = max > 0 ? Math.max(0.01, measure(r) / max) : 0;
  const meta = [r.backends.join(", "), r.models.join(", "), r.profiles.join(", ")].filter(Boolean).join(" · ");
  return html`<tr class="us-row">
    <th scope="row" class="us-name"><span class="mono">${keyText(group, r.key)}</span>
      <svg class="us-bar" aria-hidden="true"><rect class="us-bar-bg" width="100%" height="6" rx="3" /><rect class="us-bar-fg" width=${`${Math.round(share * 100)}%`} height="6" rx="3" /></svg>
      ${group !== "instance" || meta ? html`<span class="us-meta">${meta}</span>` : null}
      ${r.flags.length ? html`<span class="us-flags">${r.flags.map((f) => html`<span key=${f} class="ch-tag">${flagText(f, r)}</span>`)}</span>` : null}</th>
    <td data-label=${tu("amount")} class=${`num${r.amount === null ? " muted" : ""}`}>${amountText(r)}</td>
    <td data-label=${tu("input")} class="num">${tokens(r.input)}</td>
    <td data-label=${tu("output")} class="num">${tokens(r.output)}</td>
    <td data-label=${tu("reasoning")} class="num">${r.reasoningReported === false ? "—" : tokens(r.reasoning || 0)}</td>
    <td data-label=${tu("read")} class="num">${tokens(r.cacheRead)}</td>
    <td data-label=${tu("write")} class="num">${r.flags.includes("cache_write_not_reported") && writes(r) === 0 ? "—" : tokens(writes(r))}</td>
    <td data-label=${tu("total")} class="num">${tokens(r.total)}</td>
    <td data-label=${tu("requests")} class="num">${n(r.requests)}</td>
    <td data-label=${tu("messages")} class="num">${r.messages === null ? "—" : n(r.messages)}</td>
  </tr>`;
}

/** The tab's body for one answer of GET /ui/usage-report. */
export function UsageReport({ report, choice, setChoice, refresh, fetchedAt }) {
  const group = report.group;                                // what this answer is grouped by (the choice may be on its way)
  const [draft, setDraft] = useState({ from: choice.from || report.range.from, to: choice.to || report.range.to });
  const dates = useMemo(() => {
    const first = report.range.from === "0000-01-01"
      ? [...(report.daily || []).map((d) => d.date), ...(report.messagesDaily || []).map((m) => m.date)].sort()[0] || report.range.to
      : report.range.from;
    // Daily detail cut to the latest whole days (too many rows): the charts start where it starts.
    // No daily detail at all (not even the latest day fits): no dates — no chart drawn from a part of a day.
    if (report.dailyTruncated && !report.dailyFrom) return [];
    return datesBetween(report.dailyTruncated && report.dailyFrom > first ? report.dailyFrom : first, report.range.to);
  }, [report]);
  const noDaily = report.dailyTruncated && !report.dailyFrom;
  const zones = zonesChanged(report);
  const csvFrom = report.dailyTruncated ? report.dailyFrom : report.range.kind === "all" ? "all" : report.range.from;
  const rows = report.rows.filter((r) => r.total > 0 || (r.messages || 0) > 0);
  const anyAmount = rows.some((r) => r.amount !== null && r.amount > 0);
  const measure = (r) => (anyAmount ? r.amount || 0 : r.total);
  const max = Math.max(0, ...rows.map(measure));
  const since = (report.coverage || []).flatMap((c) => c.intervals || []).reduce((m, [a]) => Math.min(m, a), Infinity);
  // Nothing at all to show yet: never collected, or nothing in everything collected.
  const empty = !rows.length && (report.range.kind === "all" || !Number.isFinite(since));
  return html`<div class="us">
    <div class="us-bar-top">
      <div class="seg-inline" role="group" aria-label=${tu("range")}>${USAGE_RANGES.map((k) => html`<button key=${k} type="button"
        class=${`btn btn-sm${k === choice.range ? " btn-primary" : ""}`} aria-pressed=${k === choice.range ? "true" : "false"}
        onClick=${() => (k === "custom" ? setChoice({ ...choice, range: "custom", from: draft.from, to: draft.to }) : setChoice({ ...choice, range: k }))}>${tu(k === "7d" ? "r7d" : k)}</button>`)}</div>
      <label class="us-group">${tu("group")} <select value=${choice.group} onChange=${(e) => setChoice({ ...choice, group: e.target.value })}>
        ${USAGE_GROUPS.map((g) => html`<option key=${g} value=${g}>${tu(`g_${g}`)}</option>`)}</select></label>
      <button type="button" class="btn btn-sm us-csv" disabled=${noDaily} title=${noDaily ? tu("noDaily") : undefined} onClick=${() => download(usageCsv(report), `agend-usage-${csvFrom}-${report.range.to}.csv`)}>
        <${Icon} name="download" size=${14} />${report.dailyTruncated && !noDaily ? tu("csvFrom", report.dailyFrom) : tu("csv")}</button>
    </div>
    ${choice.range === "custom" ? html`<form class="us-custom" onSubmit=${(e) => { e.preventDefault(); if (DATE.test(draft.from) && DATE.test(draft.to) && draft.from <= draft.to) setChoice({ ...choice, ...draft }); }}>
      <label>${tu("from")} <input type="date" value=${draft.from} max=${draft.to} onInput=${(e) => setDraft({ ...draft, from: e.target.value })} /></label>
      <label>${tu("to")} <input type="date" value=${draft.to} min=${draft.from} onInput=${(e) => setDraft({ ...draft, to: e.target.value })} /></label>
      <button type="submit" class="btn btn-sm">${tu("apply")}</button></form>` : null}
    <p class="us-basis" role="note">${tu("basis", report.pricesChecked)}</p>
    ${noDaily ? html`<p class="us-partial" role="status">${tu("noDaily")}</p>` : report.dailyTruncated ? html`<p class="us-partial" role="status">${tu("partialDays", report.dailyFrom)}</p>` : null}
    ${zones ? html`<p class="us-partial" role="status">${tu("zoneChanged", zones.join(", "), report.zone)}</p>` : null}
    <p class="note us-fresh">${tu("updated", new Date(fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))} · ${Number.isFinite(since) ? tu("since", new Date(since).toLocaleDateString()) : tu("notYet")} · ${tu("zoneNote", report.zone)}${group === "team" ? ` ${tu("teamsNote")}` : ""}
      ${report.scanning.active && (!report.scanning.caughtUp || report.scanning.pendingBytes > 0) ? html` <span class="us-scan" role="status">${tu("scanning")} <button type="button" class="btn btn-sm" onClick=${refresh}>${tu("refresh")}</button></span>` : null}</p>
    ${empty ? html`<${Empty} icon="chart" title=${tu("empty")} hint=${tu("emptyHint")} />` : html`
      <dl class="us-totals card">
        <div class="ch-metric"><dt>${tu("amount")}</dt><dd>${amountText(report.totals)}${report.totals.estimated
          ? html`<span class="us-est">${report.totals.amountEstimated !== null && report.totals.amountEstimated !== undefined ? tu("estimatedPart", money(report.totals.amountEstimated)) : tu("f_includes_estimates")}</span>` : null}</dd></div>
        <div class="ch-metric"><dt>${tu("total")}</dt><dd>${tokens(report.totals.total)}</dd></div>
        <div class="ch-metric"><dt>${tu("requests")}</dt><dd>${n(report.totals.requests)}</dd></div>
        <div class="ch-metric"><dt>${tu("messages")}</dt><dd>${report.totals.messages === null ? "—" : n(report.totals.messages)}</dd></div>
      </dl>
      ${rows.length ? html`<table class="us-table"><thead><tr><th scope="col">${tu(`g_${group}`)}</th><th scope="col" class="num">${tu("amount")}</th>
        <th scope="col" class="num">${tu("input")}</th><th scope="col" class="num">${tu("output")}</th><th scope="col" class="num">${tu("reasoning")}</th><th scope="col" class="num">${tu("read")}</th><th scope="col" class="num">${tu("write")}</th>
        <th scope="col" class="num">${tu("total")}</th><th scope="col" class="num">${tu("requests")}</th><th scope="col" class="num">${tu("messages")}</th></tr></thead>
        <tbody>${rows.map((r) => html`<${Row} key=${r.key} r=${r} group=${group} max=${max} measure=${measure} />`)}</tbody></table>`
        : html`<p class="note">${tu("noRows")}</p>`}
      <${Trend} report=${report} dates=${dates} />
      <${Heatmap} report=${report} dates=${dates} />`}
    ${report.notMeasured.length || report.shared.length ? html`<section class="us-rest" aria-labelledby="us-rest-h"><h3 id="us-rest-h">${tu("notMeasured")}</h3>
      <ul class="rows">${report.notMeasured.map((m) => html`<li key=${m.name} class="row-item"><span class="grow strong mono">${m.name}</span><span class="muted">${m.backend} · ${tu(`nm_${m.reason}`)}</span></li>`)}
      ${report.shared.map((m) => html`<li key=${m.name} class="row-item"><span class="grow strong mono">${m.name}</span><span class="muted">${m.backend} · ${tu("shared", m.with.join(", "))}</span></li>`)}</ul></section>` : null}
  </div>`;
}

/**
 * The tab: its own read (a refusal is a state the page explains, not an error): 403 over the public link without the
 * key, 404 with web.usage_panel: false.
 */
export function UsageTab({ lease }) {
  const [choice, setChoice] = useState({ range: "7d", group: "instance", from: "", to: "" });
  const [version, setVersion] = useState(0);
  const [state, setState] = useState(null);
  const seq = useRef(0);
  const path = choice.range === "custom" && !(DATE.test(choice.from) && DATE.test(choice.to)) ? null : usageQuery(choice);
  useEffect(() => {
    if (!path) return;
    const mine = ++seq.current;
    (async () => {
      try {
        const r = await lease.fetch(path, { method: "GET", headers: { "Content-Type": "application/json" } });
        if (!lease.current() || mine !== seq.current) return;
        if (r.status === 403 || r.status === 404) {
          const body = await r.json().catch(() => null);
          if (!lease.current() || mine !== seq.current) return;              // a newer read (or another page) owns the view
          // Over the public link: where it is turned on — Settings → Web dashboard on the dashboard reached directly (#2347;
          // an older AgEnD names /settings/web, which still leads there).
          setState({ blocked: r.status === 403 ? "blocked" : "off", settings: body && typeof body.settings === "string" && /^http:\/\/localhost:\d+\/settings\/(web|web-dashboard)$/.test(body.settings) ? body.settings : null });
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (lease.current() && mine === seq.current) setState(d && Array.isArray(d.rows) ? { data: d, at: Date.now() } : { error: true });
      } catch { if (lease.current() && mine === seq.current) setState({ error: true }); }
    })();
  }, [lease, path, version]);
  if (!state) return html`<${Skeleton} lines=${5} />`;
  if (state.blocked) return html`<${Empty} icon=${state.blocked === "blocked" ? "globe" : "chart"} title=${tu(state.blocked)} hint=${tu(`${state.blocked}Hint`)}
    action=${state.settings ? html`<a class="btn btn-primary us-fix" href=${state.settings}>${tu("openSettings")}</a>` : null} />`;
  if (state.error) return html`<${ErrorState} onRetry=${() => setVersion((v) => v + 1)} />`;
  return html`<${UsageReport} report=${state.data} fetchedAt=${state.at} choice=${choice} setChoice=${setChoice} refresh=${() => setVersion((v) => v + 1)} />`;
}
