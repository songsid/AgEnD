// #1468: Fleet → Cache (/ui/fleet/cache) — how often each instance's prompt cache expires between requests, what
// that costs, and whether keeping it warm would pay off. Behind the session gate (/ui/js/), imported by the Fleet
// panel. Read-only (Discord-first): it recommends, it changes nothing.
//
// One GET /ui/cache?window=… per opening or per choice of window (a person's navigation); no timer re-reads it
// (#1374). While the server is still reading transcripts the page says so and offers Refresh.
import { html } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Empty } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";

register("cache", {
  en: {
    title: "Cache", w24h: "24 h", w7d: "7 days", w30d: "30 days", window: "Window",
    fleetExpiry: "Expiry cost", fleetSaving: "Keep-warm would save", fleetRecommended: "Recommended", ofN: "{0} of {1}",
    pricesNote: "List prices checked {0}.", quotaNote: "Subscriptions: Anthropic and OpenAI do not publish how cache reads weigh against a plan's quota, so savings are exact at list price and an estimate in quota terms.",
    estimateNote: "Estimate: Codex does not record cache writes, so a write is taken as the request's uncached input.",
    notPricedNote: "Some models are not in the price table; those instances are compared in input-price units.",
    scanning: "Still reading transcripts — {0} left. Refresh to see more.", scanningFirst: "Reading transcripts for the first time — Refresh to see more.", refresh: "Refresh",
    keepWarm: "Keep warm", leaveOff: "Leave off", estimate: "estimate", notPriced: "not priced",
    requests: "Requests", pastTtl: "Past the TTL ({0})", expired: "Expired (rewrote)", rewritten: "Tokens rewritten",
    expiryCost: "Expiry cost", share: "{0} of its cost", pings: "Keep-warm pings", pingsAfter: "{0} after its last request",
    pingCost: "Ping cost", net: "Net with keep-warm", gaps: "Gaps between requests", ttlLine: "TTL {0}",
    quiet: "Too little activity in this window to tell.",
    neverExpired: "No gap outlasted the {0} cache.", survived: "{0} gaps outlasted the {1} TTL, but the cache was still there.",
    onlyIdle: "No request ever came back to an expired cache: each session went quiet for good. Keep-warm would only send {0} pings nobody reads.",
    saves: "Often idle past the {0} TTL and then used again: keep-warm would save {1} ({2} of the expiry cost).",
    costsMore: "Keep-warm would send about {0} pings per expired request — it would cost {1} more than it saves.",
    costsMoreUnits: "Keep-warm would send about {0} pings per expired request — it would cost more than it saves.",
    unavailable: "Not available", creditBilled: "credit-billed; no cache data", unsupported: "no cache data from this CLI", noData: "no requests read yet",
    shared: "shares its working directory with {0}; their transcripts cannot be told apart",
    empty: "No instances", emptyHint: "Instances show here once the fleet has them.",
    b0: "≤5m", b1: "≤30m", b2: "≤1h", b3: "≤2h", b4: "≤6h", b5: "≤24h", b6: ">24h", tokensUnit: "input-token equivalents",
  },
  "zh-TW": {
    title: "快取", w24h: "24 小時", w7d: "7 天", w30d: "30 天", window: "期間",
    fleetExpiry: "過期成本", fleetSaving: "保溫可省", fleetRecommended: "建議保溫", ofN: "{1} 個中的 {0} 個",
    pricesNote: "牌價查證日期：{0}。", quotaNote: "訂閱方案：Anthropic 與 OpenAI 未公布快取讀取如何計入方案額度，因此節省金額以牌價計算為準，換算成額度則是估算。",
    estimateNote: "估算：Codex 不記錄快取寫入，寫入量以該次請求未命中快取的輸入估算。",
    notPricedNote: "有些模型不在價目表中，這些 instance 以「輸入價格單位」比較。",
    scanning: "仍在讀取 transcript——還剩 {0}。重新整理可看到更多。", scanningFirst: "第一次讀取 transcript 中——重新整理可看到更多。", refresh: "重新整理",
    keepWarm: "建議保溫", leaveOff: "不需保溫", estimate: "估算", notPriced: "未定價",
    requests: "請求數", pastTtl: "超過 TTL（{0}）", expired: "已過期（重寫）", rewritten: "重寫的 token",
    expiryCost: "過期成本", share: "占其成本 {0}", pings: "保溫 ping 次數", pingsAfter: "其中 {0} 次在最後一次請求之後",
    pingCost: "ping 成本", net: "保溫後淨額", gaps: "請求間隔", ttlLine: "TTL {0}",
    quiet: "這段期間活動太少，無法判斷。",
    neverExpired: "沒有任何間隔超過 {0} 的快取時效。", survived: "有 {0} 個間隔超過 {1} TTL，但快取仍在。",
    onlyIdle: "沒有任何請求在快取過期後回來使用：每個 session 閒置後就不再使用。保溫只會送出 {0} 次沒人讀的 ping。",
    saves: "常閒置超過 {0} TTL 後又再使用：保溫可省 {1}（過期成本的 {2}）。",
    costsMore: "每次過期約需送 {0} 次 ping——保溫的花費比省下的多 {1}。",
    costsMoreUnits: "每次過期約需送 {0} 次 ping——保溫的花費比省下的多。",
    unavailable: "不提供", creditBilled: "以 credit 計費，沒有快取資料", unsupported: "這個 CLI 沒有快取資料", noData: "尚未讀到任何請求",
    shared: "與 {0} 共用工作目錄，無法分辨各自的 transcript",
    empty: "沒有 instance", emptyHint: "fleet 有 instance 後會顯示在這裡。",
    b0: "≤5分", b1: "≤30分", b2: "≤1時", b3: "≤2時", b4: "≤6時", b5: "≤24時", b6: ">24時", tokensUnit: "輸入 token 當量",
  },
});
const tc = (k, ...v) => t(`cache.${k}`, ...v);

