// #2906 (the user, 2026-11-01): Settings → Access → the fixed address's 「測試連線」 / "Test connection". It tests the
// values as filled in (unsaved too: the typed connector token, else the saved one) and shows each step ✓ or ✗; every ✗
// says what the person can do next. The server answers closed step codes only (settings-api.ts, named-link-test.ts):
// the token never comes back. Words never name the person's workplace — "this machine's network", "network administrator".
import { html, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { api } from "./settings-confirm.js";

register("settings", {
  en: {
    ntButton: "Test connection",
    ntRunning: "Testing… (up to about a minute)",
    ntHint: "Tests the values above as filled in, saved or not — with the token typed below, or the saved one.",
    ntBusy: "A test is already running. Try again when it ends.",
    ntFailed: "The test could not run. Try again.",
    ntNotRun: "Not tested (an earlier step failed).",
    ntStep_values: "The domain, port and token",
    ntStep_origin: "This machine answers on port {1}",
    ntStep_tunnel: "The tunnel connects to Cloudflare",
    ntStep_dns: "{0} can be looked up",
    ntStep_reach: "{0} reaches this AgEnD",
    nt_values_ok: "Filled in correctly.",
    "nt_values_bad-hostname": "Enter a domain such as agend.example.com (no https://, path or port).",
    "nt_values_bad-port": "Enter a port from 1024 to 65535.",
    "nt_values_no-token": "No connector token: paste it below (Cloudflare → your tunnel → the long string that starts with eyJ).",
    "nt_values_bad-token": "This is not a connector token: copy only the long string that starts with eyJ.",
    nt_origin_ok: "Answered for this test.",
    nt_origin_live: "Your link is open on these values: it is tested as it is.",
    "nt_origin_dashboard-port": "{1} is the dashboard's own port. Choose another (19282 by default), and make the Cloudflare route's service http://127.0.0.1:<that port>.",
    "nt_origin_port-in-use": "Port {1} is used by another program on this machine. Choose another port here, and make the Cloudflare route's service http://127.0.0.1:<that port>.",
    "nt_origin_origin-failed": "AgEnD could not listen on port {1}. Try another port.",
    "nt_origin_link-open-other": "Your link is open with other settings. Close it (/web → Close public link), then test again.",
    "nt_origin_tunnel-busy": "Another tunnel is starting or running (a public link or a sign-in). Try again in a minute.",
    nt_tunnel_ok: "Connected to Cloudflare.",
    nt_tunnel_live: "Your open link is connected.",
    nt_tunnel_auth: "Cloudflare refused the token: it is wrong or was rotated. Copy the current token from the tunnel's page in Cloudflare and paste it again.",
    nt_tunnel_network: "This machine could not reach Cloudflare within 20 seconds. Set the protocol to http2 here, or ask the network administrator to allow outbound connections to Cloudflare (port 7844).",
    nt_tunnel_stopped: "cloudflared stopped before it connected. Test again; if it repeats, check the token and the protocol.",
    "nt_tunnel_no-binary": "cloudflared could not be prepared on this machine (its download or install failed). Check this machine's internet access and test again.",
    nt_dns_ok: "Found.",
    "nt_dns_dns-missing": "{0} does not exist yet. In Cloudflare, add a Published application route for {0} on this tunnel.",
    "nt_dns_dns-failed": "This machine could not look up {0}: this machine's network may block DNS. Ask the network administrator.",
    nt_reach_ok: "It works: {0} reached this AgEnD.",
    "nt_reach_wrong-service": "Cloudflare answered but could not reach the service: make the route's service http://127.0.0.1:{1} (HTTP, not HTTPS).",
    "nt_reach_other-page": "{0} answered with another page: its route points to another service or tunnel. Point it to this tunnel, with the service http://127.0.0.1:{1}.",
    "nt_reach_route-missing": "{0} is not routed to this tunnel. In Cloudflare, add a Published application route for {0}.",
    "nt_reach_self-unreachable": "The tunnel is connected, but this machine's network can't open {0} (some networks filter new domains). From another network, such as a phone on mobile data, it may still work. Ask the network administrator to allow {0}.",
    "nt_reach_reach-failed": "{0} did not answer as expected. Test again in a minute; if it repeats, check the route in Cloudflare.",
  },
  "zh-TW": {
    ntButton: "測試連線",
    ntRunning: "測試中…（最多約 1 分鐘）",
    ntHint: "用上面填的設定測試（不論是否已儲存），token 用下方輸入的，沒有就用已儲存的。",
    ntBusy: "已經有一個測試在進行，請等它結束再試。",
    ntFailed: "測試沒有執行成功，請再試一次。",
    ntNotRun: "未測試（前面的步驟失敗）。",
    ntStep_values: "網域、port 與 token",
    ntStep_origin: "這台主機在 port {1} 回應",
    ntStep_tunnel: "tunnel 連上 Cloudflare",
    ntStep_dns: "查得到 {0}",
    ntStep_reach: "{0} 連得到這台 AgEnD",
    nt_values_ok: "填寫正確。",
    "nt_values_bad-hostname": "請填網域，例如 agend.example.com（不含 https://、路徑或 port）。",
    "nt_values_bad-port": "請填 1024–65535 之間的 port。",
    "nt_values_no-token": "沒有 connector token：請貼在下方（Cloudflare → 你的 tunnel → 以 eyJ 開頭的長字串）。",
    "nt_values_bad-token": "這不是 connector token：只複製以 eyJ 開頭的那串長字串。",
    nt_origin_ok: "這次測試有回應。",
    nt_origin_live: "你的連結正以這些設定開著：直接測試它。",
    "nt_origin_dashboard-port": "{1} 是儀表板自己的 port。請換一個（預設 19282），並把 Cloudflare 路由的 service 設成 http://127.0.0.1:<那個 port>。",
    "nt_origin_port-in-use": "這台主機上有其他程式在用 port {1}。請在這裡換一個 port，並把 Cloudflare 路由的 service 改成 http://127.0.0.1:<那個 port>。",
    "nt_origin_origin-failed": "AgEnD 無法在 port {1} 監聽，請換一個 port。",
    "nt_origin_link-open-other": "你的連結正以其他設定開著。請先關閉（/web → 關閉公開連結），再測試。",
    "nt_origin_tunnel-busy": "另一條 tunnel 正在啟動或執行（公開連結或登入用）。請過一分鐘再試。",
    nt_tunnel_ok: "已連上 Cloudflare。",
    nt_tunnel_live: "開著的連結已連線。",
    nt_tunnel_auth: "Cloudflare 拒絕這個 token：它是錯的或已被更換。請到 Cloudflare 的 tunnel 頁面複製目前的 token 再貼上。",
    nt_tunnel_network: "這台主機在 20 秒內連不上 Cloudflare。請在這裡把通訊協定改成 http2，或請網路管理員允許對 Cloudflare 的對外連線（port 7844）。",
    nt_tunnel_stopped: "cloudflared 在連上之前就停止了。請再測一次；如果一直這樣，請檢查 token 與通訊協定。",
    "nt_tunnel_no-binary": "這台主機無法準備 cloudflared（下載或安裝失敗）。請確認這台主機能連上網路後再測。",
    nt_dns_ok: "查得到。",
    "nt_dns_dns-missing": "{0} 還不存在。請在 Cloudflare 為這條 tunnel 新增 {0} 的 Published application 路由。",
    "nt_dns_dns-failed": "這台主機查不到 {0}：這台主機所在的網路可能擋了 DNS。請洽網路管理員。",
    nt_reach_ok: "正常：{0} 連到了這台 AgEnD。",
    "nt_reach_wrong-service": "Cloudflare 有回應，但連不到服務：請把路由的 service 設成 http://127.0.0.1:{1}（HTTP，不是 HTTPS）。",
    "nt_reach_other-page": "{0} 回應了別的頁面：它的路由指向別的服務或 tunnel。請把它指向這條 tunnel，service 設成 http://127.0.0.1:{1}。",
    "nt_reach_route-missing": "{0} 沒有路由到這條 tunnel。請在 Cloudflare 新增 {0} 的 Published application 路由。",
    "nt_reach_self-unreachable": "tunnel 已連上，但這台主機所在的網路打不開 {0}（有些網路會擋新的網域）。從其他網路（例如手機行動網路）可能可以正常使用。請網路管理員允許 {0}。",
    "nt_reach_reach-failed": "{0} 沒有如預期回應。請過一分鐘再測；如果一直這樣，請檢查 Cloudflare 上的路由。",
  },
});
const tn = (k, ...v) => t(`settings.${k}`, ...v);
const STEPS = ["values", "origin", "tunnel", "dns", "reach"];

/** The connector token typed in the token card below (not yet saved): the test uses it when there is one. */
let typedToken = "";
export function setTypedTunnelToken(value) { typedToken = typeof value === "string" ? value : ""; }

/** The button and its result, for the fixed-address values the form holds now. */
export function NamedLinkTest({ hostname, port, protocol }) {
  const lease = useLease("named-link-test");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [note, setNote] = useState("");
  const running = useRef(false);
  const run = async () => {
    if (running.current) return;
    running.current = true; setBusy(true); setNote(""); setResult(null);
    try {
      const r = await api("/api/settings/public-link/test", { method: "POST", body: JSON.stringify({
        hostname: String(hostname ?? "").trim(), origin_port: String(port ?? "").trim() || "19282", protocol, ...(typedToken.trim() ? { token: typedToken } : {}),
      }) });
      if (!lease.current()) return;
      if (r.status === 409) setNote(tn("ntBusy"));
      else if (!r.ok || !Array.isArray(r.body?.steps)) setNote(tn("ntFailed"));
      else setResult(r.body);
    } catch { if (lease.current()) setNote(tn("ntFailed")); }
    finally { running.current = false; if (lease.current()) setBusy(false); }
  };
  const host = result?.hostname || String(hostname ?? "").trim() || "—", shownPort = result?.port ?? (String(port ?? "").trim() || "19282");
  return html`<div class="named-test">
    <div class="save-row"><button type="button" class="btn btn-sm" id="namedLinkTest" disabled=${busy} onClick=${run}>${busy ? tn("ntRunning") : tn("ntButton")}</button></div>
    <p class="note">${tn("ntHint")}</p>
    ${note ? html`<p class="note" role="status">${note}</p>` : null}
    ${result ? html`<ol class="named-test-steps" role="status" aria-live="polite">${STEPS.map((step) => {
      const r = result.steps.find((s) => s.step === step);
      const mark = !r ? "–" : r.ok ? "✓" : "✗";
      const said = !r ? tn("ntNotRun") : tn(`nt_${step}_${r.code}`, host, shownPort);
      return html`<li key=${step} class=${!r ? "nt-skip" : r.ok ? "nt-ok" : "nt-fail"} data-step=${step} data-code=${r ? r.code : ""}>
        <span class="nt-mark" aria-hidden="true">${mark}</span> <strong>${tn(`ntStep_${step}`, host, shownPort)}</strong> — ${said}</li>`;
    })}</ol>` : null}
  </div>`;
}
