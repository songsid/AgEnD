// #1408 §4: one dictionary for the app, namespaced (app.*, chat.*, fleet.*, …). A panel registers its own namespace
// when it loads; t("chat.send") resolves it in the chosen language and falls back to English, then to the key.
// The language is the person's choice — kept on the host since #1665 and cached in this browser as agend_lang, the key
// every panel has used — else the device's.

const tables = { en: {}, "zh-TW": {} };
const listeners = new Set();

/** The device's own language: what applies when none is chosen. */
export function deviceLanguage() { return typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "") ? "zh-TW" : "en"; }
function cacheLang(v) { try { if (v) localStorage.setItem("agend_lang", v); else localStorage.removeItem("agend_lang"); } catch { /* this page only */ } }
/**
 * #1665: the signed-in page carries the host's values (<html data-prefs>) — the same rule as theme.js: the host's
 * language is this page's (the browser's copy is refreshed, best effort); none chosen on the host and this device in
 * step with it: the device's language; not in step yet, or no data-prefs: this browser's copy, else the device's.
 */
function initialLang() {
  let d = null;
  try { d = JSON.parse(document.documentElement.getAttribute("data-prefs") || "null"); } catch { d = null; }
  if (d && typeof d === "object" && d.values && typeof d.values === "object") {
    const host = d.values.lang;
    if (host === "en" || host === "zh-TW") { cacheLang(host); return host; }
    let inStep = false;
    try { inStep = localStorage.getItem("agend_prefs_synced") === "1"; } catch { inStep = false; }
    if (inStep) { cacheLang(null); return deviceLanguage(); }
  }
  try { const v = localStorage.getItem("agend_lang"); if (v === "en" || v === "zh-TW") return v; } catch { /* none */ }
  return deviceLanguage();
}
let current = initialLang();

/** Add a namespace: `register("chat", { en: {...}, "zh-TW": {...} })`. */
export function register(ns, byLang) {
  for (const lang of Object.keys(tables)) {
    for (const [k, v] of Object.entries((byLang && byLang[lang]) || {})) tables[lang][`${ns}.${k}`] = v;
  }
}

export function lang() { return current; }

/**
 * Choose a language; every subscriber re-renders (a new navigation lease, §4). `{ store: false }`: this page only —
 * the host's "none chosen" arriving from another device (app-prefs.js), which leaves no copy in this browser.
 */
