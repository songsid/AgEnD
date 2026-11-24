/**
 * M-3592: Administration → Sign-in — how long a Hub sign-in lasts, the administrator's (GET/PUT
 * /hub/v1/admin/session-limits). Two lengths from a list within the server's bounds; the server checks them again.
 */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";

register("hubSessionLimits", {
  en: {
    title: "Sign-in", absolute: "Sign people out after", idle: "Or after this long without using the Hub",
    note: "A longer sign-in time applies to new sign-ins; a shorter one also signs out anyone already signed in longer than it. The without-use limit applies to everyone at once.",
    activity: "An open Hub page counts as using it: people are signed out for not using it only when no Hub page is open.",
    save: "Save", saving: "Saving…", saved: "Saved.", failed: "Couldn’t save. Try again.", conflict: "Someone else changed this. The current setting is shown; try again.",
    denied: "Only an administrator can change this.", tooLong: "The time without use can’t be longer than the sign-in itself.",
    dflt: "{0} (default)", min: "{0} minutes", hour: "1 hour", hours: "{0} hours", day: "1 day", days: "{0} days",
  },
  "zh-TW": {
    title: "登入時間", absolute: "登入多久後要重新登入", idle: "或多久沒使用 Hub 就登出",
    note: "「登入多久後要重新登入」改長只套用於之後的登入；改短時，已登入超過這個時間的人也會被登出。「多久沒使用 Hub 就登出」會立即套用到所有人。",
    activity: "開著 Hub 頁面就算在使用：只有沒開任何 Hub 頁面時，才會因為沒使用而登出。",
    save: "儲存", saving: "儲存中…", saved: "已儲存。", failed: "無法儲存，請再試一次。", conflict: "這項設定已被其他人修改，已顯示目前的設定，請再試一次。",
    denied: "只有管理員可以修改這項設定。", tooLong: "沒使用的時間不能比登入時間還長。",
    dflt: "{0}（預設）", min: "{0} 分鐘", hour: "1 小時", hours: "{0} 小時", day: "1 天", days: "{0} 天",
  },
});
const ts = (key, ...a) => t(`hubSessionLimits.${key}`, ...a);
/** The lengths offered (minutes), all within the server's bounds. */
export const ABSOLUTE_CHOICES = Object.freeze([60, 120, 240, 480, 720, 1440, 4320, 10080]);
export const IDLE_CHOICES = Object.freeze([15, 30, 60, 120, 240, 480, 1440]);
/** A length in minutes as words: "15 minutes", "8 hours", "7 days". */
export function minutesText(m) {
  if (m % 1440 === 0) return m === 1440 ? ts("day") : ts("days", m / 1440);
  if (m % 60 === 0) return m === 60 ? ts("hour") : ts("hours", m / 60);
  return ts("min", m);
}
const refusal = (r) => r?.status === 409 || r?.code === "revision-conflict" ? ts("conflict")
  : r?.code === "idle-longer-than-absolute" ? ts("tooLong") : r?.status === 401 || r?.status === 403 ? ts("denied") : ts("failed");

/** The card; nothing while the setting cannot be read (an older Hub, or not an administrator). */
export function HubSessionLimitsCard({ client }) {
  const [state, setState] = useState(null), [absolute, setAbsolute] = useState(480), [idle, setIdle] = useState(60);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(null);
  const epoch = useRef(0);
  const load = async () => {
    const r = typeof client?.sessionLimits === "function" ? await client.sessionLimits() : { ok: false };
    if (!r || r.ok === false || !Number.isInteger(r.absoluteMinutes)) { setState({ missing: true }); return; }
    setState(r); setAbsolute(r.absoluteMinutes); setIdle(r.idleMinutes);
  };
  useEffect(() => { void load(); return () => { epoch.current++; }; }, []);
  if (!state || state.missing) return null;
  const b = state.bounds || { absolute: { default: 480 }, idle: { default: 60 } };
  // A saved length not in the list (set through the API) is offered as it is.
  const choices = (list, current) => (list.includes(current) ? list : [...list, current].sort((x, y) => x - y));
  const option = (m, def, disabled = false) => html`<option key=${m} value=${String(m)} disabled=${disabled}>${m === def ? ts("dflt", minutesText(m)) : minutesText(m)}</option>`;
  const changed = absolute !== state.absoluteMinutes || idle !== state.idleMinutes;
  const save = async () => {
    if (busy) return;
    if (idle > absolute) { setMsg({ ok: false, text: ts("tooLong") }); return; }
    setBusy(true); setMsg(null); const mine = ++epoch.current;
    let r; try { r = await client.saveSessionLimits({ absoluteMinutes: absolute, idleMinutes: idle, ifRevision: state.revision }); } catch { r = { ok: false }; }
    if (mine !== epoch.current) return;
    setBusy(false);
    if (r && r.ok !== false && Number.isInteger(r.absoluteMinutes)) { setState(r); setAbsolute(r.absoluteMinutes); setIdle(r.idleMinutes); setMsg({ ok: true, text: ts("saved") }); return; }
    setMsg({ ok: false, text: refusal(r) });
    if (r?.status === 409 || r?.code === "revision-conflict") await load();
  };
  return html`<section class="card hub-session-limits" id="hub-admin-sign-in"><h3>${ts("title")}</h3>
    <label class="field"><span>${ts("absolute")}</span>
      <select class="hub-session-absolute" value=${String(absolute)} disabled=${busy} onChange=${(e) => { setAbsolute(Number(e.target.value)); setMsg(null); }}>
        ${choices(ABSOLUTE_CHOICES, state.absoluteMinutes).map((m) => option(m, b.absolute.default))}</select></label>
    <label class="field"><span>${ts("idle")}</span>
      <select class="hub-session-idle" value=${String(idle)} disabled=${busy} onChange=${(e) => { setIdle(Number(e.target.value)); setMsg(null); }}>
        ${choices(IDLE_CHOICES, state.idleMinutes).map((m) => option(m, b.idle.default, m > absolute))}</select></label>
    <p class="note">${ts("note")}</p>
    <p class="note">${ts("activity")}</p>
    ${msg ? html`<p class=${msg.ok ? "note" : "err"} role=${msg.ok ? "status" : "alert"}>${msg.text}</p>` : null}
    <button type="button" class="btn hub-session-save" disabled=${busy || !changed} onClick=${save}>${ts(busy ? "saving" : "save")}</button>
  </section>`;
}
