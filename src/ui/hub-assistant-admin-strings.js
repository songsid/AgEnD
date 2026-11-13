import { register, t } from "/assets/app-i18n.js";
register("hubAssistantAdmin", {
  en: {
    backend: "Backend", account: "Account", defaultAccount: "Default account", unknown: "Unknown",
    save: "Save", saved: "Saved", refresh: "Refresh", noneRunning: "No room assistants are working or idle.",
    loadFailed: "Could not read room assistant settings. Try again.", saveFailed: "Could not save. Your changes are still here; try again.",
    stopFailed: "Could not stop this room assistant. Try again.", usageFailed: "Could not read usage. Try again.",
    usageNotSaved: "Some answer counts could not be saved. The answers were still sent.",
    starting: "Starting", stopping: "Stopping", failed: "Needs attention", day: "Day (UTC)", answers: "Answers",
  },
  "zh-TW": {
    backend: "後端", account: "帳號", defaultAccount: "預設帳號", unknown: "未知",
    save: "儲存", saved: "已儲存", refresh: "重新整理", noneRunning: "目前沒有執行中或待命的房間助理。",
    loadFailed: "未能讀取房間助理設定，請再試一次。", saveFailed: "未能儲存，修改仍保留在這裡，請再試一次。",
    stopFailed: "未能停止這個房間助理，請再試一次。", usageFailed: "未能讀取用量，請再試一次。",
    usageNotSaved: "部分回答次數未能儲存，回答仍已送出。",
    starting: "啟動中", stopping: "停止中", failed: "需要處理", day: "日期（UTC）", answers: "回答次數",
  },
});
export const ha = (key, ...args) => t(`hubAssistantAdmin.${key}`, ...args);
