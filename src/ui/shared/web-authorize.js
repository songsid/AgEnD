// #1939 S2b (design §0.1): "Authorize this browser". The app shows this browser's state — verified (until when), a
// Confirm card waiting in the account's Discord or Telegram DM (with its countdown), or why it can't be authorized here —
// and asks for the card. The card itself is the gate: nothing here can authorize anything.
import { html, useEffect, useRef, useState } from "./app-html.js";
import { register, t } from "./app-i18n.js";
import { guestPage } from "./app-store.js";

register("webauth", {
  en: {
    verified: "Verified · speaks as you until {0}",
    notVerified: "Not verified",
    authorize: "Authorize this browser",
    waiting: "Waiting for your Confirm in Discord or Telegram ({0})",
    sent: "Sent — confirm it in your DM within 5 minutes.",
    reason_disabled: "Web authority is turned off.",
    reason_loopback_only: "Only this computer can authorize, and this browser is not on it.",
    reason_no_account: "This browser was not signed in as an account (agend web): sign in with /web to authorize.",
    reason_not_admin: "Your account is not a fleet admin here.",
    reason_not_admin_session: "Guests can't authorize.",
    reason_token_rotated: "The dashboard's token changed: sign in again.",
    reason_public_link: "Not on the temporary public link.",
    reason_named_link_off: "Over your named link: turn on \"Also over my named link\" in Settings → Access & security on this computer.",
    reason_quick_link_off: "Over the temporary public link: turn on \"Also over the temporary public link\" in Settings → Access & security on this computer.",
    reason_not_session: "Sign in to authorize.",
    reason_other: "This browser can't be authorized here.",
    refusal_pending: "A request is already waiting in your DM.",
    refusal_rate_limited: "Three requests this hour — try again in {0} min.",
    refusal_dm_unavailable: "Couldn't send you a DM. Open your DMs with the bot, then try again.",
    refusal_other: "That didn't work: {0}",
    settings: "Settings",
    verifiedShort: "Verified",
    authorizeShort: "Authorize",
    authorizeWhy: "Not verified: authorize this browser to speak as you",
    waitingShort: "Waiting for your Confirm ({0})",
  },
  "zh-TW": {
    verified: "已驗證 · 以你的身分發言到 {0}",
    notVerified: "未驗證",
    authorize: "授權這個瀏覽器",
    waiting: "等你在 Discord 或 Telegram 按下確認（{0}）",
    sent: "已送出——請在 5 分鐘內到私訊確認。",
    reason_disabled: "網頁授權已關閉。",
    reason_loopback_only: "只有這台電腦可以授權，而這個瀏覽器不在這台電腦上。",
    reason_no_account: "這個瀏覽器不是用帳號登入的（agend web）：請用 /web 登入後再授權。",
    reason_not_admin: "你的帳號在這裡不是 fleet 管理者。",
    reason_not_admin_session: "訪客無法授權。",
    reason_token_rotated: "儀表板的 token 已變更：請重新登入。",
    reason_public_link: "臨時公開連結上無法授權。",
    reason_named_link_off: "透過固定網域：請在這台電腦的 設定 → 存取與安全 開啟「也允許透過我的固定網域」。",
    reason_quick_link_off: "透過臨時公開連結：請在這台電腦的 設定 → 存取與安全 開啟「也允許透過臨時公開連結」。",
    reason_not_session: "登入後才能授權。",
    reason_other: "這個瀏覽器在這裡無法授權。",
    refusal_pending: "已經有一個請求在你的私訊中等待。",
    refusal_rate_limited: "這一小時已請求三次——請 {0} 分鐘後再試。",
    refusal_dm_unavailable: "無法私訊給你。請開放與 bot 的私訊後再試一次。",
    refusal_other: "沒有成功：{0}",
    settings: "設定",
    verifiedShort: "已驗證",
    authorizeShort: "授權",
    authorizeWhy: "未驗證：授權這個瀏覽器以你的身分發言",
    waitingShort: "等待確認（{0}）",
  },
});
const tn = (k, ...v) => t(`webauth.${k}`, ...v);
// The switch and "Only this computer" are changed in Settings on this computer — never over the public link (#2525 review).
const fixable = (reason) => (reason === "disabled" || reason === "loopback_only") && globalThis.document?.body?.dataset?.publicLink !== "1";
const REASONS = ["disabled", "loopback_only", "no_account", "not_admin", "not_admin_session", "token_rotated", "public_link", "named_link_off", "quick_link_off", "not_session"];
// Until when: the time, with the day when it isn't today (an authorization lasts up to 48 h).
const clock = (ms) => {
  const d = new Date(ms), today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

// One read per page load, shared by every line that shows it (the composer's, the session menu's): coming back to a chat
// reads nothing (#1374). It is read again only after an ask, and while a card is pending.
// An answer of any kind counts as this page's read (one that isn't a state hides the line); only a network failure lets a
// later mount try again. Signed out (401: the session ended, e.g. Not me), the line goes.
let shared = null, answered = false, inflight = null, signedOut = false;
async function readStatus() {
  inflight ??= (async () => {
    try {
      const r = await fetch("/ui/authorization", { credentials: "same-origin" });
      answered = true;
      if (r.status === 401) { signedOut = true; shared = null; }
      const body = r.ok ? await r.json().catch(() => null) : null;
      if (body && typeof body.state === "string") shared = body;
    } catch { /* the line stays as it was; a later mount may try again */ }
    finally { inflight = null; }
    return shared;
  })();
  return inflight;
}

/** This browser's authorization, kept fresh while a card is pending (every 3 s, until it is decided or expires). */
export function useWebAuthorization() {
  const [st, setSt] = useState(shared), [notice, setNotice] = useState(null);
  const [deadline, setDeadline] = useState(0), [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  const load = async () => {
    // §0.2 / §0.3: over the public link too — the server says whether this browser may be authorized there (its link's
    // option on) or why not; a guest never asks.
    if (guestPage()) return;
    const body = await readStatus();
    if (!alive.current) return;
    if (signedOut) { setSt(null); setNotice(null); return; }
    if (!body) return;
    setSt(body);
    if (body.state !== "pending") setNotice((n) => (n === tn("sent") ? null : n));           // "Sent —" was about the card
    if (body.state === "pending" && typeof body.expiresInMs === "number") setDeadline(Date.now() + body.expiresInMs);
  };
  useEffect(() => { alive.current = true; if (!answered) load(); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!st || st.state !== "pending") return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000), poll = setInterval(load, 3000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [st && st.state]);
  // "Verified · until X" is read again at X (a page left open must not keep saying verified after it ends).
  useEffect(() => {
    if (!st || st.state !== "verified" || typeof st.until !== "number") return undefined;
    const at = setTimeout(() => { resetWebAuthorization(); load(); }, Math.max(0, Math.min(st.until - Date.now() + 1000, 2 ** 31 - 1)));
    return () => clearTimeout(at);
  }, [st && st.state, st && st.until]);
  const ask = async () => {
    setNotice(null);
    let r = null, body = null;
    try { r = await fetch("/ui/authorization", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }); body = await r.json(); } catch { body = null; }
    if (r && r.ok && body && body.ok) { setNotice(tn("sent")); setSt(shared = { state: "pending", expiresInMs: body.expiresInMs }); setDeadline(Date.now() + body.expiresInMs); return; }
    const refusal = body && body.refusal;
    if (refusal === "rate_limited") setNotice(tn("refusal_rate_limited", Math.max(1, Math.ceil((body.retryAfterMs || 0) / 60_000))));
    else if (refusal === "pending" || refusal === "dm_unavailable") setNotice(tn(`refusal_${refusal}`));
    else if (REASONS.includes(refusal)) setNotice(tn(`reason_${refusal}`));
    else setNotice(tn("refusal_other", String(refusal || (r && r.status) || "?")));
    load();
  };
  return { st, notice, ask, left: deadline - now };
}

/**
 * Forget the page's one read, so the next line that mounts reads again: Settings → Web calls it when it shows (a revoke
 * or a changed switch there changes what the line should say). Tests use it too: each case is its own page load.
 */
export function resetWebAuthorization() { shared = null; answered = false; inflight = null; signedOut = false; }

/** The line under the composer: verified, waiting, or "Not verified" with the button (or why not, with the fix). */
export function AuthorizeChip() {
  const a = useWebAuthorization();
  if (guestPage()) return null;
  if (!a.st) return null;
  return html`<div class="webauth-chip" data-state=${a.st.state}>${body(a)}${a.notice ? html` <span class="note" role="status">${a.notice}</span>` : null}</div>`;
}

/**
 * The composer's row (#2215, the user's request, 2026-10-19): the same states as AuthorizeChip, each kept to a few words so
 * they share one row with the key hint. What a state would have said at length is in its tooltip and its accessible
 * name: when "Verified" ends, why it can't be authorized, the countdown's ask. A tap on "✓ Verified" shows when it
 * ends (touch has no hover) in a bubble above the row, until the next tap, a tap elsewhere or Escape. What pressing
 * Authorize answered (sent, refused) is said in the row itself, in the hint's place (#2216 review: a bubble left over the
 * composer covered Attach and what was being typed, with nothing to close it).
 */
export function ComposerAuth() {
  const a = useWebAuthorization();
  const [open, setOpen] = useState(false);
  const tip = useRef("wa-tip-" + Math.random().toString(36).slice(2, 8));
  useEffect(() => { setOpen(false); }, [a.st && a.st.state]);              // a new state closes the bubble
  if (guestPage()) return null;
  if (!a.st) return null;
  const st = a.st, id = tip.current;
  const said = a.notice ? html`<span class="webauth-notice" role="status">${a.notice}</span>` : null;
  if (st.state === "verified") {
    const until = tn("verified", clock(st.until));
    return html`<span class="webauth-row" data-state="verified">
      <button type="button" class="webauth-ok" title=${until} aria-label=${`✓ ${until}`} aria-expanded=${open ? "true" : "false"}
        aria-controls=${id} onClick=${() => setOpen((v) => !v)} onBlur=${() => setOpen(false)}
        onKeyDown=${(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); } }}>✓ ${tn("verifiedShort")}</button><span
        id=${id} class="webauth-tip" role="tooltip" hidden=${!open}>${until}</span>${said}</span>`;
  }
  if (st.state === "pending") {
    const asks = tn("waiting", mmss(a.left));
    return html`<span class="webauth-row" data-state="pending"><span class="note" title=${a.notice ? `${asks} — ${a.notice}` : asks}>${tn("waitingShort", mmss(a.left))}</span>${said}</span>`;
  }
  if (st.reason === "not_authorized" || st.reason === "authorization_expired") {
    return html`<span class="webauth-row" data-state="none"><span class="note" aria-hidden="true">${tn("notVerified")} ·</span><button type="button" class="webauth-ask"
      title=${tn("authorizeWhy")} aria-label=${tn("authorizeWhy")} onClick=${a.ask}>${tn("authorizeShort")}</button>${said}</span>`;
  }
  const why = REASONS.includes(st.reason) ? tn(`reason_${st.reason}`) : tn("reason_other");
  return html`<span class="webauth-row" data-state="none"><span class="note" title=${why}>${tn("notVerified")}<span class="sr-only">: ${why}</span></span>${fixable(st.reason)
    ? html` · <a href="/settings/access" title=${why}>${tn("settings")}</a>` : null}</span>`;
}

function body(a) {
  const st = a.st;
  if (st.state === "verified") return html`<span class="webauth-ok">✓ ${tn("verified", clock(st.until))}</span>`;
  if (st.state === "pending") return html`<span class="note">${tn("waiting", mmss(a.left))}</span>`;
  if (st.reason === "not_authorized" || st.reason === "authorization_expired")
    return html`<span class="note">${tn("notVerified")} ·</span> <button type="button" class="btn btn-sm" onClick=${a.ask}>${tn("authorize")}</button>`;
  const why = REASONS.includes(st.reason) ? tn(`reason_${st.reason}`) : tn("reason_other");
  // The fix, where there is one the person can take here: the switch lives in Settings → Web.
  return html`<span class="note">${tn("notVerified")}: ${why}</span>${fixable(st.reason) ? html` <a href="/settings/access">${tn("settings")}</a>` : null}`;
}
