// #3708: the words of the public link's own session limits (Settings → Access & security → Sign-in), in a file of their own
// for the reason settings-access-strings.js gives: settings-strings.js / settings-layout.js / settings-access-strings.js can
// already sit in an open tab from before the upgrade (Fleet and search import them), and the browser hands that old copy back
// to the new Settings page, so a key only a new copy had would read as the raw `settings.…` key. This file's URL is new.
// Every module that reads one of these keys imports it (panel-settings.js, settings-registry.js, search-dialog.js).
import { register } from "/assets/app-i18n.js";

register("settings", {
  en: {
    publicSessionTitle: "Over the public link",
    publicSessionAbsolute: "Session length, hours (1–168)",
    publicSessionIdle: "Sign out after unused for, minutes (5–1440)",
    publicSessionAbsoluteRange: "Must be a number of hours from 1 to 168",
    publicSessionIdleRange: "Must be a number of minutes from 5 to 1440",
    publicSessionIdleOver: "Must not exceed the public link's session length",
    publicSessionQuick: "quick tunnel: at most 8 h / 30 min",
    publicSessionNeedsHostname: "Longer than 30 minutes unused or 8 hours in all needs a fixed hostname (a named tunnel, under Sharing). On a quick tunnel the address is new each time and anyone who gets it can reach the sign-in page, so these values can only shorten the limits there.",
    publicSessionCeiling: "A session is also never longer than the account's own limits: an admin's the session length above, a guest's the guest settings. A link with an end time ends its sessions with it.",
    publicSessionTip: "A longer limit keeps a browser signed in to your fleet from the internet for longer. If a phone is lost or a browser is left signed in on a shared computer, whoever holds it can act as you until the session ends. Keep it short unless you use the dashboard from a phone often, and remove a lost device under Devices. Shortening ends the sessions it now outlives at once; lengthening needs your confirmation.",
    publicSessionHint: "For sign-ins at the dashboard's own address (this computer, the LAN, a tailnet). An admin's session over the public link also never lasts longer than these settings (a guest's follows the guest settings). Shortening ends the sessions it now outlives; lengthening applies to new sign-ins and to an existing one's idle time on its next use. Empty = the default.",
    publicSessionLimitNote: "Public-link sessions have their own limits below (8 hours, 30 minutes unused by default) and never outlive the link.",
  },
  "zh-TW": {
    publicSessionTitle: "透過公開連結",
    publicSessionAbsolute: "登入時效，小時（1–168）",
    publicSessionIdle: "閒置後登出，分鐘（5–1440）",
    publicSessionAbsoluteRange: "必須是 1 到 168 之間的小時數",
    publicSessionIdleRange: "必須是 5 到 1440 之間的分鐘數",
    publicSessionIdleOver: "不能超過公開連結的登入時效",
    publicSessionQuick: "臨時通道：最多 8 小時／30 分鐘",
    publicSessionNeedsHostname: "要超過閒置 30 分鐘或總共 8 小時，需要固定網域（具名通道，在「分享」設定）。臨時通道每次網址都不同，拿到網址的人都能打開登入頁，所以在臨時通道上這兩個值只能縮短限制。",
    publicSessionCeiling: "工作階段也不會超過該帳號本身的限制：管理員依上面的 session 時長，訪客依訪客設定。有結束時間的連結結束時，它的工作階段也一起結束。",
    publicSessionTip: "限制越長，瀏覽器透過網際網路保持登入你的 fleet 的時間就越久。如果手機遺失，或在共用電腦上忘了登出，拿到它的人在工作階段結束前都能以你的身分操作。除非你常用手機開儀表板，否則建議保持短一點；裝置遺失時，請到「裝置」移除它。縮短會立刻結束已超過新限制的工作階段；延長需要你確認。",
    publicSessionHint: "適用於從儀表板本身網址登入的 session（本機、區域網路、tailnet）。管理員透過公開連結的 session 也不會超過這裡的設定（訪客依訪客設定）。縮短會讓已超過新限制的 session 結束；延長會套用到新的登入，以及既有 session 下次使用時的閒置時間。留空 = 預設值。",
    publicSessionLimitNote: "公開連結的工作階段有自己的限制（預設 8 小時、閒置 30 分鐘，見下方），也不會超過連結期限。",
  },
});
