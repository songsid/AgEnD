// Lazy B/C seam. New words stay here so a cached Hub dictionary can load this module after an upgrade.
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { hubClient } from "./hub-client.js";

if (typeof document !== "undefined" && !document.querySelector('link[data-hub-quota]')) {
  const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "/assets/hub-quota.css";
  css.setAttribute("data-hub-quota", ""); document.head.appendChild(css);
}

register("hubQuota", {
  en: {
    title: "Subscription quota", status: "Availability", available: "Available", near_limit: "Near limit", exhausted: "Exhausted", unknown: "Unknown",
    back: "Exhausted, back about {0}", queue: "Questions will queue until the agent can answer again.",
    coarse: "Only a broad availability band is shared.", visibility: "Show quota to people asking", visibilityHint: "Share this agent's availability band. Exact usage stays in your fleet.",
    failed: "Could not save. Try again.", conflict: "This agent changed. Reload before saving.",
  },
  "zh-TW": {
    title: "訂閱額度", status: "可用狀態", available: "充足", near_limit: "快用完", exhausted: "用完", unknown: "未知",
    back: "用完，約 {0} 恢復", queue: "問題會排隊等候，待 Agent 可以回答時再處理。",
    coarse: "只分享概略的可用狀態。", visibility: "向提問者顯示額度", visibilityHint: "分享這個 Agent 的可用狀態。確切用量留在你的 Fleet。",
    failed: "未能儲存，請再試一次。", conflict: "Agent 已變更，請重新載入後再儲存。",
  },
});
const word = (key, ...args) => t(`hubQuota.${key}`, ...args);
const bands = new Set(["available", "near_limit", "exhausted", "unknown"]);
function quotaOf(room) { return room && room.quota && bands.has(room.quota.band) ? room.quota : null; }
const statusClass = band => band === "available" ? "ok" : band === "near_limit" ? "warn" : band === "exhausted" ? "crit" : "";
export function quotaLabel(quota) {
  if (!quota || !bands.has(quota.band)) return word("unknown");
  const at = quota.resetsAt;
  if (quota.band === "exhausted" && Number.isSafeInteger(at) && at > 0 && at <= 8.64e15 && at % 300_000 === 0) {
    const date = new Date(at);
    const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    return word("back", clock);
  }
  return word(quota.band);
}
export function QuotaCard({ room }) {
  const quota = quotaOf(room);
  if (!quota) return null;
  return html`<section class="u-provider hub-quota-card" aria-label=${word("title")}>
    <div class="u-head"><strong>${word("title")}</strong></div>
    <div class="u-metric"><div class="u-row"><span class="u-label">${word("status")}</span>
      <span class=${`u-status ${statusClass(quota.band)}`} role="status">${quotaLabel(quota)}</span></div>
      <div class="u-sub">${word("coarse")}</div></div>
  </section>`;
}
export function QuotaChip({ room }) {
  const quota = quotaOf(room);
  if (!quota || quota.band === "available") return null;
  return html`<span class=${`tag u-status hub-quota-chip ${statusClass(quota.band)}`} role="status">${quotaLabel(quota)}</span>`;
}
export function QuotaBanner({ room }) {
  const quota = quotaOf(room);
  if (!quota || quota.band !== "exhausted") return null;
  return html`<div class="msg status-line hub-quota-banner" role="status"><div class="body"><div class="st-text">
    ${quotaLabel(quota)} · ${word("queue")}
  </div></div></div>`;
}
export function QuotaVisibilityRow({ exposure, onSaved }) {
  const [visible, setVisible] = useState(exposure.quotaVisible !== false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  useEffect(() => { setVisible(exposure.quotaVisible !== false); setError(null); }, [exposure.id, exposure.revision, exposure.quotaVisible]);
  const save = async e => {
    if (busy) return;
    const next = e.target.checked;
    const previous = visible;
    setVisible(next); setBusy(true); setError(null);
    let result;
    try {
      const client = hubClient();
      result = typeof client.quotaVisibility === "function" ? await client.quotaVisibility(exposure.id, exposure.revision, next) : { ok: false };
    } catch { result = { ok: false }; }
    setBusy(false);
    if (!result.ok) { setVisible(previous); setError(word(result.code === "conflict" ? "conflict" : "failed")); return; }
    setVisible(result.quotaVisible);
    if (onSaved) onSaved(result);
  };
  return html`<section class="s-sec hub-quota-visibility"><h3>${word("title")}</h3>
    <label class="hub-quota-setting"><span><strong>${word("visibility")}</strong><span class="note">${word("visibilityHint")}</span></span>
      <input class="s-ui-toggle" type="checkbox" role="switch" aria-label=${word("visibility")} checked=${visible} disabled=${busy} onChange=${save} /></label>
    ${error ? html`<p class="err" role="alert">${error}</p>` : null}
  </section>`;
}
