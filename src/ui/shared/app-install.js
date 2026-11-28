// S-255: install the dashboard or the Hub as an app. The page registers /sw.js (web-icons.ts: no fetch handler and no
// cache, so no API answer or chat is ever stored by it) and keeps the browser's install offer for a button:
// - Chrome/Edge make the offer (beforeinstallprompt) only where the page could be installed: localhost, or https with a
//   certificate the browser trusts. The button installs.
// - Safari on iPhone/iPad has no offer: the words say Share → Add to Home Screen.
// - An https page whose certificate the browser doesn't trust (a Hub's self-signed one) cannot register the worker
//   (SecurityError), and a plain-http LAN address isn't a secure context: the words say why, never a prompt that fails.
// - Already running as the app, or a browser that offers nothing: no hint at all.
import { html } from "./app-html.js";
import { createStore, useStore } from "./app-store.js";
import { register, t } from "./app-i18n.js";
import { Icon } from "./ui-icons.js";
import { confirmDialog } from "./ui-confirm.js";

register("install", {
  en: {
    title: "Install as an app",
    available: "Opens in its own window, from your Start menu, Dock or home screen.",
    install: "Install",
    short: "Install",
    ios: "In Safari, tap Share, then Add to Home Screen.",
    untrusted: "Can't be installed here: your browser doesn't trust this address's certificate. Ask your administrator for a trusted certificate, then open this page again.",
    insecure: "Can't be installed from a plain http:// address. Open it through localhost or an https:// address.",
    ok: "OK",
  },
  "zh-TW": {
    title: "安裝成應用程式",
    available: "在自己的視窗開啟，可從開始選單、Dock 或主畫面啟動。",
    install: "安裝",
    short: "安裝",
    ios: "在 Safari 點「分享」，再點「加入主畫面」。",
    untrusted: "這裡無法安裝：你的瀏覽器不信任這個網址的憑證。請管理員改用受信任的憑證後，再重新開啟這個頁面。",
    insecure: "一般 http:// 網址無法安裝。請改用 localhost 或 https:// 網址開啟。",
    ok: "知道了",
  },
});
const ti = (k) => t(`install.${k}`);

/** "available" | "ios" | "untrusted" | "insecure" | "installed" | "none" (nothing to say). */
export const installStore = createStore({ state: "none" });
let offer = null;
/** The windows already started (the app's one, or a test's own fake). */
const started = new WeakSet();

const standalone = (env) => {
  try { return env.matchMedia?.("(display-mode: standalone)")?.matches === true || env.navigator?.standalone === true; } catch { return false; }
};
/** Safari on iPhone/iPad (other iOS browsers can't add to the home screen in a way we can describe). */
const iosSafari = (env) => {
  const ua = env.navigator?.userAgent || "";
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (env.navigator?.maxTouchPoints || 0) > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
};
const set = (state) => installStore.set({ state });

/** Once per page, from the app's start: listen for the offer, register the worker, decide what to say. */
export function startInstall(env = globalThis) {
  if (started.has(env)) return;
  started.add(env);
  set("none");
  if (standalone(env)) { set("installed"); return; }
  env.addEventListener?.("beforeinstallprompt", (event) => { event.preventDefault(); offer = event; set("available"); });
  env.addEventListener?.("appinstalled", () => { offer = null; set("installed"); });
  // A plain-http address is not a secure context, and browsers hide the worker API there: say why before looking for it.
  if (env.isSecureContext === false) { if (installStore.get().state === "none") set("insecure"); return; }
  if (iosSafari(env)) set("ios");
  const sw = env.navigator?.serviceWorker;
  if (!sw) return;
  sw.register("/sw.js", { scope: "/" }).catch((error) => {
    // A certificate the browser doesn't trust: registration is refused as a SecurityError.
    if (error && error.name === "SecurityError" && ["none", "ios"].includes(installStore.get().state)) set("untrusted");
  });
}

/** The browser's own install dialog; afterwards the offer is spent (the browser may make a new one later). */
export async function promptInstall() {
  const event = offer;
  if (!event) return "none";
  offer = null;
  set("none");
  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice?.outcome === "accepted") set("installed");
    return choice?.outcome || "dismissed";
  } catch { return "dismissed"; }
}

const SAYS = new Set(["available", "ios", "untrusted", "insecure"]);
/** Whether there is anything to offer or say (a menu item or button shows only then). */
export const installOffered = (state) => SAYS.has(state);
export const installLabel = () => ti("title");
/** The one action, wherever it is offered: the browser's dialog where it can install; otherwise the reason, in a notice. */
export function runInstall(state = installStore.get().state) {
  if (state === "available") { void promptInstall(); return; }
  if (SAYS.has(state)) void confirmDialog({ title: ti("title"), message: ti(state), confirmLabel: ti("ok"), notice: true });
}

/** The Fleet's Needs you settings row, drawn like the notification row beside it. Nothing when there's nothing to say. */
export function InstallAppSection() {
  const { state } = useStore(installStore);
  if (!SAYS.has(state)) return null;
  return html`<article class="n-notify n-install" data-install=${state}>
    <span class="n-notify-icon"><${Icon} name="install" size=${18} /></span>
    <div class="n-notify-body">
      <div class="n-notify-title"><strong>${ti("title")}</strong></div>
      <p class="n-notify-note note">${ti(state)}</p>
      ${state === "available" ? html`<div class="n-notify-actions"><button type="button" class="btn btn-sm btn-primary" onClick=${() => { void promptInstall(); }}>
        <${Icon} name="install" size=${14} />${ti("install")}</button></div>` : null}
    </div>
  </article>`;
}

/** The Hub header's compact button: installs where it can, otherwise says how or why not. */
export function InstallAppButton() {
  const { state } = useStore(installStore);
  if (!SAYS.has(state)) return null;
  // Its name and tooltip are what it does (the leader's capture check: a bare arrow by the bell read as "download notices").
  const label = ti("title");
  const click = () => runInstall(state);
  return html`<button type="button" class="icon-btn hub-install" data-install=${state} aria-label=${label} title=${label} onClick=${click}>
    <${Icon} name="install" size=${16} /><span class="hub-install-label" aria-hidden="true">${ti("short")}</span></button>`;
}
