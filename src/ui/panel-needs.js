// #1408 step 4 = #1386 part (b): the "Needs you" panel (/ui/needs) — everything waiting on the person, from every
// world, in one list. Behind the session gate (/ui/js/), loaded the first time it is opened.
//
// A renderer only (#1386 §4.2, the user's Discord-first rule): the list is the server's one derivation, the app
// store's `needs`, which arrives over the passive channels (SSE `needs`, the /ui/poll field). This panel reads
// nothing (#1374: no new GET, no timer that asks the server); its writes are a person's actions:
// - a prompt's own buttons, through the chat store (one claim path with Chat: POST /ui/prompt, first answer wins);
// - Acknowledge on a delivery (POST /ui/needs/ack), which clears it everywhere;
// - Open: that instance's chat.
// Something resolved anywhere (Discord, Telegram, the web) leaves the list by itself.
import { html, useEffect, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore, createStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { PanelHeader, setTitle } from "/assets/app-shell.js";
import { chatPath } from "/assets/app-route.js";
import { Empty } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { notifyStore, notifySupport, reasonText, refreshNotify, setNotify } from "/assets/app-needs.js";
import { store as chatStore } from "./panel-chat.js";

register("needs", {
  en: {
    title: "Needs you", empty: "Nothing needs you right now", emptyHint: "When an agent waits for you, it shows here — and in Discord.",
    open: "Open chat", acknowledge: "Acknowledge", acknowledging: "Acknowledging…", answering: "Answering…",
    ageNow: "just now", ageMin: "{0} min", ageHour: "{0} h", ageDay: "{0} d",
    notifyTitle: "Notify me on this device", notifyOn: "Notifications are on for this browser while a tab is open.",
    notifyOff: "Get a desktop notification when something new needs you while this tab is in the background.",
    notifyDenied: "This browser blocked notifications for AgEnD. Allow them in the site settings to turn this on.",
    notifyMobile: "On a phone, rely on the Discord notification: a new item is a new post in General.",
    notifyInsecure: "Notifications need a secure address (localhost or the HTTPS public link), not a plain-HTTP LAN address.",
    notifyUnsupported: "This browser cannot show notifications.", turnOn: "Turn on", turnOff: "Turn off",
    typePrompt: "Fleet prompt", typeAwaiting: "At its terminal", typeInstance: "Instance", typeDelivery: "Delivery",
  },
  "zh-TW": {
    title: "等你處理", empty: "目前沒有需要你處理的事", emptyHint: "agent 在等你時，會出現在這裡——也會出現在 Discord。",
    open: "開啟聊天", acknowledge: "確認", acknowledging: "確認中…", answering: "回覆中…",
    ageNow: "剛剛", ageMin: "{0} 分鐘", ageHour: "{0} 小時", ageDay: "{0} 天",
    notifyTitle: "在這台裝置通知我", notifyOn: "這個瀏覽器的通知已開啟（需要開著分頁）。",
    notifyOff: "分頁在背景時，有新的事等你處理就跳出桌面通知。",
    notifyDenied: "這個瀏覽器封鎖了 AgEnD 的通知。請在網站設定中允許後再開啟。",
    notifyMobile: "在手機上請以 Discord 通知為主：每個新項目都會在 General 發一則新訊息。",
    notifyInsecure: "通知需要安全的網址（localhost 或 HTTPS 公開連結），區網的一般 HTTP 網址不行。",
    notifyUnsupported: "這個瀏覽器無法顯示通知。", turnOn: "開啟", turnOff: "關閉",
    typePrompt: "Fleet 提示", typeAwaiting: "在終端機上", typeInstance: "Instance", typeDelivery: "傳送",
  },
});
const tn = (k, ...v) => t(`needs.${k}`, ...v);

/**
 * The page's claims on what Needs you writes, kept for the life of the page — not of a panel or a render (#1463
 * review): a second click in the same turn, the panel left and opened again, or a list that has not caught up yet all
 * see the same claim.
 * - `acks[id]`: "busy" while its POST is out, "done" once the server took it, until the server's next list drops the
 *   item (then forgotten); a failure gives it back.
 * - `prompts[nonce]`: the same, for a prompt answered while the chat store is not there yet (only before Chat boots);
 *   otherwise the chat store's own prompt is the claim (answerByNonce).
 */
export const claims = createStore({ acks: {}, prompts: {} });
appStore.subscribe((st) => {
  const items = Array.isArray(st.needs) ? st.needs : [];
  const listed = new Set(items.map((i) => i.id)), nonces = new Set(items.map((i) => i.nonce).filter(Boolean));
  const c = claims.get();
  const acks = Object.fromEntries(Object.entries(c.acks).filter(([id, v]) => v === "busy" || listed.has(id)));
  const prompts = Object.fromEntries(Object.entries(c.prompts).filter(([n, v]) => v === "busy" || nonces.has(n)));
  if (Object.keys(acks).length !== Object.keys(c.acks).length || Object.keys(prompts).length !== Object.keys(c.prompts).length) claims.set({ acks, prompts });
});
const setClaim = (kind, key, value) => claims.set((c) => {
  const next = { ...c[kind] };
  if (value) next[key] = value; else delete next[key];
  return { ...c, [kind]: next };
});

const ICON = { prompt: "chat", awaiting_input: "clock", instance: "alert", delivery: "send" };
const BAD = new Set(["crashed", "delivery_failed", "hang", "exited"]);

/** "3 min", "2 h": the age shown beside an item (refreshed by a display timer, never by a read). */
export function age(since, nowMs) {
  const minutes = Math.max(0, Math.floor((nowMs - since) / 60_000));
  if (minutes < 1) return tn("ageNow");
  if (minutes < 60) return tn("ageMin", minutes);
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? tn("ageHour", hours) : tn("ageDay", Math.floor(hours / 24));
}

/** The store's list, grouped by instance, in its order (instances by their oldest item; items oldest first). */
export function groupNeeds(items) {
  const groups = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.instance === item.instance) last.items.push(item);
    else groups.push({ instance: item.instance, items: [item] });
  }
  return groups;
}

