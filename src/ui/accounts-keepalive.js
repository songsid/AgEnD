// #3292: Settings → Accounts → "Keep sign-in alive", one line under a Claude Code or Codex row (signin-keepalive.ts on the
// server decides and runs; this page only shows and asks). A module of its own with its own words and stylesheet: a tab
// that loaded an older accounts-view.js never shows it, and it never meets an older cached strings file or accounts.css.
// - The switch: once a day AgEnD renews this sign-in when no agent or room is using it — `claude auth status` / Codex's
//   app-server, no model request.
// - Claude Code only, once switched on: allow one tiny request on the smallest model when that check did not renew it.
// - One line at the foot of the account's box. What each switch does is the settings pages' own ⓘ after it (`InfoTip`, settings-shared.js: shown on
//   hover or focus, pinned by a tap — so a phone has it too — and closed by Esc or a click elsewhere; a layer over the box, it moves nothing).
// - What it knows: when the sign-in ends (Claude Code: a fixed date renewing cannot move), and the last check's result.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { toast } from "/assets/ui-toast.js";
import { InfoTip } from "./settings-shared.js";

register("accountsKeepAlive", {
  en: {
    label: "Keep sign-in alive",
    hint_claude: "Once a day, if no agent is using it, AgEnD renews this sign-in with Claude Code's own status check. No model request.",
    hint_codex: "Once a day, if no agent is using it, AgEnD renews this sign-in through Codex's own refresh. No model request.",
    fallback: "Backup renewal (a tiny request if the status check doesn't renew)",
    fallbackHint: "When the regular status check can't extend the sign-in, allow one very short request on the smallest model (a few dozen tokens) to keep it signed in.",
    endsAt: "Sign-in ends {0}", endsSoon: "Sign-in ends {0}. Renewing can't move this date: sign in again before then.", ended: "Sign-in ended {0}. Sign in again.",
    plan: "Plan: {0}", last: "Last check {0}: {1}",
    o_refreshed: "renewed", o_fallback_refreshed: "renewed with the small request", o_not_needed: "still valid", o_checked: "signed in",
    o_in_use: "in use, kept alive by its agents", o_unsupported: "nothing to renew (an API key)", o_not_renewed: "not renewed",
    o_needs_sign_in: "needs signing in again", o_transient: "couldn't reach the service; will try again tomorrow",
    on: "Keep sign-in alive is on.", off: "Keep sign-in alive is off.", failed: "That didn't work. Try again.",
  },
  "zh-TW": {
    label: "保持登入",
    hint_claude: "沒有 Agent 使用時，AgEnD 每天用 Claude Code 自己的狀態檢查續期這個登入一次。不會呼叫模型。",
    hint_codex: "沒有 Agent 使用時，AgEnD 每天透過 Codex 自己的刷新續期這個登入一次。不會呼叫模型。",
    fallback: "備援續期（狀態檢查未續期時改送極小請求）",
    fallbackHint: "當一般狀態檢查未能延長登入效期時，允許改用最小模型送一次極短請求（約數十 token）來維持登入。",
    endsAt: "登入到期：{0}", endsSoon: "登入到期：{0}。續期無法延後這個日期，請在那之前重新登入。", ended: "登入已於 {0} 到期。請重新登入。",
    plan: "方案：{0}", last: "上次檢查 {0}：{1}",
    o_refreshed: "已續期", o_fallback_refreshed: "已用小請求續期", o_not_needed: "仍有效", o_checked: "已登入",
    o_in_use: "使用中，由它的 Agent 保持登入", o_unsupported: "沒有需要續期的（API 金鑰）", o_not_renewed: "沒有續期",
    o_needs_sign_in: "需要重新登入", o_transient: "連不上服務；明天會再試",
    on: "已開啟保持登入。", off: "已關閉保持登入。", failed: "沒有成功，請再試一次。",
  },
});
const tk = (k, ...v) => t(`accountsKeepAlive.${k}`, ...v);
const WARN_MS = 10 * 86_400_000;

/** This control's stylesheet, linked once (an older accounts.css has no rules for it). */
export function linkKeepAliveCss(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector('link[data-accounts-keepalive-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/accounts-keepalive.css"); link.setAttribute("data-accounts-keepalive-css", "1");
    doc.head.appendChild(link);
  } catch { /* the control still works without it */ }
}

