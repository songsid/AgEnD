// S-257 step 1 (M-3828): turn Hub notifications on, and the first time they go on on this device, say what keeps them
// coming once every Hub window is closed — the installed app left running, or started at sign-in (S-255).
// Its own module and its own strings (Prism #4548): a tab that still holds an older hub-room-notify.js or
// hub-room-strings.js (cached by URL) loads this new file fresh, so nothing here depends on what those files export.
import { setNotify } from "/assets/app-needs.js";
import { installStore } from "/assets/app-install.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { register, t } from "/assets/app-i18n.js";

register("hubkeep", {
  en: {
    title: "Keep notifications coming",
    tab: "Notifications arrive while a Hub tab is open, even in the background; closing every Hub tab stops them. To keep them coming, install the Hub as an app (the button beside the bell) and leave it running, minimized is fine. In Edge or Chrome, the app's settings also offer \"Start app when you sign in\".",
    app: "Notifications arrive while this app is open, even minimized; quitting it stops them. Leave it running. In Edge or Chrome, the app's settings offer \"Start app when you sign in\", so it is there after a restart.",
    noInstall: "Notifications arrive while a Hub tab is open, even in the background; closing every Hub tab stops them. Keep a Hub tab open. This Hub can't be installed as an app yet: its address doesn't have a certificate your company's computers trust (the button beside the bell says more).",
    ok: "OK",
  },
  "zh-TW": {
    title: "持續收到通知",
    tab: "Hub 分頁開著時（在背景也可以）會收到通知；關掉所有 Hub 分頁後就不會再通知。想一直收到，可以把 Hub 安裝成應用程式（鈴鐺旁的按鈕）並讓它保持開著，縮到最小也可以。在 Edge 或 Chrome 的應用程式設定中，也可以開啟「登入時啟動應用程式」。",
    app: "這個應用程式開著時（縮到最小也可以）會收到通知；把它關掉就不會再通知。請讓它保持開著。在 Edge 或 Chrome 的應用程式設定中，可以開啟「登入時啟動應用程式」，重新開機後也會自動開啟。",
    noInstall: "Hub 分頁開著時（在背景也可以）會收到通知；關掉所有 Hub 分頁後就不會再通知。請讓一個 Hub 分頁保持開著。這個 Hub 目前還不能安裝成應用程式：它的網址還沒有公司認可的憑證（鈴鐺旁的按鈕有說明）。",
    ok: "知道了",
  },
});
const tk = (k) => t(`hubkeep.${k}`);

const KEEP_HINT_KEY = "agend_hub_notify_kept";
/** Shown on this page already (when the browser's storage refuses, it is still shown once per page). */
let shownHere = false;
/** Tests only (a new page starts with nothing shown); nothing in the app calls it. */
export function forgetKeepHint() { shownHere = false; }
function firstTime() {
  if (shownHere) return false;
  shownHere = true;
  try { if (localStorage.getItem(KEEP_HINT_KEY) === "1") return false; localStorage.setItem(KEEP_HINT_KEY, "1"); } catch { /* this page only */ }
  return true;
}

/** Notify on or off (app-needs.js setNotify); the first "on" on this device also says how to keep notifications coming. */
export async function setHubNotify(on) {
  const state = await setNotify(on);
  if (!on || state !== "on" || !firstTime()) return state;
  // In the app: leave it running. A Hub that can't be installed here (an untrusted certificate, plain http): keep a tab.
  const where = installStore.get().state;
  const words = where === "installed" ? "app" : where === "untrusted" || where === "insecure" ? "noInstall" : "tab";
  void confirmDialog({ title: tk("title"), message: tk(words), confirmLabel: tk("ok"), notice: true });
  return state;
}
