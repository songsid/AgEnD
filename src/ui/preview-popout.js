// M-3438: presentation only. Each new window authenticates and reads its own history.
// Only a bounded locator crosses the existing exact-window protocol; never HTML, credentials or permissions.
import { appStore } from "/assets/app-store.js";
import { assetUrl } from "/assets/asset-url.js";
import { Shell, shellStore } from "/assets/app-shell.js";
import { isSafeInstanceName } from "/assets/app-route.js";
import { register, t } from "/assets/app-i18n.js";
import { toast } from "/assets/ui-toast.js";
import { loadHtmlAttachment } from "/assets/html-attachment.js";
import * as Panel from "/assets/preview-panel.js";
import * as Transport from "./chat-popout-transport.js";

register("previewPopout", {
  en: { open: "Pop out preview", blocked: "Your browser blocked the window. Allow pop-ups for this site, then try again. The original preview is unchanged.",
    retained: "The preview could not be opened in the new window. The original preview has been kept.", busy: "A preview window is already opening." },
  "zh-TW": { open: "彈出預覽視窗", blocked: "瀏覽器封鎖了新視窗。請允許這個網站開啟彈出視窗，再試一次。原本的預覽不變。",
    retained: "無法在新視窗開啟預覽，已保留原本的預覽。", busy: "正在開啟預覽視窗。" },
});
register("chat", { en: { pvPopout: "Pop out preview" }, "zh-TW": { pvPopout: "彈出預覽視窗" } });
const notify = reason => toast(t("previewPopout." + reason), false);
const safeKey = value => typeof value === "string" && value.length <= 256 && /^[a-zA-Z0-9_-]+-[0-9]+$/.test(value);
export function validPreviewLocator(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !safeKey(value.msgKey)) return false;
  const keys = Object.keys(value).sort().join(",");
  return keys === "msgKey,n" ? Number.isInteger(value.n) && value.n >= 0 && value.n < 1000
    : keys === "attachmentId,msgKey" && typeof value.attachmentId === "string" && /^[a-f0-9]{32}$/.test(value.attachmentId);
}
export function previewLocator(open) {
  if (!open || open.kind !== "html" || !isSafeInstanceName(open.instance)) return null;
  const locator = open.att ? { msgKey: open.msgKey, attachmentId: open.att.id } : { msgKey: open.msgKey, n: open.n };
  return validPreviewLocator(locator) ? locator : null;
}
export function previewSpecFromHistory(name, locator, messages) {
  if (!isSafeInstanceName(name) || !validPreviewLocator(locator)) return null;
  const row = (Array.isArray(messages) ? messages : []).find(x =>
    x.instance === name && x.role === "agent" && x.boot + "-" + x.id === locator.msgKey);
  if (!row) return null;
  const common = { instance: name, msgKey: locator.msgKey, sender: row.sender, ts: row.ts };
  if (Object.hasOwn(locator, "n")) {
    const fence = globalThis.AgendChatRender.htmlFences(row.text)[locator.n];
    return fence?.terminated ? { ...common, key: locator.msgKey + ":f" + locator.n, n: locator.n, code: fence.code } : null;
  }
  const att = (row.attachments || []).find(a => a.id === locator.attachmentId && globalThis.AgendChatRender.isHtmlAttachment(a));
  return att ? { ...common, key: locator.msgKey + ":a" + att.id, att: { id: att.id, name: att.name, size: att.size }, code: null } : null;
}
export async function readPreviewSpec(chat, name, locator, current) {
  if (!validPreviewLocator(locator) || !current()) return null;
  await chat.store.findQuoted(name, locator.msgKey); // Existing endpoint, archive limits and audience checks.
  if (!current()) return null;
  let spec = previewSpecFromHistory(name, locator, chat.store.state.msgs[name]);
  if (spec?.att) {
    // Read through the existing same-origin attachment loader. Launch still has its own size/opt-in gate.
    const read = await loadHtmlAttachment(spec.att, undefined, { anyway: true });
    if (!current() || !read.ok) return null;
    spec = { ...spec, code: read.code };
  }
  return current() ? spec : null;
}