export function setLang(next, opts = {}) {
  if (next !== "en" && next !== "zh-TW") return;
  current = next;
  if (opts.store !== false) cacheLang(next);
  if (typeof document !== "undefined" && document.documentElement) document.documentElement.lang = next === "zh-TW" ? "zh-Hant" : "en";
  for (const fn of listeners) fn(next);
}
export function onLang(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** "{0} is working…" with its values filled in. Text only: callers render it as text, never as markup. */
export function t(key, ...values) {
  let s = tables[current][key] ?? tables.en[key] ?? key;
  values.forEach((v, i) => { s = s.split(`{${i}}`).join(String(v)); });
  return s;
}

register("app", {
  en: {
    brand: "AgEnD", fleet: "Fleet", fleetOverview: "Fleet", view: "View", settings: "Settings", instances: "Instances", newInstance: "New instance", newAgent: "New agent",
    collapse: "Hide the sidebar", expand: "Show the sidebar", openMenu: "Open the sidebar", closeMenu: "Close the sidebar",
    resizeSidebar: "Sidebar width", resizeSidebarHint: "Drag to resize · double-click to reset",
    names: "Names", namesNickname: "Nickname first", namesInstance: "Real name first",
    theme: "Theme", themeSystem: "System", themeLight: "Light", themeDark: "Dark", language: "Language",
    previews: "Allow HTML previews", tour: "Tour", tourTitle: "Show the web chat tour again",
    needsYou: "needs you", approxNote: "Read from the terminal, so approximate", chat: "Chat", details: "Details", log: "Log", instanceViews: "Views of {0}",
    textSize: "Text size: {0}", textSize_s: "S", textSize_m: "M", textSize_l: "L", textSize_fit: "Fit", usage: "Usage", usageHide: "Hide usage",
    ownerCssKeep: "Keep this custom CSS?", ownerCssKeepLeft: "Reverts in {0} s", ownerCssKeepYes: "Keep", ownerCssKeepNo: "Revert",
    statusQueued: "queued", statusStarting: "starting", fleetStarting: "Fleet starting {0}/{1}…", statusRunning: "running", statusStopped: "stopped", statusPaused: "paused", statusCrashed: "crashed", statusWorking: "working", statusStuck: "looks stuck", statusIdle: "idle",
    connReconnecting: "Can't reach AgEnD — it may be restarting. Reconnecting…", connReconnectingIn: "Can't reach AgEnD — it may be restarting. Trying again in {0} s.",
    hydrating: "Loading what is open now…", hydrateFailed: "Could not load what is open now (prompts, ticks).",
    skip: "Skip to the conversation", loadFailed: "This could not be loaded.", retry: "Try again", loading: "Loading…",
    noInstances: "No instances yet", noInstancesHint: "Create one to start chatting.",
    guestChip: "Guest", guestAs: "Guest · {0}", guestAsOn: "Guest · {0} ({1})", guestHint: "You see only the agents you can already use in chat.",
    session: "Session", signIn: "Sign in", signedIn: "Signed in", signedOut: "Not signed in", thisDevice: "This device", devicePrefs: "Theme and language",
    lastActive: "active {0}", justNow: "just now", minAgo: "{0} min ago", hrAgo: "{0} h ago", signOut: "Sign out",
    signOutAll: "Sign out everywhere", devices: "Signed-in devices", expires: "Ends by {0} at the latest, or after {1} unused",
    failed: "That did not work — try again.", close: "Close", more: "More actions", menu: "Menu",
    pendingTitle: "Changes waiting for confirmation", pending_pending: "Waiting for confirmation", pending_applying: "Confirmed — applying…",
    pendingWeb: "Confirmed by your account (this browser is web-verified). General is told.",
    pending_applied: "Confirmed and applied", pending_rejected: "Not applied", pending_expired: "Expired — nothing was changed",
    pending_stale: "Not applied — settings changed meanwhile", pending_failed: "Confirmed, but applying it failed",
    pendingChat: "A fleet admin confirms this in chat (General topic).", pendingHost: "Confirm it on the host: {0}", pendingLeft: "{0} left", withdraw: "Withdraw",
    opWriting: "Applying settings… {0}/{1}", opWaiting: "Settings: waiting for confirmation in chat", opApplying: "Applying settings…",
    opDone: "Settings applied", opRestart: "Settings saved — AgEnD needs a restart to use them", opPartial: "Some settings were not applied",
    opFailed: "Settings were not applied", openSettings: "Open Settings",
    pendingSent: "Sent for confirmation — a fleet admin confirms it in chat.",
    pendingSelfSent: "Confirmed by your account (this browser is web-verified) — applying.",
    needsNav: "Needs you", needsTab: "Needs you", needsCount: "{0} waiting",
    // #2293: global search — chats, cross-instance messages and tasks (not the sidebar's filter of agents).
    search: "Search", searchTitle: "Search chats, messages between agents and tasks ({0})",
    confirmTitle: "Please confirm", confirmOk: "Continue", cancel: "Cancel",
    // The server's own wording (src/locale.ts needs.reason.*), so the web says what Discord says.
    needs_reason_hang: "Not responding", needs_reason_exited: "Exited", needs_reason_assist: "Waiting at its terminal", needs_reason_permission: "Permission needed", needs_reason_dangerous_command: "Dangerous command waiting", needs_reason_login: "Sign-in needed", needs_reason_dialog: "Waiting at a dialog", needs_reason_terminal_input: "May be waiting for input", needs_reason_auth_paused: "Paused: sign-in needed", needs_reason_crashed: "Crashed", needs_reason_delivery_uncertain: "Could not confirm delivery", needs_reason_delivery_failed: "Delivery failed", needs_reason_task_review: "Waiting for your confirmation", needs_reason_task_blocked: "Blocked: asks you",
  },
  "zh-TW": {
    brand: "AgEnD", fleet: "Fleet", fleetOverview: "Fleet 概覽", view: "檢視", settings: "設定", instances: "Instances", newInstance: "新增 instance", newAgent: "新增 Agent",
    collapse: "隱藏側邊欄", expand: "顯示側邊欄", openMenu: "打開側邊欄", closeMenu: "關閉側邊欄",
    resizeSidebar: "側邊欄寬度", resizeSidebarHint: "拖曳調整寬度 · 按兩下恢復預設",
    names: "名稱", namesNickname: "暱稱優先", namesInstance: "實際名稱優先",
    theme: "主題", themeSystem: "跟隨系統", themeLight: "淺色", themeDark: "深色", language: "語言",
    previews: "允許預覽 HTML", tour: "導覽", tourTitle: "再看一次網頁聊天導覽",
    needsYou: "等你回應", approxNote: "從終端畫面判讀，僅供參考", chat: "聊天", details: "詳細資訊", log: "紀錄", instanceViews: "{0} 的檢視",
    textSize: "字級：{0}", textSize_s: "小", textSize_m: "中", textSize_l: "大", textSize_fit: "填滿", usage: "用量", usageHide: "隱藏用量",
    ownerCssKeep: "保留這份自訂 CSS？", ownerCssKeepLeft: "{0} 秒後還原", ownerCssKeepYes: "保留", ownerCssKeepNo: "還原",
    statusQueued: "等待啟動", statusStarting: "啟動中", fleetStarting: "Fleet 啟動中 {0}/{1}…", statusRunning: "執行中", statusStopped: "已停止", statusPaused: "已暫停", statusCrashed: "已當掉", statusWorking: "工作中", statusStuck: "似乎卡住", statusIdle: "閒置",
    connReconnecting: "連不上 AgEnD——可能正在重新啟動。正在重新連線…", connReconnectingIn: "連不上 AgEnD——可能正在重新啟動。{0} 秒後再試。",
    hydrating: "正在載入目前的狀態…", hydrateFailed: "無法載入目前的狀態（提示、送達標記）。",
    skip: "跳到對話", loadFailed: "無法載入。", retry: "再試一次", loading: "載入中…",
    noInstances: "還沒有 instance", noInstancesHint: "建立一個就能開始聊天。",
    guestChip: "訪客", guestAs: "訪客 · {0}", guestAsOn: "訪客 · {0}（{1}）", guestHint: "你只會看到在聊天中本來就能用的 agent。",
    session: "登入狀態", signIn: "登入", signedIn: "已登入", signedOut: "尚未登入", thisDevice: "這台裝置", devicePrefs: "主題與語言",
    lastActive: "{0}活動", justNow: "剛剛", minAgo: "{0} 分鐘前", hrAgo: "{0} 小時前", signOut: "登出",
    signOutAll: "全部登出", devices: "已登入的裝置", expires: "最晚 {0} 結束；閒置 {1} 也會結束",
    failed: "沒有成功，請再試一次。", close: "關閉", more: "更多動作", menu: "選單",
    pendingTitle: "等待確認的變更", pending_pending: "等待確認", pending_applying: "已確認——套用中…",
    pendingWeb: "由你的帳號確認（這個瀏覽器已通過網頁驗證），也會通知 General。",
    pending_applied: "已確認並套用", pending_rejected: "未套用", pending_expired: "已逾時——沒有任何變更",
    pending_stale: "未套用——設定在這期間已變動", pending_failed: "已確認，但套用失敗",
    pendingChat: "由 fleet 管理員在聊天（General topic）中確認。", pendingHost: "請在主機上確認：{0}", pendingLeft: "剩 {0}", withdraw: "撤回",
    opWriting: "正在套用設定… {0}/{1}", opWaiting: "設定：等待在聊天中確認", opApplying: "正在套用設定…",
    opDone: "設定已套用", opRestart: "設定已儲存——需要重新啟動 AgEnD 才會生效", opPartial: "部分設定沒有套用",
    opFailed: "設定沒有套用", openSettings: "開啟設定",
    pendingSent: "已送出確認——由 fleet 管理員在聊天中確認。",
    pendingSelfSent: "已由你的帳號確認（這個瀏覽器已通過網頁驗證）——套用中。",
    needsNav: "等你處理", needsTab: "待處理", needsCount: "{0} 件待處理",
    search: "搜尋", searchTitle: "搜尋聊天、agent 之間的訊息與任務（{0}）",
    confirmTitle: "請確認", confirmOk: "繼續", cancel: "取消",
    needs_reason_hang: "沒有回應", needs_reason_exited: "已結束", needs_reason_assist: "在終端機上等待", needs_reason_permission: "需要權限", needs_reason_dangerous_command: "危險指令待確認", needs_reason_login: "需要登入", needs_reason_dialog: "停在對話框", needs_reason_terminal_input: "可能在等輸入", needs_reason_auth_paused: "已暫停：需要登入", needs_reason_crashed: "已崩潰", needs_reason_delivery_uncertain: "無法確認是否送達", needs_reason_delivery_failed: "傳送失敗", needs_reason_task_review: "等你確認", needs_reason_task_blocked: "卡住，在問你",
  },
});
