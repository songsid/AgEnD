/**
 * #2726: the setup pages in English and 繁體中文.
 *
 * Both pages are inline (setup-form.ts) and run before any fleet — no dashboard, no /assets — so they carry their own
 * small dictionary and the few lines that use it (SETUP_I18N_RUNTIME). The choice works as the dashboard's does
 * (src/ui/shared/app-i18n.js): the language chosen in this browser (`agend_lang`, the dashboard's own key, so the
 * dashboard opened afterwards on this address keeps it), else the browser's language; a toggle on the page changes it.
 * The wording is the dashboard's where it already says the same thing (settings-strings.js wizard*).
 *
 * What the host says (its errors) is English, or a code: src/ui/shared/setup-host-text.js says each one the page can show
 * in both languages — the same module the dashboard's Setup wizard uses. One it does not know is shown as it came.
 */

import { readFileSync } from "node:fs";

export type SetupLang = "en" | "zh-TW";
type Table = Record<string, string>;

/** The code-entry page: before the code, nothing about this machine (setup-form.ts SETUP_CODE_PAGE_HTML). */
export const SETUP_CODE_STRINGS: Record<SetupLang, Table> = {
  en: {
    title: "Set up AgEnD",
    otherLang: "中文",
    langTitle: "Language",
    lead: "Enter the setup code shown in the terminal where you ran {0}.",
    continue: "Continue",
    unreachable: "Could not reach the setup page.",
    notAccepted: "That code was not accepted.",
  },
  "zh-TW": {
    title: "設定 AgEnD",
    otherLang: "English",
    langTitle: "語言",
    lead: "請輸入執行 {0} 的終端機上顯示的設定代碼。",
    continue: "繼續",
    unreachable: "無法連到設定頁。",
    notAccepted: "這個代碼不正確。",
  },
};