let styles;
function loadStyles() {
  return styles ??= new Promise(resolve => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = assetUrl("/assets/preview-popout.css");
    link.onload = () => resolve(true); link.onerror = () => resolve(false); document.head.appendChild(link);
  });
}
const supported = () => Shell.popoutVersion === 1 && typeof Panel.previewHostReady === "function"
  && typeof Transport.createPreviewPopoutTransport === "function" && typeof Transport.receivePreviewPopout === "function";
const requested = win => new URL(win.location.href).searchParams.get("presentation") === "preview";
const auth = () => globalThis.AgendAuth;
const visible = name => appStore.get().ready && appStore.get().instances.some(x => x.name === name) && !auth()?.sessionEnded?.();
let leavePresentation = null;
export function leavePreviewWindow() { leavePresentation?.(); }

/** Prepared before offering the control, so window.open remains in its actual click stack. */
export async function createPreviewPopout(name, win = window) {
  if (!supported() || !isSafeInstanceName(name) || requested(win)) return null;
  const [css, scope] = await Promise.all([loadStyles(), auth()?.sessionHandle?.()]);
  if (!css || !scope || !visible(name)) return null;
  let alive = true;
  const transport = Transport.createPreviewPopoutTransport({ win, scope, notify });
  const off = auth()?.onSessionEnd?.(() => { alive = false; transport.close(); });
  return {
    open(open) {
      const payload = previewLocator(open);
      const current = () => alive && visible(name) && open.instance === name && Panel.panelStore.get().open === open;
      if (!payload || !current()) return false;
      return transport.open({ name, payload, current, complete() {
        if (!current()) return false; Panel.closePanel(); return true;
      } });
    },
    close() { alive = false; transport.close(); if (typeof off === "function") off(); },
  };
}

export async function installPreviewWindow({ nav, chat, win = window }) {
  const stamp = nav.navStore.get(), route = stamp.route, name = route?.instance;
  if (!supported() || !requested(win) || route?.panel !== "chat" || !isSafeInstanceName(name) || !win.opener) return null;
  const [css, scope] = await Promise.all([loadStyles(), auth()?.sessionHandle?.()]);
  if (!css || !scope) return null;
  let alive = true, showing = false;
  const current = () => alive && nav.navStore.get() === stamp && !auth()?.sessionEnded?.();
  const leave = () => {
    if (!showing) return; showing = false;
    delete document.documentElement.dataset.previewWindow;
    shellStore.set({ popout: false, popoutHeader: null });
    const url = new URL(win.location.href); url.searchParams.delete("presentation");
    win.history.replaceState(win.history.state, "", url.pathname + url.search + url.hash);
  };
  const stop = Transport.receivePreviewPopout({
    win, name, scope, notify, current,
    ready: () => current() && visible(name) && Panel.previewHostReady(name),
    accept: async (locator, withinDeadline) => {
      const fresh = () => current() && withinDeadline();
      const spec = await readPreviewSpec(chat, name, locator, fresh);
      if (!spec || !fresh()) return false;
      showing = true; leavePresentation = leave;
      document.documentElement.dataset.previewWindow = "1";
      shellStore.set({ popout: true, popoutHeader: null, drawer: false });
      Panel.openPanel(spec, { run: true }); // The explicit pop-out click; existing availability/opt-in/size gates still own launch.
      return true;
    },
  });
  const panelOff = Panel.panelStore.subscribe(s => { if (showing && !s.open) leave(); });
  const navOff = nav.navStore.subscribe(() => { if (nav.navStore.get() !== stamp) close(); });
  let authOff = null;
  authOff = auth()?.onSessionEnd?.(() => { Panel.closePanel(); close(); });
  function close() {
    if (!alive) return; alive = false; stop(); leave(); panelOff(); navOff();
    if (leavePresentation === leave) leavePresentation = null;
    if (typeof authOff === "function") authOff();
  }
  return { close };
}