export function NeedsPanel({ navKey }) {
  const lease = useLease(navKey);
  const { needs } = useStore(appStore);
  const items = Array.isArray(needs) ? needs : [];
  const [, tick] = useState(0);
  useEffect(() => { setTitle(tn("title")); }, [navKey]);
  // Ages move on: a redraw every 30 s while the panel is open (display only — nothing is read).
  useEffect(() => { lease.interval(() => tick((n) => n + 1), 30_000); }, [lease]);
  // The chat store owns a prompt's busy/answered state; redraw when it changes.
  useEffect(() => { if (chatStore) lease.hold(chatStore.subscribe(() => tick((n) => n + 1))); }, [lease]);
  const groups = groupNeeds(items);
  const nowMs = Date.now();
  return html`<div class="panel p-needs">
    <${PanelHeader} title=${tn("title")} sub=${items.length ? t("app.needsCount", items.length) : null} />
    <div class="panel-body"><div class="col">
      ${!items.length ? html`<${Empty} icon="check" title=${tn("empty")} hint=${tn("emptyHint")} />`
        : groups.map((g) => html`<section key=${g.instance} class="n-group" aria-label=${g.instance}>
          <h2 class="n-group-head"><a href=${chatPath(g.instance)}>${g.instance}</a></h2>
          ${g.items.map((item) => html`<${NeedsItem} key=${item.id} item=${item} nowMs=${nowMs} />`)}
        </section>`)}
      <${NotifyToggle} />
    </div></div>
  </div>`;
}