/** The setup form (setup-form.ts SETUP_FORM_HTML). */
export const SETUP_FORM_STRINGS: Record<SetupLang, Table> = {
  en: {
    title: "Set up AgEnD",
    otherLang: "中文",
    langTitle: "Language",
    intro: "This page is open only while setup is running. It closes itself when you finish, or after 15 minutes.",
    signinsLabel: "AI backend sign-ins",
    stepAgent: "1 · Agent",
    backend: "Backend",
    backendFound: "Found on this host: {0}",
    backendNone: "No backend CLI found on this host — install one first.",
    dir: "Working directory (optional)",
    dirPlaceholder: "/home/you/projects/app",
    dirDefault: "Leave it empty and the agent gets its own folder, {0}, which AgEnD creates. A path you enter must be absolute.",
    dirDefaultName: "Leave it empty and the agent gets its own folder in AgEnD's workspaces, which AgEnD creates. A path you enter must be absolute.",
    name: "First agent name",
    generalNote: "This agent is the General: it answers in the chat's own General topic and hands work to the agents you add later.",
    stepPlatform: "2 · Platform",
    webOnly: "Web only (no bot)",
    hintTelegram: "Create a bot with @BotFather, then add it to a group.",
    hintDiscord: "Create an application in the Discord developer portal and invite the bot to your server.",
    hintWeb: "No bot: you use AgEnD from its web dashboard (chat, sign-ins, settings). Discord or Telegram can be added later in Settings.",
    stepCredentials: "3 · Credentials",
    token: "Bot token",
    tokenNote: "Written to ~/.agend/.env and never shown again.",
    tokenEnv: "Environment variable",
    verify: "Verify",
    verifying: "Asking the provider…",
    verified: "verified",
    rejected: "rejected",
    guild: "Server (guild)",
    general: "General channel id",
    discordAdmin: "Your Discord user id",
    telegramAdmin: "Your Telegram user id",
    firstAllowed: "Becomes the first allowed user.",
    group: "Group id",
    groupHint: "Or post any message in the group and press Detect.",
    detect: "Detect from a message",
    detectWaiting: "Waiting for a message in the group…",
    detectFound: "Found.",
    detectNone: "No group message yet — post one and press Detect again.",
    failed: "Failed.",
    stepReview: "4 · Review and start",
    preview: "Show what will be written",
    finish: "Create and start AgEnD",
    start: "Start AgEnD",
    reopen: "Reopen it where you started setup: in the Windows installer, press Enter in its window; otherwise run agend setup again on the computer running AgEnD.",
    closed: "This setup page has closed.",
    closedFinish: "This setup page has closed. {0} Backends you already signed in stay signed in.",
    closesIn: "This page closes in {0} at the latest (sooner after 10 minutes without activity).",
    closesSoon: "{0} Finish soon. If it closes first: {1}",
    approveHost: "Approve this on the computer running AgEnD. The Windows installer opens a confirmation window for it, and shows a command to paste if no window appears. Otherwise run there: agend settings confirm {0}",
    confirmGone: "Setup confirmation is no longer available. Review and enter the token again.",
    notApplied: "Change was not applied. Review and enter the token again.",
    confirmed: "Configuration confirmed. Select Start AgEnD to finish setup.",
    lostContact: "Lost contact with the setup page; still trying. If this stays, the page has closed. {0}",
    finishSignins: "Finish backend sign-in or choose Sign in later before continuing.",
    notCurrent: "Confirmation is no longer current.",
    startingWeb: "AgEnD is starting. Its dashboard link shows here once it is up.",
    startingChat: "AgEnD is starting. Continue in the channel you configured.",
    requesting: "Requesting host confirmation…",
    expectedPending: "Expected a pending host confirmation.",
    connectionFailed: "Connection failed. Retry to find the same confirmation.",
    upWeb: "AgEnD is up. Open its dashboard: {0} — sign in with the code from agend web --code on the machine running AgEnD. Sign your agents' CLIs in from Settings → Agents → Sign-ins.",
    upChat: "AgEnD is up. Talk to it in the channel you just set up, or open its dashboard: {0} (sign in with agend web --code on the machine running AgEnD, or send /web to your bot).",
    notUp: "AgEnD has not come up within 60 seconds. Run `agend start` on the machine itself and check fleet.log — this page cannot tell you any more.",
    // A host confirmation's outcome (settings-confirmation.ts reason_code; the words of locale.ts settings_confirm.result.*).
    outcome_apply_failed: "Change could not be applied. Review the configuration and try again.",
    outcome_fleet_stopped: "Fleet stopped. Review and apply again.",
    outcome_expired: "Confirmation expired. Review and apply again.",
    outcome_withdrawn: "Change withdrawn.",
    outcome_rejected: "Change rejected.",
    outcome_request_no_longer_current: "The requesting session or fleet changed. Review and apply again.",
    outcome_settings_changed: "Settings changed since this request. Review and apply again.",
  },
  "zh-TW": {
    title: "設定 AgEnD",
    otherLang: "English",
    langTitle: "語言",
    intro: "這個頁面只在設定進行時開啟。完成設定，或 15 分鐘後，它會自動關閉。",
    signinsLabel: "AI 後端登入",
    stepAgent: "1 · Agent",
    backend: "後端",
    backendFound: "在這台主機上找到：{0}",
    backendNone: "這台主機上找不到任何後端 CLI —— 請先安裝一個。",
    dir: "工作目錄（選填）",
    dirPlaceholder: "/home/you/projects/app",
    dirDefault: "留空的話，agent 會有自己的資料夾 {0}，由 AgEnD 建立。若要填寫，必須是絕對路徑。",
    dirDefaultName: "留空的話，agent 會在 AgEnD 的 workspaces 裡有自己的資料夾，由 AgEnD 建立。若要填寫，必須是絕對路徑。",
    name: "第一個 agent 名稱",
    generalNote: "這個 agent 就是 General：它在聊天本身的 General 主題回覆，並把工作分給你之後加入的 agent。",
    stepPlatform: "2 · 平台",
    webOnly: "只用網頁（不接 bot）",
    hintTelegram: "用 @BotFather 建立 bot，然後把它加進一個群組。",
    hintDiscord: "在 Discord 開發者後台建立應用程式，並把 bot 邀請到你的伺服器。",
    hintWeb: "不接 bot：從 AgEnD 的網頁儀表板使用它（聊天、登入、設定）。之後可以在設定裡再加上 Discord 或 Telegram。",
    stepCredentials: "3 · 憑證",
    token: "Bot token",
    tokenNote: "會寫入 ~/.agend/.env，之後不會再顯示。",
    tokenEnv: "環境變數",
    verify: "驗證",
    verifying: "正在向平台確認…",
    verified: "已驗證",
    rejected: "被拒絕",
    guild: "伺服器（guild）",
    general: "General 頻道 id",
    discordAdmin: "你的 Discord 使用者 ID",
    telegramAdmin: "你的 Telegram 使用者 ID",
    firstAllowed: "會成為第一個允許使用者。",
    group: "群組 id",
    groupHint: "或在群組裡發任一則訊息，然後按「從訊息偵測」。",
    detect: "從訊息偵測",
    detectWaiting: "等待群組訊息中…",
    detectFound: "找到了。",
    detectNone: "還沒收到群組訊息 —— 發一則之後再按一次。",
    failed: "失敗。",
    stepReview: "4 · 檢查並啟動",
    preview: "顯示將寫入的內容",
    finish: "建立並啟動 AgEnD",
    start: "啟動 AgEnD",
    reopen: "請在開始設定的地方重新開啟：Windows 安裝程式請在它的視窗按 Enter；否則在執行 AgEnD 的電腦上再執行一次 agend setup。",
    closed: "這個設定頁已關閉。",
    closedFinish: "這個設定頁已關閉。{0}已經登入的後端會維持登入。",
    closesIn: "這個頁面最晚在 {0} 後關閉（閒置 10 分鐘會更早關閉）。",
    closesSoon: "{0}請盡快完成。如果它先關閉了：{1}",
    approveHost: "請在執行 AgEnD 的電腦上核准。Windows 安裝程式會為它開一個確認視窗；沒有出現視窗時，會顯示一行可以貼上的指令。否則請在那台電腦上執行：agend settings confirm {0}",
    confirmGone: "設定確認已不存在。請重新檢查並再輸入一次 token。",
    notApplied: "變更沒有套用。請重新檢查並再輸入一次 token。",
    confirmed: "設定已確認。請按「啟動 AgEnD」完成設定。",
    lostContact: "與設定頁失去連線，仍在重試。如果一直如此，表示頁面已關閉。{0}",
    finishSignins: "請先完成後端登入，或選擇「稍後登入」再繼續。",
    notCurrent: "這個確認已不是最新的。",
    startingWeb: "AgEnD 正在啟動。啟動後，儀表板連結會顯示在這裡。",
    startingChat: "AgEnD 正在啟動。請到你設定的頻道繼續。",
    requesting: "正在請主機確認…",
    expectedPending: "預期會有一個等待主機確認的變更。",
    connectionFailed: "連線失敗。重試會找回同一個確認。",
    upWeb: "AgEnD 已啟動。打開它的儀表板：{0} —— 用執行 AgEnD 的電腦上 agend web --code 顯示的代碼登入。agent 的 CLI 請在 設定 → Agents → 登入 裡登入。",
    upChat: "AgEnD 已啟動。在你剛設定的頻道和它對話，或打開它的儀表板：{0}（在執行 AgEnD 的電腦上用 agend web --code 登入，或對你的 bot 傳 /web）。",
    notUp: "AgEnD 在 60 秒內沒有啟動。請在那台電腦上執行 `agend start` 並查看 fleet.log —— 這個頁面無法告訴你更多。",
    outcome_apply_failed: "變更無法套用。請檢查設定後再試一次。",
    outcome_fleet_stopped: "Fleet 已停止。請重新檢查後再套用。",
    outcome_expired: "確認已過期。請重新檢查後再套用。",
    outcome_withdrawn: "變更已撤回。",
    outcome_rejected: "變更已被拒絕。",
    outcome_request_no_longer_current: "提出請求的工作階段或 fleet 已改變。請重新檢查後再套用。",
    outcome_settings_changed: "提出請求後設定已被修改。請重新檢查後再套用。",
  },
};

