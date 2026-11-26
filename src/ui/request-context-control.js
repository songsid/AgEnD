// S-230: the owner switch. Status comes from the host, never from a browser preference or an agent argument.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { lang, register, t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { AuthorizeChip } from "/assets/web-authorize.js";

register("requestContextControl", {
  en: {
    goBack: "This also ends Go back for the latest update (available until {0}).", enableTitle: "Turn on request-based contact approvals?", enable: "Confirm turn on", unknown: "State unknown", inspect: "View held messages", update: "Finish or resolve the AgEnD update first, then check again.", stopTitle: "Stop this work?", stopBody: "This ends the saved work and prevents it from resuming. History stays. Other outside requests still wait for your decision.", waitBody: "A late reply will not resume this work. Other outside requests still wait for your decision.", title: "Request-based contact approvals", on: "On: approval applies only to this request.",
    off: "Off. Your own messages go through as usual; requests that came from outside wait for your decision.",
    offBefore: "Not enabled. Contacts haven't changed.",
    draining: "Turning off. Waiting for current work to finish.", blocked: "Request-based approvals are waiting.",
    recoveryBlocked: "Request-based approvals need your attention.",
    confirmTitle: "Turn off request-based approvals?", confirm: "Confirm turn off",
    confirmBody: "New outside requests will wait while current work finishes. Then your own messages go through as usual; outside requests wait for your decision.",
    legacy: "Resolve these earlier held messages first: {0}.", peers: "Update AgEnD Runtime on these Windows computers, then reconnect: {0}.",
    owners: "These agents need to finish their current work or complete their AgEnD update: {0}. Then check again.", recovery: "This work needs your decision: {0}.",
    returns: "Waiting for a reply: {0}.", tickets: "Resolve these held messages: {0}.", work: "Waiting for this work to finish: {0}.",
    previous: "The previous rules still apply.", floor: "You can no longer downgrade to older AgEnD versions.",
    floorBefore: "Warning: once enabled, you cannot downgrade to older AgEnD versions (they cannot read this Fleet's data), even after turning it off.",
    check: "Check again", error: "Couldn't read the current state. Try again.", failed: "Couldn't confirm whether anything changed. Press Check again.",
    notice: "Request-based contact approvals are on: approval applies only to this request. Earlier conversations won't block an administrator's new request. The switch is in Settings → Access & security. Warning: you can no longer downgrade to older AgEnD versions.",
    open: "Open settings", loading: "Checking the current state…",
    "stop-waiting": "End this wait", decline: "Decline", withdraw: "Withdraw", "stop-work": "Stop this work",
  },
  "zh-TW": {
    goBack: "也會結束最近一次更新的「退回上一版」（原本可用到 {0}）。", enableTitle: "開啟依請求核准聯絡？", enable: "確認開啟", unknown: "狀態不明", inspect: "查看擱置的訊息", update: "請先完成或處理 AgEnD 更新，再重新檢查。", stopTitle: "結束這項工作？", stopBody: "這會結束已儲存的工作，不會再繼續執行。歷史會保留，其他外部請求仍會等你決定。", waitBody: "之後的回覆不會再繼續這項工作；其他外部請求仍會等你決定。", title: "依請求核准聯絡", on: "已開啟：核准只對這一次請求有效。",
    off: "已關閉。你自己的訊息照常；從外部來的請求會等你決定。",
    offBefore: "尚未開啟，聯絡方式沒有變更。",
    draining: "正在關閉，等目前的工作結束。", blocked: "依請求核准聯絡尚未開啟。",
    recoveryBlocked: "依請求核准聯絡需要你處理。",
    confirmTitle: "關閉依請求核准聯絡？", confirm: "確認關閉",
    confirmBody: "新的外部請求會先等候，直到目前的工作結束。之後，你自己的訊息照常；從外部來的請求會等你決定。",
    legacy: "請先處理這些先前擱置的訊息：{0}。", peers: "請先更新這些 Windows 電腦上的 AgEnD Runtime，再重新連線：{0}。",
    owners: "這些 Agent 需要先結束目前的工作，或完成 AgEnD 更新：{0}。完成後請重新檢查。", recovery: "這項工作需要你決定：{0}。",
    returns: "正在等候回覆：{0}。", tickets: "請先處理這些擱置的訊息：{0}。", work: "正在等這項工作結束：{0}。",
    previous: "目前仍使用原本的規則。", floor: "已不能再降回舊版 AgEnD。",
    floorBefore: "注意：開啟後就不能再降回舊版 AgEnD（舊版讀不了這個機群的資料），之後關閉也一樣。",
    check: "重新檢查", error: "無法讀取目前狀態，請再試一次。", failed: "無法確認是否已變更，請按「重新檢查」。",
    notice: "依請求核准聯絡已開啟：核准只對這一次請求有效，先前的對話不會再擋住管理員的新請求。開關在「設定」→「存取與安全」。注意：已不能再降回舊版 AgEnD。",
    open: "開啟設定", loading: "正在確認目前狀態…",
    "stop-waiting": "結束這次等候", decline: "拒絕", withdraw: "撤回", "stop-work": "結束這項工作",
  },
});
export const requestContextControlText = (key, ...args) => t(`requestContextControl.${key}`, ...args);
export function requestContextBlockerText(blocker) {
  return requestContextControlText(blocker.kind, (blocker.labels || []).join(lang() === "zh-TW" ? "、" : ", "));
}
export function RequestContextBlocked({ state, onCheck, onResolve, busy = false }) {
  if (!state || !state.everActivated && !state.attempted) return null;
  return html`<div class="request-context-blocked">
    <p>${requestContextControlText(state.phase === "draining" ? "draining" : state.everActivated ? "recoveryBlocked" : "blocked")}</p>
    ${(state.blockers || []).map(blocker => html`<div class="request-context-blocker" key=${blocker.id}><p>${requestContextBlockerText(blocker)}</p>
      ${blocker.action === "inspect" ? html`<a class="btn btn-sm" href="/ui/fleet/authorizations">${requestContextControlText("inspect")}</a>` : null}
      ${blocker.action === "stop-waiting" ? html`<p>${requestContextControlText("waitBody")}</p>` : null}
      ${state.canChange && onResolve && blocker.action && blocker.action !== "inspect" ? html`<button type="button" class=${`btn btn-sm ${blocker.action === "stop-work" ? "btn-danger" : ""}`} disabled=${busy}
        onClick=${() => onResolve(blocker)}>${requestContextControlText(blocker.action)}</button>` : null}</div>`)}
    ${!state.everActivated ? html`<p class="note">${requestContextControlText("previous")}</p>` : null}
    ${onCheck ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${onCheck}>${requestContextControlText("check")}</button>` : null}
  </div>`;
}
/** Passive Needs-you payload, from the same owner status as Settings. No background GET or timer. */
export function RequestContextNeed({ item }) {
  const lease = useLease(`request-context-need:${item.id}`), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), writing = useRef(false);
  const state = item.requestContextCutover;
  useEffect(() => { setFailed(false); }, [state?.revision]);
  const change = async (blocker = null) => {
    if (writing.current || failed || !state || blocker && !state.canChange) return;
    writing.current = true; setBusy(true); setFailed(false);
    try {
      if (blocker?.action === "stop-work" && !await confirmStopWork()) return;
      const input = blocker ? { revision: state.revision, action: "resolve", blockerId: blocker.id, resolution: blocker.action } : { revision: state.revision, action: "check" };
      const response = await lease.fetch("/api/settings/request-context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      if (!lease.current()) return;
      if (!response.ok && response.status !== 409) throw Error("refused");
    } catch { if (lease.current()) setFailed(true); }
    finally { writing.current = false; if (lease.current()) setBusy(false); }
  };
  return html`<article class="card request-context-need"><h3>${requestContextControlText("title")}</h3>
    <${RequestContextBlocked} state=${state} busy=${busy || failed} onCheck=${() => change()} onResolve=${state?.canChange ? change : null} />
    ${state && !state.canChange ? html`<${AuthorizeChip} />` : null}
    ${failed ? html`<p class="notice warn" role="alert">${requestContextControlText("failed")}</p>` : null}
    <a class="btn btn-sm" href="/settings/access#request-context">${requestContextControlText("open")}</a></article>`;
}
async function confirmStopWork() { return confirmDialog({ title: requestContextControlText("stopTitle"), message: requestContextControlText("stopBody"), confirmLabel: requestContextControlText("stop-work"), danger: true }); }
export function RequestContextSettings() {
  const lease = useLease("request-context-control"), [state, setState] = useState(undefined), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);
  const toggle = useRef(null);
  useEffect(() => { if (toggle.current) toggle.current.indeterminate = failed; }, [failed, state]);
  const writing = useRef(false), lastRevision = useRef(-1), { requestContextCutover: pushed } = useStore(appStore);
  const accept = value => {
    if (value !== null) {
      if (!Number.isSafeInteger(value?.revision) || value.revision < lastRevision.current) return;
      lastRevision.current = value.revision;
    }
    setState(value); setFailed(false);
  };
  const load = async () => {
    try {
      const response = await lease.fetch("/api/settings/request-context"), value = response.status === 404 ? null : await response.json();
      if (!lease.current()) return;
      if (response.status !== 404 && !response.ok) throw Error("unavailable");
      accept(value);
    } catch { if (lease.current()) setFailed(true); }
  };
  useEffect(() => { void load(); }, [lease]);
  useEffect(() => { if (pushed !== undefined && lease.current()) accept(pushed); }, [pushed, lease]);
  const change = async (action, blocker = null) => {
    if (writing.current || failed || !state || action !== "check" && !state.canChange) return;
    writing.current = true; setBusy(true); setFailed(false);
    try {
      if (action === "enable" && !await confirmDialog({ title: requestContextControlText("enableTitle"), message: requestContextControlText("floorBefore") + (state.goBack ? "\n\n" + requestContextControlText("goBack", new Intl.DateTimeFormat(lang() === "zh-TW" ? "zh-TW" : "en", { dateStyle: "medium", timeStyle: "short", timeZone: state.goBack.timeZone }).format(new Date(state.goBack.availableUntil))) : ""), confirmLabel: requestContextControlText("enable"), danger: true })) return;
      if (blocker?.action === "stop-work" && !await confirmStopWork()) return;
      if (action === "disable" && !await confirmDialog({ title: requestContextControlText("confirmTitle"), message: requestContextControlText("confirmBody"), confirmLabel: requestContextControlText("confirm"), danger: true })) return;
      if (!lease.current()) return;
      const response = await lease.fetch("/api/settings/request-context", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(blocker ? { revision: state.revision, action: "resolve", blockerId: blocker.id, resolution: blocker.action } : { revision: state.revision, action }) });
      if (!lease.current()) return;
      if (response.status === 409) { await load(); return; }
      if (!response.ok) throw Error("refused");
      const value = await response.json(); if (lease.current()) accept(value);
    } catch { if (lease.current()) setFailed(true); }
    finally { writing.current = false; if (lease.current()) setBusy(false); }
  };
  if (state === null) return null;
  return html`<section id="request-context" class="card request-context-control"><h2>${requestContextControlText("title")}</h2>
    ${state ? html`<label class="check request-context-toggle"><input type="checkbox" class="s-ui-toggle" ref=${toggle} aria-checked=${failed ? "mixed" : state.enabled ? "true" : "false"} checked=${!failed && state.enabled}
      disabled=${busy || failed || !state.canChange || state.phase === "draining"} onChange=${event => { event.target.checked = state.enabled; void change(state.enabled ? "disable" : "enable"); }} />
      <span>${requestContextControlText("title")}</span></label>
      ${failed ? html`<p role="status">${requestContextControlText("unknown")}</p>` : ["blocked", "draining"].includes(state.phase) ? html`<${RequestContextBlocked} state=${state} busy=${busy || failed} onCheck=${() => change("check")} onResolve=${state.canChange ? blocker => change("resolve", blocker) : null} />`
        : html`<p role="status">${requestContextControlText(state.phase === "off" && !state.everActivated ? "offBefore" : state.phase)}</p>`}
      <p class="notice warn">${requestContextControlText(state.everActivated ? "floor" : "floorBefore")}</p>
      ${!state.canChange ? html`<${AuthorizeChip} />` : null}` : !failed ? html`<p>${requestContextControlText("loading")}</p>` : null}
    ${failed ? html`<p class="notice warn" role="alert">${requestContextControlText(state ? "failed" : "error")}</p><button class="btn btn-sm" type="button" disabled=${busy} onClick=${load}>${requestContextControlText("check")}</button>` : null}
  </section>`;
}