export const CACHE_WINDOWS = ["24h", "7d", "30d"];
const EDGES = [300, 1800, 3600, 7200, 21600, 86400];

export function money(usd) {
  if (!(usd > 0)) return "$0";
  if (usd < 0.01) return "<$0.01";
  return usd >= 100 ? `$${Math.round(usd).toLocaleString("en-US")}` : `$${usd.toFixed(2)}`;
}
export function tokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}
export function bytes(n) { return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`; }
export function ttlText(sec) { return sec >= 3600 ? `${sec / 3600} h` : `${Math.round(sec / 60)} min`; }
const pct = (x) => `${x >= 0.1 ? Math.round(x * 100) : (x * 100).toFixed(1)}%`;

/** The one line under an instance's recommendation. */
export function reasonText(a) {
  const r = a.recommendation, ttl = ttlText(a.ttlSec);
  if (r.reason === "quiet") return tc("quiet");
  if (r.reason === "never_expired") {
    if (a.sim.pastTtl) return tc("survived", a.sim.pastTtl, ttl);
    return a.sim.tailPings ? tc("onlyIdle", a.sim.tailPings.toLocaleString("en-US")) : tc("neverExpired", ttl);
  }
  if (r.reason === "saves") return tc("saves", ttl, a.priced ? money(a.sim.net) : `${tokens(a.sim.net * 1e6)} ${tc("tokensUnit")}`, a.sim.expiryCost > 0 ? pct(a.sim.net / a.sim.expiryCost) : "—");
  return a.priced ? tc("costsMore", r.pingsPerExpiry ?? 0, money(-a.sim.net)) : tc("costsMoreUnits", r.pingsPerExpiry ?? 0);
}

/** Gap histogram: one bar per bucket (square-root scale: a thousand short gaps must not flatten the few long ones). */
function Histogram({ buckets, ttlSec }) {
  const W = 280, H = 84, top = 14, base = 66, slot = W / buckets.length, bw = slot - 8;
  const max = Math.max(1, ...buckets);
  const ttlAt = EDGES.indexOf(ttlSec);
  const label = `${tc("gaps")}: ${buckets.map((n, i) => `${tc(`b${i}`)} ${n}`).join(", ")}`;
  return html`<svg class="ch-hist" viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${label} preserveAspectRatio="none">
    ${buckets.map((n, i) => {
      const h = n ? Math.max(2, Math.round((base - top) * Math.sqrt(n / max))) : 0;
      const x = i * slot + 4;
      return html`<g key=${i} class=${ttlAt >= 0 && i > ttlAt ? "ch-col past" : "ch-col"}>
        <rect x=${x} y=${base - h} width=${bw} height=${h} rx="2" />
        <text class="ch-n" x=${x + bw / 2} y=${base - h - 3} text-anchor="middle">${n || ""}</text>
        <text class="ch-l" x=${x + bw / 2} y=${H - 4} text-anchor="middle">${tc(`b${i}`)}</text></g>`;
    })}
    ${ttlAt >= 0 ? html`<g class="ch-ttl"><line x1=${(ttlAt + 1) * slot} x2=${(ttlAt + 1) * slot} y1="4" y2=${base} />
      <text x=${(ttlAt + 1) * slot + 3} y="11">${tc("ttlLine", ttlText(ttlSec))}</text></g>` : null}
  </svg>`;
}

function Metric({ label, value, sub }) {
  return html`<div class="ch-metric"><dt>${label}</dt><dd>${value}${sub ? html`<span class="ch-sub">${sub}</span>` : null}</dd></div>`;
}

function InstanceCard({ r }) {
  const a = r.analysis, s = a.sim, $ = (v) => (a.priced ? money(v) : "—");
  const on = a.recommendation.on;
  return html`<article class=${`ch-card${on ? " on" : ""}`} aria-labelledby=${`ch-${r.name}`}>
    <header class="ch-head">
      <div class="ch-id"><h3 id=${`ch-${r.name}`} class="mono">${r.name}</h3>
        <span class="ch-models">${r.backend}${a.models.length ? ` · ${a.models.join(", ")}` : ""}</span></div>
      <span class=${`ch-rec${on ? " on" : ""}`}>${on ? tc("keepWarm") : tc("leaveOff")}</span>
    </header>
    <p class="ch-reason">${reasonText(a)}${a.estimate ? html` <span class="ch-tag">${tc("estimate")}</span>` : null}${a.priced ? null : html` <span class="ch-tag">${tc("notPriced")}</span>`}</p>
    <dl class="ch-metrics">
      <${Metric} label=${tc("requests")} value=${a.requests.toLocaleString("en-US")} />
      <${Metric} label=${tc("pastTtl", ttlText(a.ttlSec))} value=${s.pastTtl} />
      <${Metric} label=${tc("expired")} value=${s.expired} />
      <${Metric} label=${tc("rewritten")} value=${tokens(s.rewriteTokens)} />
      <${Metric} label=${tc("expiryCost")} value=${$(s.expiryCost)} sub=${a.share != null && a.priced && s.expiryCost > 0 ? tc("share", pct(a.share)) : null} />
      <${Metric} label=${tc("pings")} value=${(s.pings + s.tailPings).toLocaleString("en-US")} sub=${s.tailPings ? tc("pingsAfter", s.tailPings) : null} />
      <${Metric} label=${tc("pingCost")} value=${$(s.pingCost + s.tailCost)} />
      <${Metric} label=${tc("net")} value=${a.priced ? `${s.net >= 0 ? "+" : "−"}${money(Math.abs(s.net))}` : "—"} />
    </dl>
    <${Histogram} buckets=${a.gapBuckets} ttlSec=${a.ttlSec} />
  </article>`;
}

/** The tab's body. `report`: GET /ui/cache's answer; `win`/`setWin`: the window; `refresh`: read again. */
export function CacheReport({ report, win, setWin, refresh }) {
  const ok = report.instances.filter((r) => r.status === "ok")
    .sort((x, y) => (y.analysis.priced - x.analysis.priced) || (y.analysis.sim.expiryCost - x.analysis.sim.expiryCost));
  const rest = report.instances.filter((r) => r.status !== "ok");
  const f = report.fleet;
  const anyEstimate = ok.some((r) => r.analysis.estimate);
  return html`<div class="ch">
    <div class="ch-bar">
      <div class="seg-inline" role="group" aria-label=${tc("window")}>${CACHE_WINDOWS.map((w) => html`<button key=${w} type="button"
        class=${`btn btn-sm${w === win ? " btn-primary" : ""}`} aria-pressed=${w === win ? "true" : "false"} onClick=${() => setWin(w)}>${tc(`w${w}`)}</button>`)}</div>
      ${!report.scanning.caughtUp || report.scanning.pendingBytes > 0 ? html`<div class="ch-scan" role="status"><span>${report.scanning.pendingBytes > 0
        ? tc("scanning", bytes(report.scanning.pendingBytes)) : tc("scanningFirst")}</span>
        <button type="button" class="btn btn-sm" onClick=${refresh}><${Icon} name="restart" size=${14} />${tc("refresh")}</button></div>` : null}
    </div>
    ${report.instances.length ? html`<section class="ch-fleet card">
      <${Metric} label=${tc("fleetExpiry")} value=${money(f.expiryCost)} />
      <${Metric} label=${tc("fleetSaving")} value=${money(f.saving)} />
      <${Metric} label=${tc("fleetRecommended")} value=${tc("ofN", f.recommended, f.analysed)} />
    </section>` : html`<${Empty} icon="chart" title=${tc("empty")} hint=${tc("emptyHint")} />`}
    <div class="ch-notes note">
      <p>${tc("pricesNote", report.pricesChecked)} ${tc("quotaNote")}</p>
      ${anyEstimate ? html`<p>${tc("estimateNote")}</p>` : null}
      ${f.priced ? null : html`<p>${tc("notPricedNote")}</p>`}
    </div>
    <div class="ch-cards">${ok.map((r) => html`<${InstanceCard} key=${r.name} r=${r} />`)}</div>
    ${rest.length ? html`<ul class="rows ch-rest">${rest.map((r) => html`<li key=${r.name} class="row-item">
      <span class="grow strong mono">${r.name}</span><span class="muted">${r.backend} · ${r.status === "no_data" ? tc("noData")
        : `${tc("unavailable")} (${r.status === "credit_billed" ? tc("creditBilled") : r.status === "shared" ? tc("shared", (r.with || []).join(", ")) : tc("unsupported")})`}</span></li>`)}</ul>` : null}
  </div>`;
}
