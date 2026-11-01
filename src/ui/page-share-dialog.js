// #2911 item 8: page share links on the dashboard. The preview panel's Share page action — a confirm dialog every time
// (what is shared, that it runs the page's own scripts, for how long), then the link shown once to copy — and, while that
// page is shared, "Shared until …" with Stop sharing; Settings → Access & security lists the open ones with Stop and
// Stop all. Design: #2911 issuecomment-6561078095 (approved).
// GET / POST /ui/page-share, DELETE /ui/page-share/<id|all> (web-api.ts): an admin session (directly or over the public
// link). The server reads the page itself from the chat history: the page only names the block.
import { html, useEffect, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { toast } from "/assets/ui-toast.js";

register("pshare", {
  en: {
    share: "Share page", shareTitle: "Make a link anyone can open to see this page, for a limited time",
    shared: "Shared until {0}", sharedTitle: "This page is shared: see or stop it",
    title: "Share this page", what: "Anyone with the link can open “{0}” from {1}'s reply ({2}).",
    runs: "It runs the page's own scripts in their browser, apart from this dashboard. They see the page only — not the chat, the agent or the fleet.",
    snapshot: "The link shows the page as it is now; a later version needs a new link. The chat is told when it starts and ends.",
    how: "For", create: "Share", creating: "Starting the link…", cancel: "Cancel", close: "Close",
    made: "Anyone with this link can open the page until {0}. It is shown only now: copy it.", copy: "Copy link", copied: "Link copied",
    stop: "Stop sharing", stopAll: "Stop all", stopping: "Stopping…", stopped: "The page is no longer shared.", untitled: "this page",
    nowShared: "Shared until {0}. Stop sharing ends the link at once.",
    m15: "15 minutes", h1: "1 hour", h8: "8 hours", h24: "24 hours",
    e_disabled: "Page share links are off on this fleet (web.page_share.enabled: false).",
    e_duration: "That is longer than this fleet allows (web.page_share.max_hours).", e_too_many: "At most 10 pages can be shared at once: stop one first.",
    e_too_large: "This page is too large to share (over 8 MB): download it instead.", e_page_gone: "This page is no longer in the chat's history.",
    e_message_gone: "This page is no longer in the chat's history.", e_not_an_agent_page: "Only a page an agent sent can be shared.",
    e_rate: "Cloudflare is limiting new quick tunnels right now. Try again in a few minutes.", e_tunnel: "The share link's tunnel did not start ({0}). Try again later.",
    failed: "The link could not be made.",
    cardTitle: "Shared pages", cardHint: "Links to single agent pages, made from the HTML preview panel's Share page. Each ends at its time; stop one to end it now.",
    none: "No pages are shared.", from: "from {0}", ends: "until {0}",
  },
  "zh-TW": {
    share: "分享頁面", shareTitle: "建立一個連結，讓任何人在限定時間內開啟這個頁面",
    shared: "分享到 {0}", sharedTitle: "這個頁面正在分享：查看或停止",
    title: "分享這個頁面", what: "拿到連結的人都能開啟 {1} 回覆裡的「{0}」（{2}）。",
    runs: "頁面本身的腳本會在對方的瀏覽器執行，與這個儀表板分開。對方只看得到這個頁面——看不到對話、agent 或 fleet。",
    snapshot: "連結顯示的是頁面現在的樣子；之後的新版本需要新的連結。開始與結束分享時會告知這個對話。",
    how: "時間", create: "分享", creating: "正在啟動連結…", cancel: "取消", close: "關閉",
    made: "拿到這個連結的人可以開啟頁面到 {0}。連結只會顯示這一次：請複製。", copy: "複製連結", copied: "已複製連結",
    stop: "停止分享", stopAll: "全部停止", stopping: "正在停止…", stopped: "這個頁面已停止分享。", untitled: "這個頁面",
    nowShared: "分享到 {0}。按「停止分享」會立即結束連結。",
    m15: "15 分鐘", h1: "1 小時", h8: "8 小時", h24: "24 小時",
    e_disabled: "這個 fleet 已關閉頁面分享連結（web.page_share.enabled: false）。",
    e_duration: "超過這個 fleet 允許的時間（web.page_share.max_hours）。", e_too_many: "同時最多分享 10 個頁面：先停止一個。",
    e_too_large: "這個頁面太大（超過 8 MB），無法分享：請改用下載。", e_page_gone: "對話紀錄裡已經沒有這個頁面。",
    e_message_gone: "對話紀錄裡已經沒有這個頁面。", e_not_an_agent_page: "只能分享 agent 傳來的頁面。",
    e_rate: "Cloudflare 目前限制新的臨時通道，請過幾分鐘再試。", e_tunnel: "分享連結的通道沒有啟動（{0}），請稍後再試。",
    failed: "無法建立連結。",
    cardTitle: "分享中的頁面", cardHint: "單一 agent 頁面的連結，可在 HTML 預覽面板的「分享頁面」建立。每個連結到時間就結束；停止可立即結束。",
    none: "目前沒有分享中的頁面。", from: "來自 {0}", ends: "到 {0} 為止",
  },
});
const tp = (k, ...v) => t(`pshare.${k}`, ...v);
export const DURATIONS = [["m15", 15], ["h1", 60], ["h8", 480], ["h24", 1440]];
const JSON_HEADERS = { "Content-Type": "application/json" };
const when = (ms) => { try { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms)); } catch { return ""; } };
/** The end of a share for the bar: the time today, with the day when it is not today (a share may last 24 h). */
const until = (ms) => { const d = new Date(ms), now = new Date(); return d.toDateString() === now.toDateString() ? when(ms) : whenLong(ms); };
const whenLong = (ms) => { try { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms)); } catch { return ""; } };

