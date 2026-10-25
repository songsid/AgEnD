// #2636: Office share links on the dashboard — the Office's Share… dialog (make one: which office, how long, whether
// agents' own lines show; then its URL to copy) and the list of open ones (Settings → Access & security, and under the
// dialog's form): each with its office, when it ends, whether lines show and who made it, Revoke and Revoke all.
// GET / POST /ui/office-share, DELETE /ui/office-share/<id|all> (web-api.ts): an admin session on the dashboard reached
// directly only; the public link never offers these.
import { html, useEffect, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { toast } from "/assets/ui-toast.js";

register("oshare", {
  en: {
    share: "Share…", title: "Share the office", lead: "Anyone with the link can watch this office live — names and states, nothing else — until it ends. No sign-in.",
    office: "Office", allOffices: "All offices", how: "For", text: "Include agents' own status lines", create: "Create link", creating: "Starting the link…",
    made: "Anyone with this link can watch until {0}.", copy: "Copy link", copied: "Link copied", open: "Open links", none: "No share links are open.",
    ends: "until {0}", withText: "with status lines", by: "by {0}", revoke: "Revoke", revokeAll: "Revoke all", close: "Close", failed: "The link could not be made.",
    m15: "15 minutes", m30: "30 minutes", h1: "1 hour", h2: "2 hours", h4: "4 hours", h8: "8 hours", h24: "24 hours",
    e_disabled: "Office share links are off on this fleet (web.office_share.enabled: false).", e_office: "That office no longer exists.",
    e_duration: "That is longer than this fleet allows (web.office_share.max_hours).", e_too_many: "At most 10 share links can be open at once: revoke one first.",
    e_rate: "Cloudflare is limiting new quick tunnels right now. Try again in a few minutes.", e_tunnel: "The share link's tunnel did not start ({0}). Try again later.",
    cardTitle: "Office share links", cardHint: "Read-only links to the live Office view, made from Fleet → Org chart → Office → Share…. Each ends at its time; revoke one to end it now.",
  },
  "zh-TW": {
    share: "分享…", title: "分享辦公室", lead: "拿到連結的人都能即時觀看這間辦公室（只有名稱與狀態），直到連結結束，不需要登入。",
    office: "辦公室", allOffices: "所有辦公室", how: "時間", text: "包含 agent 自己的狀態文字", create: "建立連結", creating: "正在啟動連結…",
    made: "拿到這個連結的人可以觀看到 {0}。", copy: "複製連結", copied: "已複製連結", open: "開啟中的連結", none: "目前沒有開啟中的分享連結。",
    ends: "到 {0} 為止", withText: "含狀態文字", by: "由 {0} 建立", revoke: "撤銷", revokeAll: "全部撤銷", close: "關閉", failed: "無法建立連結。",
    m15: "15 分鐘", m30: "30 分鐘", h1: "1 小時", h2: "2 小時", h4: "4 小時", h8: "8 小時", h24: "24 小時",
    e_disabled: "這個 fleet 已關閉辦公室分享連結（web.office_share.enabled: false）。", e_office: "這間辦公室已不存在。",
    e_duration: "超過這個 fleet 允許的時間（web.office_share.max_hours）。", e_too_many: "同時最多 10 個分享連結：先撤銷一個。",
    e_rate: "Cloudflare 目前限制新的臨時通道，請過幾分鐘再試。", e_tunnel: "分享連結的通道沒有啟動（{0}），請稍後再試。",
    cardTitle: "辦公室分享連結", cardHint: "即時辦公室畫面的唯讀連結，可在 Fleet → 組織圖 → 辦公室 → 分享… 建立。每個連結到時間就結束；撤銷可立即結束。",
  },
});
const to = (k, ...v) => t(`oshare.${k}`, ...v);
const DURATIONS = [["m15", 15], ["m30", 30], ["h1", 60], ["h2", 120], ["h4", 240], ["h8", 480], ["h24", 1440]];
const JSON_HEADERS = { "Content-Type": "application/json" };
const when = (ms) => { try { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms)); } catch { return ""; } };

/** What a refusal says (the host's `error` and `reason`). */
export function refusalText(d) {
  const e = d && d.error;
  if (e === "tunnel") return d.reason === "rate-limited" ? to("e_rate") : to("e_tunnel", d.reason || "unknown");
  return ["disabled", "office", "duration", "too_many"].includes(e) ? to(`e_${e}`) : to("failed");
}

/** The open shares, read (and re-read after a change): { enabled, shares } or null while unread / unavailable. */
export function useShares(get = globalThis.fetch, rev = 0) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let live = true;
    get("/ui/office-share", { method: "GET", headers: JSON_HEADERS }).then((r) => (r.ok ? r.json() : null)).then((v) => { if (live) setD(v); }, () => { if (live) setD(null); });
    return () => { live = false; };
  }, [rev]);
  return d;
}