function NeedsItem({ item, nowMs }) {
  const c = useStore(claims);
  // A prompt: the chat store's prompt is the one claim (Chat and Needs you, any panel, any render).
  const p = item.type === "prompt" && item.nonce && chatStore ? chatStore.state.prompts[item.nonce] : null;
  const fallback = item.nonce ? c.prompts[item.nonce] : undefined;
  const promptBusy = p ? p.busy || p.resolved : !!fallback;
  const answer = async (action) => {
    if (chatStore) { chatStore.answerByNonce(item, action); return; }
    // Only before Chat has booted: the page's own claim on this nonce, taken now (synchronously), kept until the
    // server's list drops the prompt (or the answer fails).
    if (claims.get().prompts[item.nonce]) return;
    setClaim("prompts", item.nonce, "busy");
    let r = null;
    try {
      const res = await fetch("/ui/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance: item.instance, nonce: item.nonce, action }) });
      r = await res.json().catch(() => ({}));
    } catch (err) { r = { error: err && err.message ? err.message : t("app.failed") }; }
    if (r && r.answered) { setClaim("prompts", item.nonce, "done"); return; }
    setClaim("prompts", item.nonce, null);
    toast((r && r.error) || t("app.failed"), false);
  };
  const ack = c.acks[item.id];
  const acknowledge = async () => {
    if (claims.get().acks[item.id]) return;                       // the page's claim, taken synchronously
    setClaim("acks", item.id, "busy");
    let res = null, body = null;
    try {
      res = await fetch("/ui/needs/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id }) });
      body = await res.json().catch(() => ({}));
    } catch { body = { error: t("app.failed") }; }
    // Taken: it stays claimed until the server's next `needs` drops it — here, everywhere at once. Refused: free again.
    setClaim("acks", item.id, res && res.ok ? "done" : null);
    toast((body && (body.message || body.error)) || t("app.failed"), !!(res && res.ok));
  };
  return html`<article class=${`n-item${BAD.has(item.reason) ? " bad" : ""}`}>
    <span class="n-icon"><${Icon} name=${ICON[item.type] || "alert"} size=${18} /></span>
    <div class="n-body">
      <div class="n-title"><strong>${reasonText(item)}</strong><span class="n-age">${age(item.since, nowMs)}</span></div>
      ${item.detail ? html`<p class="n-detail">${item.detail}</p>` : null}
      <div class="n-actions">
        ${item.type === "prompt" && Array.isArray(item.actions) ? item.actions.map((a) => html`<button key=${a.id} type="button" class="btn btn-sm"
            disabled=${promptBusy} onClick=${() => answer(a.id)}>${(p ? p.busy : fallback === "busy") ? tn("answering") : a.label}</button>`) : null}
        ${item.type === "delivery" ? html`<button type="button" class="btn btn-sm" disabled=${!!ack} onClick=${acknowledge}>
            <${Icon} name="check" size=${14} />${ack === "busy" ? tn("acknowledging") : tn("acknowledge")}</button>` : null}
        <a class="btn btn-sm btn-ghost" href=${chatPath(item.instance)}>${tn("open")}</a>
      </div>
    </div>
  </article>`;
}

/** The device's choice, as the page knows it (app-needs.js notifyStore): every mounted toggle shows the same. */
function NotifyToggle() {
  const support = notifySupport();
  const { state, asking } = useStore(notifyStore);
  useEffect(() => { refreshNotify(); }, []);
  const on = state === "on";
  const toggle = () => { setNotify(!on); };
  const note = support === "mobile" ? tn("notifyMobile") : support === "insecure" ? tn("notifyInsecure")
    : support !== "ok" ? tn("notifyUnsupported") : state === "denied" ? tn("notifyDenied") : on ? tn("notifyOn") : tn("notifyOff");
  return html`<section class="card n-notify"><h3>${tn("notifyTitle")}</h3>
    <p class="note">${note}</p>
    ${support === "ok" ? html`<div><button type="button" class=${`btn btn-sm${on ? "" : " btn-primary"}`} aria-pressed=${on ? "true" : "false"} disabled=${asking} onClick=${toggle}>
      <${Icon} name="bell" size=${14} />${on ? tn("turnOff") : tn("turnOn")}</button></div>` : null}
  </section>`;
}
