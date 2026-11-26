// S-230: the owner switch. Status comes from the host, never from a browser preference or an agent argument.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { lang, register, t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { AuthorizeChip } from "/assets/web-authorize.js";

register("requestContextControl", {
  en: {
    title: "Request-based contact approvals", on: "On. Approvals follow each request.",
    off: "Off. Your own messages go through as usual; requests that came from outside wait for your decision.",
    offBefore: "Not enabled. Contacts haven't changed.",
    draining: "Turning off. Waiting for current work to finish.", blocked: "Request-based approvals are waiting.",
    confirmTitle: "Turn off request-based approvals?", confirm: "Turn off",
    confirmBody: "New outside requests will wait while current work finishes. Then your own messages go through as usual; outside requests wait for your decision.",
    legacy: "Resolve the earlier held messages first.", peers: "Update or reconnect these runtimes: {0}.",
    owners: "These agents aren't ready yet: {0}.", recovery: "This work needs your decision: {0}.",
    returns: "Waiting for a reply: {0}.", tickets: "Resolve these held messages: {0}.", work: "Waiting for this work to finish: {0}.",
    previous: "The previous rules still apply.", floor: "Older versions cannot open this Fleet's data, even after you turn this off.",
    floorBefore: "Once this turns on, older versions can no longer open this Fleet's data, even after Off.",
    check: "Check again", error: "Couldn't read the current state. Try again.", failed: "Nothing changed. Refresh and try again.",
    notice: "Contact approvals now follow each request. Earlier conversations won't block an administrator's new request. The switch is in Settings → Access & security → Request-based contact approvals. Older versions cannot open this Fleet's data, even after you turn it off.",
    open: "Open settings", loading: "Checking the current state…",
    "stop-waiting": "Stop waiting", decline: "Decline", withdraw: "Withdraw", "stop-work": "Stop this work",
  },
  "zh-TW": {
    title: "依請求核准聯絡", on: "已開啟。核准只跟著這次請求。",
    off: "已關閉。你自己的訊息照常；從外部來的請求會等你決定。",
    offBefore: "尚未開啟，聯絡方式沒有變更。",
    draining: "正在關閉，等目前的工作結束。", blocked: "依請求核准尚未開啟。",
    confirmTitle: "關閉依請求核准聯絡？", confirm: "關閉",
    confirmBody: "新的外部請求會先等候，直到目前的工作結束。之後，你自己的訊息照常；從外部來的請求會等你決定。",
    legacy: "請先處理先前擱置的訊息。", peers: "請先更新或重新連線這些執行環境：{0}。",
    owners: "這些 Agent 尚未準備好：{0}。", recovery: "這項工作需要你決定：{0}。",
    returns: "正在等候回覆：{0}。", tickets: "請先處理這些擱置的訊息：{0}。", work: "正在等這項工作結束：{0}。",
    previous: "目前仍使用原本的規則。", floor: "即使關閉，舊版也無法再開啟這個機群的資料。",
    floorBefore: "開啟過一次後，即使關閉，舊版也無法再開啟這個機群的資料。",
    check: "重新檢查", error: "無法讀取目前狀態，請再試一次。", failed: "沒有變更，請重新整理後再試一次。",
    notice: "聯絡核准現在只跟著這次請求。先前的對話不會再擋住管理員的新請求。開關在「設定」→「存取與安全」→「依請求核准聯絡」。即使關閉，舊版也無法再開啟這個機群的資料。",
    open: "開啟設定", loading: "正在確認目前狀態…",
    "stop-waiting": "不再等候", decline: "拒絕", withdraw: "撤回", "stop-work": "結束這項工作",
  },
});
export const requestContextControlText = (key, ...args) => t(`requestContextControl.${key}`, ...args);
export function requestContextBlockerText(blocker) {
  return requestContextControlText(blocker.kind, (blocker.labels || []).join(lang() === "zh-TW" ? "、" : ", "));
}
export function RequestContextBlocked({ state, onCheck, onResolve, busy = false }) {
  if (!state) return null;
  return html`<div class="request-context-blocked">
    <p>${requestContextControlText(state.phase === "draining" ? "draining" : "blocked")}</p>
    ${(state.blockers || []).map(blocker => html`<div key=${blocker.id}><p>${requestContextBlockerText(blocker)}</p>
      ${state.canChange && onResolve && blocker.action && blocker.action !== "inspect" ? html`<button type="button" class="btn btn-sm" disabled=${busy}
        onClick=${() => onResolve(blocker)}>${requestContextControlText(blocker.action)}</button>` : null}</div>`)}
    ${!state.everActivated ? html`<p class="note">${requestContextControlText("previous")}</p>` : null}
    ${onCheck ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${onCheck}>${requestContextControlText("check")}</button>` : null}
  </div>`;
}
/** Passive Needs-you payload, from the same owner status as Settings. No background GET or timer. */
export function RequestContextNeed({ item }) {
  const lease = useLease(`request-context-need:${item.id}`), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), writing = useRef(false);
  const state = item.requestContextCutover;
  const change = async (blocker = null) => {
    if (writing.current || !state?.canChange) return;
    writing.current = true; setBusy(true); setFailed(false);
    try {
      const input = blocker ? { revision: state.revision, action: "resolve", blockerId: blocker.id, resolution: blocker.action } : { revision: state.revision, action: "check" };
      const response = await lease.fetch("/api/settings/request-context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      if (!lease.current()) return;
      if (!response.ok && response.status !== 409) throw Error("refused");
    } catch { if (lease.current()) setFailed(true); }
    finally { writing.current = false; if (lease.current()) setBusy(false); }
  };
  return html`<article class="card request-context-need"><h3>${requestContextControlText("title")}</h3>
    <${RequestContextBlocked} state=${state} busy=${busy} onCheck=${state?.canChange ? () => change() : null} onResolve=${state?.canChange ? change : null} />
    ${state && !state.canChange ? html`<${AuthorizeChip} />` : null}
    ${failed ? html`<p class="notice warn" role="alert">${requestContextControlText("failed")}</p>` : null}
    <a class="btn btn-sm" href="/settings/access#request-context">${requestContextControlText("open")}</a></article>`;
}
export function RequestContextSettings() {
  const lease = useLease("request-context-control"), [state, setState] = useState(undefined), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);
  const writing = useRef(false), { requestContextCutover: pushed } = useStore(appStore);
  const load = async () => {
    setFailed(false);
    try {
      const response = await lease.fetch("/api/settings/request-context"), value = response.status === 404 ? null : await response.json();
      if (!lease.current()) return;
      if (response.status !== 404 && !response.ok) throw Error("unavailable");
      setState(value);
    } catch { if (lease.current()) setFailed(true); }
  };
  useEffect(() => { void load(); }, [lease]);
  useEffect(() => { if (pushed !== undefined && lease.current()) setState(pushed); }, [pushed, lease]);
  const change = async (action, blocker = null) => {
    if (writing.current || !state || !state.canChange) return;
    writing.current = true; setBusy(true); setFailed(false);
    try {
      if (action === "disable" && !await confirmDialog({ title: requestContextControlText("confirmTitle"), message: requestContextControlText("confirmBody"), confirmLabel: requestContextControlText("confirm"), danger: true })) return;
      if (!lease.current()) return;
      const response = await lease.fetch("/api/settings/request-context", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(blocker ? { revision: state.revision, action: "resolve", blockerId: blocker.id, resolution: blocker.action } : { revision: state.revision, action }) });
      if (!lease.current()) return;
      if (response.status === 409) { await load(); return; }
      if (!response.ok) throw Error("refused");
      const value = await response.json(); if (lease.current()) setState(value);
    } catch { if (lease.current()) setFailed(true); }
    finally { writing.current = false; if (lease.current()) setBusy(false); }
  };
  if (state === null) return null;
  return html`<section id="request-context" class="card request-context-control"><h2>${requestContextControlText("title")}</h2>
    ${state ? html`<label class="check request-context-toggle"><input type="checkbox" class="s-ui-toggle" checked=${state.enabled}
      disabled=${busy || !state.canChange || state.phase === "draining"} onChange=${event => { event.target.checked = state.enabled; void change(state.enabled ? "disable" : "enable"); }} />
      <span>${requestContextControlText("title")}</span></label>
      ${["blocked", "draining"].includes(state.phase) ? html`<${RequestContextBlocked} state=${state} busy=${busy} onCheck=${state.canChange ? () => change("check") : null} onResolve=${state.canChange ? blocker => change("resolve", blocker) : null} />`
        : html`<p role="status">${requestContextControlText(state.phase === "off" && !state.everActivated ? "offBefore" : state.phase)}</p>`}
      <p class="note">${requestContextControlText(state.everActivated ? "floor" : "floorBefore")}</p>
      ${!state.canChange ? html`<${AuthorizeChip} />` : null}` : !failed ? html`<p>${requestContextControlText("loading")}</p>` : null}
    ${failed ? html`<p class="notice warn" role="alert">${requestContextControlText(state ? "failed" : "error")}</p><button class="btn btn-sm" type="button" disabled=${busy} onClick=${load}>${requestContextControlText("check")}</button>` : null}
  </section>`;
}