/** The open shares with Revoke (and Revoke all); `names`: office id → name. */
export function ShareList({ shares, names = {}, get = globalThis.fetch, onChange }) {
  const [busy, setBusy] = useState(false);
  const revoke = async (id) => {
    setBusy(true);
    try { await get(`/ui/office-share/${id}`, { method: "DELETE", headers: JSON_HEADERS }); } catch { /* the list is read again */ }
    setBusy(false);
    onChange && onChange();
  };
  if (!shares || !shares.length) return html`<p class="muted os-none">${to("none")}</p>`;
  return html`<div class="os-list">
    <ul class="os-rows">${shares.map((s) => html`<li key=${s.id} class="os-row">
      <span class="os-what"><strong>${s.office === "all" ? to("allOffices") : names[s.office] || s.office_name || s.office}</strong>
        <span class="muted"> · ${to("ends", when(s.expiresAt))}${s.text ? ` · ${to("withText")}` : ""}</span></span>
      <button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => revoke(s.id)}>${to("revoke")}</button>
    </li>`)}</ul>
    ${shares.length > 1 ? html`<button type="button" class="btn btn-sm danger os-all" disabled=${busy} onClick=${() => revoke("all")}>${to("revokeAll")}</button>` : null}
  </div>`;
}

/** Share…: make a link for one office (the one shown, by default) or all of them. `offices`: the stored ones. */
export function ShareDialog({ offices = [], current = null, get = globalThis.fetch, onClose }) {
  const [office, setOffice] = useState(current && offices.some((o) => o.id === current) ? current : "all");
  const [minutes, setMinutes] = useState(60);
  const [text, setText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);
  const [error, setError] = useState("");
  const [rev, setRev] = useState(0);
  const list = useShares(get, rev);
  const names = Object.fromEntries(offices.map((o) => [o.id, o.name]));
  const create = async () => {
    setBusy(true); setError("");
    try {
      const r = await get("/ui/office-share", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ office, minutes, text }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d && typeof d.url === "string") setMade(d); else setError(refusalText(d));
    } catch { setError(to("failed")); }
    setBusy(false);
    setRev((n) => n + 1);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(made.url); toast(to("copied")); } catch { /* the link is on screen to copy by hand */ } };
  const actions = made ? html`<button type="button" class="btn" onClick=${onClose}>${to("close")}</button>`
    : html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${to("close")}</button>
      <button type="button" class="btn btn-primary" onClick=${create} disabled=${busy}>${busy ? to("creating") : to("create")}</button>`;
  return html`<${Dialog} title=${to("title")} onClose=${onClose} busy=${busy} actions=${actions} wide=${true}>
    <div class="os">
      <p class="muted">${to("lead")}</p>
      ${made ? html`<div class="os-made">
        <input class="input mono os-url" readonly value=${made.url} aria-label=${to("copy")} onFocus=${(e) => e.target.select && e.target.select()} />
        <button type="button" class="btn btn-sm" onClick=${copy}>${to("copy")}</button>
        <p class="note">${to("made", when(made.share.expiresAt))}</p>
      </div>` : html`<div class="os-form">
        <label class="field"><span>${to("office")}</span>
          <select class="tb-select" value=${office} onChange=${(e) => setOffice(e.target.value)} disabled=${busy}>
            ${offices.length > 1 || !offices.length ? html`<option value="all">${to("allOffices")}</option>` : null}
            ${offices.map((o) => html`<option key=${o.id} value=${o.id}>${o.name}</option>`)}
          </select></label>
        <label class="field"><span>${to("how")}</span>
          <select class="tb-select" value=${String(minutes)} onChange=${(e) => setMinutes(Number(e.target.value))} disabled=${busy}>
            ${DURATIONS.map(([k, m]) => html`<option key=${k} value=${String(m)}>${to(k)}</option>`)}
          </select></label>
        <label class="check"><input type="checkbox" checked=${text} onChange=${(e) => setText(e.target.checked)} disabled=${busy} /> ${to("text")}</label>
        ${error ? html`<p class="err os-err" role="alert">${error}</p>` : null}
      </div>`}
      <h3 class="os-head">${to("open")}</h3>
      <${ShareList} shares=${list && list.shares} names=${names} get=${get} onChange=${() => setRev((n) => n + 1)} />
    </div>
  <//>`;
}

/** Settings → Access & security: the open share links, with Revoke (made from the Office's Share…). */
export function OfficeSharesCard({ get = globalThis.fetch }) {
  const [rev, setRev] = useState(0);
  const d = useShares(get, rev);
  if (!d) return null;                                         // not kept on this fleet, or not this session's to see
  return html`<section class="card os-card"><h3>${to("cardTitle")}</h3>
    <p class="note">${d.enabled === false ? to("e_disabled") : to("cardHint")}</p>
    <${ShareList} shares=${d.shares} get=${get} onChange=${() => setRev((n) => n + 1)} />
  </section>`;
}

/** The Office toolbar's Share… button (shown to an admin on the dashboard reached directly, when the fleet offers it). */
export function ShareButton({ offices, current, get, disabled = false }) {
  const [open, setOpen] = useState(false);
  return html`<button type="button" class="btn btn-sm oo-share" disabled=${disabled} onClick=${() => setOpen(true)}>${to("share")}</button>
    ${open ? html`<${ShareDialog} offices=${offices} current=${current} get=${get} onClose=${() => setOpen(false)} />` : null}`;
}