/** #2726: the host's words and codes in both languages — one module, shared with the dashboard (pasted in below). */
const HOST_TEXT = readFileSync(new URL("./ui/shared/setup-host-text.js", import.meta.url), "utf8").replace(/^export /gm, "");


/**
 * The few lines both pages run first: the dictionary (JSON, `<` escaped so no string can end the script), the language,
 * `tr` (a key in it), `trHost` (a host message in it), `show` (a text that follows the language when it changes) and
 * `applyLang`. Plain script, no `${` and no template literal: it is pasted into the pages' own template strings.
 */
export function setupI18nRuntime(strings: Record<SetupLang, Table>): string {
  const tables = JSON.stringify({ en: strings.en, "zh-TW": strings["zh-TW"] }).replace(/</g, "\\u003c");
  return "const I18N = " + tables + ";\n" + HOST_TEXT + String.raw`
  let LANG = (() => {
    try { const chosen = localStorage.getItem("agend_lang"); if (chosen === "en" || chosen === "zh-TW") return chosen; } catch { /* none kept */ }
    return typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "") ? "zh-TW" : "en";
  })();
  const tr = (key, ...values) => {
    let text = I18N[LANG][key] ?? I18N.en[key] ?? key;
    values.forEach((value, i) => { text = text.split("{" + i + "}").join(String(value)); });
    return text;
  };
  // The host's own words or code in this page's language (setup-host-text.js); anything else as it came.
  const trHost = (text) => hostText(text, LANG);
  // A text that is redrawn in the new language when it changes: its last render per element.
  const shown = new Map();
  const show = (element, render) => { if (!element) return; shown.set(element, render); render(element); };
  const applyLang = () => {
    if (document.documentElement) document.documentElement.lang = LANG === "zh-TW" ? "zh-Hant" : "en";
    document.title = tr("title");
    for (const node of document.querySelectorAll("[data-i18n]")) { const key = node.getAttribute && node.getAttribute("data-i18n"); if (key) node.textContent = tr(key); }
    for (const node of document.querySelectorAll("[data-i18n-placeholder]")) { const key = node.getAttribute && node.getAttribute("data-i18n-placeholder"); if (key) node.placeholder = tr(key); }
    for (const node of document.querySelectorAll("[data-i18n-label]")) { const key = node.getAttribute && node.getAttribute("data-i18n-label"); if (key) node.setAttribute("aria-label", tr(key)); }
    for (const [element, render] of shown) render(element);
  };
  const langButton = document.getElementById("lang");
  if (langButton) langButton.onclick = () => {
    LANG = LANG === "zh-TW" ? "en" : "zh-TW";
    try { localStorage.setItem("agend_lang", LANG); } catch { /* this page only */ }
    applyLang();
  };
  applyLang();
`;
}
