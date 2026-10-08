// #1408 §4: one dictionary for the app, namespaced (app.*, chat.*, fleet.*, …). A panel registers its own namespace
// when it loads; t("chat.send") resolves it in the chosen language and falls back to English, then to the key.
// The language is this browser's choice (agend_lang, the key every panel has used), else the device's.

const tables = { en: {}, "zh-TW": {} };
const listeners = new Set();

function stored() {
  try { const v = localStorage.getItem("agend_lang"); return v === "en" || v === "zh-TW" ? v : null; } catch { return null; }
}
let current = stored() || (typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "") ? "zh-TW" : "en");

/** Add a namespace: `register("chat", { en: {...}, "zh-TW": {...} })`. */
export function register(ns, byLang) {
  for (const lang of Object.keys(tables)) {
    for (const [k, v] of Object.entries((byLang && byLang[lang]) || {})) tables[lang][`${ns}.${k}`] = v;
  }
}

export function lang() { return current; }

/** Choose a language for this browser; every subscriber re-renders (a new navigation lease, §4). */
export function setLang(next) {
  if (next !== "en" && next !== "zh-TW") return;
  current = next;
  try { localStorage.setItem("agend_lang", next); } catch { /* this page only */ }
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
    brand: "AgEnD", fleet: "Fleet", view: "View", settings: "Settings", instances: "Instances", newInstance: "New instance",
    collapse: "Hide the sidebar", expand: "Show the sidebar", openMenu: "Open the sidebar", closeMenu: "Close the sidebar",
    theme: "Theme", themeSystem: "System", themeLight: "Light", themeDark: "Dark", language: "Language",
    previews: "Allow HTML previews on this device", tour: "Tour", tourTitle: "Show the web chat tour again",
    needsYou: "needs you", approxNote: "Read from the terminal, so approximate", chat: "Chat",
    statusRunning: "running", statusStopped: "stopped", statusCrashed: "crashed", statusWorking: "working", statusStuck: "looks stuck", statusIdle: "idle",
    connPolling: "Live updates paused — refreshing every 5 s", connDown: "Disconnected — trying again…", connConnecting: "Connecting…",
    skip: "Skip to the conversation", loadFailed: "This could not be loaded.", retry: "Try again", loading: "Loading…",
    noInstances: "No instances yet", noInstancesHint: "Create one to start chatting.",
    session: "Session", signIn: "Sign in", signedIn: "Signed in", signedOut: "Not signed in", thisDevice: "This device",
    lastActive: "active {0}", justNow: "just now", minAgo: "{0} min ago", hrAgo: "{0} h ago", signOut: "Sign out",
    signOutAll: "Sign out everywhere", devices: "Signed-in devices", expires: "Ends by {0} at the latest, or after {1} unused",
    failed: "That did not work — try again.", close: "Close", more: "More actions", menu: "Menu",
  },
  "zh-TW": {
    brand: "AgEnD", fleet: "Fleet", view: "檢視", settings: "設定", instances: "Instances", newInstance: "新增 instance",
    collapse: "隱藏側邊欄", expand: "顯示側邊欄", openMenu: "打開側邊欄", closeMenu: "關閉側邊欄",
    theme: "主題", themeSystem: "跟隨系統", themeLight: "淺色", themeDark: "深色", language: "語言",
    previews: "允許這台裝置預覽 HTML", tour: "導覽", tourTitle: "再看一次網頁聊天導覽",
    needsYou: "等你回應", approxNote: "從終端畫面判讀，僅供參考", chat: "聊天",
    statusRunning: "執行中", statusStopped: "已停止", statusCrashed: "已當掉", statusWorking: "工作中", statusStuck: "似乎卡住", statusIdle: "閒置",
    connPolling: "即時更新暫停中——每 5 秒重新整理", connDown: "已斷線——正在重試…", connConnecting: "連線中…",
    skip: "跳到對話", loadFailed: "無法載入。", retry: "再試一次", loading: "載入中…",
    noInstances: "還沒有 instance", noInstancesHint: "建立一個就能開始聊天。",
    session: "登入狀態", signIn: "登入", signedIn: "已登入", signedOut: "尚未登入", thisDevice: "這台裝置",
    lastActive: "{0}活動", justNow: "剛剛", minAgo: "{0} 分鐘前", hrAgo: "{0} 小時前", signOut: "登出",
    signOutAll: "全部登出", devices: "已登入的裝置", expires: "最晚 {0} 結束；閒置 {1} 也會結束",
    failed: "沒有成功，請再試一次。", close: "關閉", more: "更多動作", menu: "選單",
  },
});