const day = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(); };
const stamp = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(); };

/** POST the setting; the server answers ok or a refusal code. */
export async function saveKeepAlive(row, enabled, fallback, fetchImpl = fetch) {
  try {
    const r = await fetchImpl("/ui/accounts/keep-alive", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: row.backend, profile: row.profile || null, enabled: !!enabled, ...(row.backend === "claude-code" ? { fallback: !!fallback } : {}) }) });
    return r.ok;
  } catch { return false; }
}

/** The row's keep-alive line. `onSaved`: read the view again (accounts-view.js passes a fresh read). */
export function KeepAliveControl({ row, onSaved, now = Date.now() }) {
  const given = row && row.keepAlive;
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);
  // #3313 review P2-6 (r2): what the server acknowledged, shown and built on until a read that began after the write
  // has been applied (onSaved answers true), or the row says the same. A read from before the write, or one that failed,
  // never brings back a setting the person already withdrew.
  const [ack, setAck] = useState(null);
  useEffect(() => { if (ack && given && !!given.enabled === ack.enabled && !!given.fallback === ack.fallback) setAck(null); }, [given, ack]);
  // #3313 review (web-claude P3): an answer that arrives after the row is gone (the person left the page) says nothing
  // and reads nothing again.
  const live = useRef(true);
  useEffect(() => { live.current = true; linkKeepAliveCss(); return () => { live.current = false; }; }, []);
  if (!given) return null;
  const k = ack ? { ...given, ...ack } : given;
  // One change at a time, held until the view has been read again after it.
  const save = async (enabled, fallback) => {
    if (busyNow.current) return;
    busyNow.current = true; setBusy(true);
    try {
      const ok = await saveKeepAlive(row, enabled, fallback);
      if (!live.current) return;
      toast(ok ? tk(enabled ? "on" : "off") : tk("failed"), ok);
      if (!ok) return;
      setAck({ enabled: !!enabled, fallback: !!fallback });
      let fresh = false;
      if (typeof onSaved === "function") { try { fresh = (await onSaved()) === true; } catch { fresh = false; } }
      if (fresh && live.current) setAck(null);
    } finally {
      busyNow.current = false;
      if (live.current) setBusy(false);
    }
  };
  const ends = k.endsAt ? new Date(k.endsAt).getTime() : NaN;
  const endLine = Number.isNaN(ends) ? null : ends <= now ? tk("ended", day(k.endsAt)) : ends - now <= WARN_MS ? tk("endsSoon", day(k.endsAt)) : tk("endsAt", day(k.endsAt));
  const warn = !Number.isNaN(ends) && ends - now <= WARN_MS;
  const last = k.enabled && k.lastAt && k.lastOutcome ? tk("last", stamp(k.lastAt), tk(`o_${k.lastOutcome}`)) : null;
  const bad = k.lastOutcome === "needs_sign_in" || k.lastOutcome === "not_renewed";
  return html`<div class="s-account-keepalive" data-keepalive=${k.enabled ? "on" : "off"}>
    ${/* Ridge #3321 S10: an on/off feature is the shared switch (s-ui-toggle), as Hub membership and web authority; the paid fallback stays a checkbox. */ ""}
    <label class="check"><input class="s-ui-toggle" type="checkbox" role="switch" checked=${!!k.enabled} disabled=${busy} onChange=${(e) => save(e.currentTarget.checked, k.fallback)} />
      <span>${tk("label")}</span></label>
    <${InfoTip} text=${tk(row.backend === "claude-code" ? "hint_claude" : "hint_codex")} name=${tk("label")} />
    ${row.backend === "claude-code" && k.enabled ? html`<span class="s-keepalive-fallback"><label class="check"><input type="checkbox" checked=${!!k.fallback} disabled=${busy} onChange=${(e) => save(true, e.currentTarget.checked)} />
      <span>${tk("fallback")}</span></label><${InfoTip} text=${tk("fallbackHint")} name=${tk("fallback")} /></span>` : null}
    ${endLine ? html`<small class=${`s-keepalive-ends${warn ? " is-warn" : ""}`}>${endLine}</small>` : null}
    ${k.planType ? html`<small class="s-keepalive-plan">${tk("plan", k.planType)}</small>` : null}
    ${last ? html`<small class=${`s-keepalive-last${bad ? " is-bad" : ""}`}>${last}</small>` : null}
  </div>`;
}