/** What a refusal says (the host's `error` and `reason`). */
export function refusalText(d) {
  const e = d && d.error;
  if (e === "tunnel") return d.reason === "rate-limited" ? tp("e_rate") : tp("e_tunnel", d.reason || "unknown");
  return ["disabled", "duration", "too_many", "too_large", "page_gone", "message_gone", "not_an_agent_page"].includes(e) ? tp(`e_${e}`) : tp("failed");
}

// ── The open page shares, one read for the page (an admin's; anyone else gets null) ──
let state = { loaded: false, canShare: false, enabled: false, shares: [] };
const subs = new Set();
let reading = null, expiry = null;
function set(next) { state = next; for (const fn of [...subs]) { try { fn(state); } catch { /* one listener's error stops no other */ } } }
/** Read the open shares again (after a change; at the soonest end). `get`: fetch. */
export function refreshPageShares(get = globalThis.fetch) {
  if (reading) return reading;
  reading = (async () => {
    const auth = globalThis.AgendAuth;
    const admin = !!(auth && typeof auth.canWrite === "function" && (await Promise.resolve(auth.canWrite()).catch(() => false)) === true);
    let d = null;
    if (admin) { try { const r = await get("/ui/page-share", { method: "GET", headers: JSON_HEADERS }); d = r.ok ? await r.json() : null; } catch { d = null; } }
    const shares = d && Array.isArray(d.shares) ? d.shares : [];
    set({ loaded: true, canShare: admin && !!d && d.enabled !== false, enabled: !!d && d.enabled !== false, shares });
    // Read again when the soonest one ends, so its "Shared until" goes without a reload.
    if (expiry) clearTimeout(expiry);
    const soonest = Math.min(...shares.map((s) => s.expiresAt));
    if (Number.isFinite(soonest)) expiry = setTimeout(() => { expiry = null; refreshPageShares(get); }, Math.max(1000, soonest - Date.now() + 1000));
  })().finally(() => { reading = null; });
  return reading;
}
export const pageShares = () => state;
/** The open shares, read once per page and on every change. */
export function usePageShares(get) {
  const [st, setSt] = useState(state);
  useEffect(() => { subs.add(setSt); if (!state.loaded) refreshPageShares(get); return () => { subs.delete(setSt); }; }, []);
  return st;
}
/** The open share of a block `from` ({ boot, id, fence | att }) in `instance`, or null. */
export function shareOf(shares, instance, from) {
  if (!from) return null;
  return shares.find((s) => s.instance === instance && s.from && s.from.boot === from.boot && s.from.id === from.id
    && (from.att ? s.from.att === from.att : s.from.fence === from.fence)) || null;
}

async function stopShare(id, get = globalThis.fetch) {
  try { await get(`/ui/page-share/${id}`, { method: "DELETE", headers: JSON_HEADERS }); } catch { /* the list is read again */ }
  await refreshPageShares(get);
}

/**
 * The confirm dialog: what is shared (its title, whose reply, when), that it runs the page's own scripts, for how long;
 * Share makes the link and shows it once. With `share` (this page is already shared): when it ends, and Stop sharing.
 * `block`: { instance, from: {boot, id, fence | att}, title, sender, ts }.
 */
