// M-3814 (the user, 2026-11-26): Settings → Access → the fixed address's preview address. Over a fixed link, HTML
// previews used to open a temporary Cloudflare address each time, which Cloudflare sometimes limits (429). With
// `web.public_link.preview_hostname` they use a second published route on the same tunnel, to the preview port; the
// one manual step is that route (Cloudflare adds its DNS record itself). **Check** proves the saved address reaches
// this AgEnD's previews through the open fixed link; it starts nothing. The server answers closed step codes only.
import { html, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { api } from "./settings-confirm.js";

register("settings", {
  en: {
    previewHostname: "Preview address (optional)",
    previewHostNeedsHostname: "A preview address needs the fixed public hostname above.",
    previewHostSame: "Use a different name from the fixed hostname: a preview on the dashboard's own name could use its sign-in.",
    pvaLead: "HTML previews over the fixed address use a second address on the same tunnel. Without one, AgEnD opens a temporary Cloudflare address for previews, and Cloudflare sometimes limits those.",
    pvaStepsTitle: "Set it up once in Cloudflare",
    pvaStep1: "Open this tunnel's Routes tab → Add route → Published application.",
    pvaStep2: "Hostname: {0}",
    pvaStep2Any: "Hostname: a name such as {0}",
    pvaStep3: "Service URL: http://127.0.0.1:{0} (the preview port; not the origin port above).",
    pvaStep4: "Save the route. Cloudflare adds the DNS record by itself.",
    pvaStep5: "Fill in the address here, save, then press Check with the fixed link open.",
    pvaCheck: "Check preview address",
    pvaChecking: "Checking… (up to about a minute)",
    pvaSaveFirst: "Save first: Check uses the saved address.",
    pvaBusy: "A check is already running. Try again when it ends.",
    pvaFailed: "The check could not run. Try again.",
    pvaNotRun: "Not checked (an earlier step failed).",
    pvaStep_values: "The preview address",
    pvaStep_link: "The fixed link is open",
    pvaStep_dns: "{0} can be looked up",
    pvaStep_reach: "{0} reaches this AgEnD's previews",
    pva_values_ok: "Saved.",
    "pva_values_not-set": "No preview address is saved.",
    pva_link_ok: "Open.",
    "pva_link_link-closed": "Open the fixed link (/web), then check again: the preview address only answers while the link is open.",
    "pva_link_no-listener": "Previews are off or not running on this AgEnD.",
    pva_dns_ok: "Found.",
    "pva_dns_dns-missing": "{0} does not exist yet. Add the Published application route for {0} on this tunnel (step 1).",
    "pva_dns_dns-failed": "This machine could not look up {0}: this machine's network may block DNS. Ask the network administrator.",
    pva_reach_ok: "It works: previews over the fixed address use {0}.",
    "pva_reach_wrong-service": "Cloudflare answered but could not reach the service: make the route's service http://127.0.0.1:{1} (HTTP, not HTTPS).",
    "pva_reach_other-page": "{0} answered with another page: point its route to this tunnel, with the service http://127.0.0.1:{1}.",
    "pva_reach_route-missing": "{0} is not routed to this tunnel. Add the Published application route for {0} (step 1).",
    "pva_reach_self-unreachable": "The tunnel is connected, but this machine's network can't open {0} (some networks filter new domains). From another network, such as a phone on mobile data, it may still work.",
    "pva_reach_reach-failed": "{0} did not answer as expected. Check again in a minute; if it repeats, check the route in Cloudflare.",
    pvaTimeout: "The check took too long and was stopped. Check again; if it repeats, check this machine's network.",
  },
  "zh-TW": {
    previewHostname: "預覽網址（選用）",
    previewHostNeedsHostname: "預覽網址需要先填上方的固定公開網域。",
    previewHostSame: "請用和固定網域不同的名稱：預覽若用儀表板自己的網域，可能用到它的登入。",
    pvaLead: "透過固定網址看 HTML 預覽時，會用同一條通道上的第二個網址。沒有設定的話，AgEnD 會為預覽開一個 Cloudflare 臨時網址，而 Cloudflare 有時會限制這類網址。",
    pvaStepsTitle: "在 Cloudflare 設定一次",
    pvaStep1: "打開這條通道的 Routes 分頁 → Add route → Published application。",
    pvaStep2: "Hostname：{0}",
    pvaStep2Any: "Hostname：例如 {0}",
    pvaStep3: "Service URL：http://127.0.0.1:{0}（預覽用的連接埠，不是上方的本機連接埠）。",
    pvaStep4: "儲存路由。Cloudflare 會自動新增 DNS 記錄。",
    pvaStep5: "在這裡填上網址並儲存，再於固定連結開著時按「檢查」。",
    pvaCheck: "檢查預覽網址",
    pvaChecking: "檢查中…（最多約 1 分鐘）",
    pvaSaveFirst: "請先儲存：檢查用的是已儲存的網址。",
    pvaBusy: "已經有一個檢查在進行，請等它結束再試。",
    pvaFailed: "檢查沒有執行成功，請再試一次。",
    pvaNotRun: "未檢查（前面的步驟失敗）。",
    pvaStep_values: "預覽網址",
    pvaStep_link: "固定連結已開啟",
    pvaStep_dns: "查得到 {0}",
    pvaStep_reach: "{0} 連得到這台 AgEnD 的預覽",
    pva_values_ok: "已儲存。",
    "pva_values_not-set": "還沒有儲存預覽網址。",
    pva_link_ok: "已開啟。",
    "pva_link_link-closed": "請先開啟固定連結（/web）再檢查：預覽網址只在連結開著時回應。",
    "pva_link_no-listener": "這台 AgEnD 的預覽已關閉或沒有在執行。",
    pva_dns_ok: "查得到。",
    "pva_dns_dns-missing": "{0} 還不存在。請在這條通道新增 {0} 的 Published application 路由（第 1 步）。",
    "pva_dns_dns-failed": "這台主機查不到 {0}：這台主機所在的網路可能擋了 DNS。請洽網路管理員。",
    pva_reach_ok: "正常：透過固定網址的預覽會使用 {0}。",
    "pva_reach_wrong-service": "Cloudflare 有回應，但連不到服務：請把路由的 service 設成 http://127.0.0.1:{1}（HTTP，不是 HTTPS）。",
    "pva_reach_other-page": "{0} 回應了別的頁面：請把它的路由指向這條通道，service 設成 http://127.0.0.1:{1}。",
    "pva_reach_route-missing": "{0} 沒有路由到這條通道。請新增 {0} 的 Published application 路由（第 1 步）。",
    "pva_reach_self-unreachable": "通道已連上，但這台主機所在的網路打不開 {0}（有些網路會擋新的網域）。從其他網路（例如手機行動網路）可能可以正常使用。",
    "pva_reach_reach-failed": "{0} 沒有如預期回應。請過一分鐘再檢查；如果一直這樣，請檢查 Cloudflare 上的路由。",
    pvaTimeout: "檢查太久，已經停止。請再檢查一次；如果一直這樣，請檢查這台主機所在的網路。",
  },
});
const tn = (k, ...v) => t(`settings.${k}`, ...v);
const STEPS = ["values", "link", "dns", "reach"];

/** A hostname as the server reads it: no https://, no trailing slash, lower case. */
export function bareHost(value) {
  return String(value ?? "").trim().replace(/^https:\/\//i, "").replace(/\/$/, "").toLowerCase();
}
/** What the field suggests: preview.<the fixed hostname>. */
export function previewHostPlaceholder(hostname) {
  const host = bareHost(hostname);
  return host ? `preview.${host}` : "preview.agend.example.com";
}
/** The preview listener's port, as the fleet resolves it (web-preview.ts previewSettings): preview_port, else web port + 1. */
export function previewPortOf(fleet) {
  const set = fleet && fleet.web && fleet.web.preview_port;
  if (Number.isInteger(set) && set > 0) return set;
  const hp = Number.isInteger(fleet && fleet.health_port) ? fleet.health_port : 19280;
  return hp > 0 && hp + 1 <= 65535 ? hp + 1 : null;
}

/** The field, the one route step, and Check (on the saved address). */
export function FixedPreviewAddress({ field, hostname, saved, port }) {
  const lease = useLease("fixed-preview-check");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [note, setNote] = useState("");
  const running = useRef(false);
  const host = bareHost(hostname);
  const run = async () => {
    if (running.current) return;
    if (!saved) { setResult(null); setNote(tn("pvaSaveFirst")); return; }
    running.current = true; setBusy(true); setNote(""); setResult(null);
    try {
      const r = await api("/api/settings/public-link/preview-test", { method: "POST", body: "{}" });
      if (!lease.current()) return;
      if (r.status === 409) setNote(tn("pvaBusy"));
      else if (!r.ok || !Array.isArray(r.body?.steps)) setNote(tn("pvaFailed"));
      else setResult(r.body);
    } catch { if (lease.current()) setNote(tn("pvaFailed")); }
    finally { running.current = false; if (lease.current()) setBusy(false); }
  };
  const shown = result?.hostname || host || "—", shownPort = result?.port ?? port ?? "—";
  return html`<div class="fixed-preview" id="publicPreviewAddress">
    ${field}
    <p class="note">${tn("pvaLead")}</p>
    <details class="fixed-preview-steps" open=${!saved}>
      <summary>${tn("pvaStepsTitle")}</summary>
      <ol>
        <li>${tn("pvaStep1")}</li>
        <li>${host ? tn("pvaStep2", host) : tn("pvaStep2Any", "preview.agend.example.com")}</li>
        <li>${tn("pvaStep3", port ?? "—")}</li>
        <li>${tn("pvaStep4")}</li>
        <li>${tn("pvaStep5")}</li>
      </ol>
    </details>
    <div class="save-row"><button type="button" class="btn btn-sm" id="previewAddressCheck" disabled=${busy || !host} onClick=${run}>${busy ? tn("pvaChecking") : tn("pvaCheck")}</button></div>
    ${note ? html`<p class="note" role="status">${note}</p>` : null}
    ${result ? html`<ol class="named-test-steps" role="status" aria-live="polite">${STEPS.map((step) => {
      const r = result.steps.find((s) => s.step === step);
      const mark = !r ? "–" : r.ok ? "✓" : "✗";
      const said = !r ? tn("pvaNotRun") : r.code === "timeout" ? tn("pvaTimeout") : tn(`pva_${step}_${r.code}`, shown, shownPort);
      return html`<li key=${step} class=${!r ? "nt-skip" : r.ok ? "nt-ok" : "nt-fail"} data-step=${step} data-code=${r ? r.code : ""}>
        <span class="nt-mark" aria-hidden="true">${mark}</span> <strong>${tn(`pvaStep_${step}`, shown, shownPort)}</strong> — ${said}</li>`;
    })}</ol>` : null}
  </div>`;
}