export function PageShareDialog({ block, share = null, get = globalThis.fetch, onClose }) {
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);
  const [error, setError] = useState("");
  const create = async () => {
    setBusy(true); setError("");
    try {
      const r = await get("/ui/page-share", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ instance: block.instance, boot: block.from.boot, id: block.from.id,
        ...(block.from.att ? { att: block.from.att } : { fence: block.from.fence }), minutes }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d && typeof d.url === "string") setMade(d); else setError(refusalText(d));
    } catch { setError(tp("failed")); }
    setBusy(false);
    refreshPageShares(get);
  };
  const stop = async (id) => { setBusy(true); await stopShare(id, get); setBusy(false); toast(tp("stopped")); onClose(); };
  const copy = async () => { try { await navigator.clipboard.writeText(made.url); toast(tp("copied")); } catch { /* the link is on screen to copy by hand */ } };
  const open = made ? made.share : share;
  const name = block.title || tp("untitled");
  const actions = made || share
    ? html`<button type="button" class="btn danger ps-stop" disabled=${busy} onClick=${() => stop(open.id)}>${busy ? tp("stopping") : tp("stop")}</button>
      <button type="button" class="btn" onClick=${onClose} disabled=${busy}>${tp("close")}</button>`
    : html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${tp("cancel")}</button>
      <button type="button" class="btn btn-primary ps-create" onClick=${create} disabled=${busy}>${busy ? tp("creating") : tp("create")}</button>`;
  return html`<${Dialog} title=${tp("title")} onClose=${onClose} busy=${busy} actions=${actions}>
    <div class="os ps">
      <p class="ps-what">${tp("what", name, block.sender || block.instance, whenLong(block.ts ? Date.parse(block.ts) : Date.now()))}</p>
      <p class="ps-runs"><strong>${tp("runs")}</strong></p>
      ${made ? html`<div class="os-made">
          <input class="input mono os-url ps-url" readonly value=${made.url} aria-label=${tp("copy")} onFocus=${(e) => e.target.select && e.target.select()} />
          <button type="button" class="btn btn-sm ps-copy" onClick=${copy}>${tp("copy")}</button>
          <p class="note">${tp("made", whenLong(made.share.expiresAt))}</p>
        </div>`
        : share ? html`<p class="note ps-now">${tp("nowShared", whenLong(share.expiresAt))}</p>`
        : html`<p class="muted">${tp("snapshot")}</p>
          <label class="field"><span>${tp("how")}</span>
            <select class="tb-select ps-how" value=${String(minutes)} onChange=${(e) => setMinutes(Number(e.target.value))} disabled=${busy}>
              ${DURATIONS.map(([k, m]) => html`<option key=${k} value=${String(m)}>${tp(k)}</option>`)}
            </select></label>`}
      ${error ? html`<p class="err os-err ps-err" role="alert">${error}</p>` : null}
    </div>
  <//>`;
}

/** Settings → Access & security: the shared pages, with Stop and Stop all. */
export function PageSharesCard({ get = globalThis.fetch }) {
  const st = usePageShares(get);
  const [busy, setBusy] = useState(false);
  if (!st.loaded || !st.canShare && !st.shares.length) return null;     // not kept on this fleet, or not this session's
  const stop = async (id) => { setBusy(true); await stopShare(id, get); setBusy(false); };
  return html`<section class="card os-card ps-card"><h3>${tp("cardTitle")}</h3>
    <p class="note">${st.enabled ? tp("cardHint") : tp("e_disabled")}</p>
    ${!st.shares.length ? html`<p class="muted os-none">${tp("none")}</p>` : html`<div class="os-list">
      <ul class="os-rows">${st.shares.map((s) => html`<li key=${s.id} class="os-row">
        <span class="os-what"><strong>${s.title || tp("untitled")}</strong>
          <span class="muted"> · ${tp("from", s.instance)} · ${tp("ends", whenLong(s.expiresAt))}</span></span>
        <button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => stop(s.id)}>${tp("stop")}</button>
      </li>`)}</ul>
      ${st.shares.length > 1 ? html`<button type="button" class="btn btn-sm danger os-all" disabled=${busy} onClick=${() => stop("all")}>${tp("stopAll")}</button>` : null}
    </div>`}
  </section>`;
}

/** The panel's action: Share page, or "Shared until …" when this block is shared. `block` as PageShareDialog's. */
export function PageShareButton({ block, Icon }) {
  const st = usePageShares();
  const [open, setOpen] = useState(false);
  if (!block || !st.canShare) return null;
  const share = shareOf(st.shares, block.instance, block.from);
  return html`<button type="button" class=${`btn btn-sm ${share ? "pv-fb-shared on" : "pv-fb-share"}`} title=${tp(share ? "sharedTitle" : "shareTitle")} onClick=${() => setOpen(true)}>
      <${Icon} name="globe" size=${14} /><span class="lbl">${share ? tp("shared", until(share.expiresAt)) : tp("share")}</span></button>
    ${open ? html`<${PageShareDialog} block=${block} share=${share} onClose=${() => setOpen(false)} />` : null}`;
}
