// S-92 (#3326 D1): the settings.* words for restarting AgEnD from Settings on a fleet with no chat connection, kept in a file
// of their own for the same reason as settings-shared-strings.js: a tab opened before an upgrade already holds the old
// settings-strings.js, and this file's URL is new, so no tab can hold an old copy of it. register() merges these over what
// settings-strings.js said. Every module that reads one of these keys imports this file after "./settings-strings.js".
import { register } from "/assets/app-i18n.js";

register("settings", {
  en: {
    // On a web-only fleet a restart from Settings is recorded in the dashboard's Notices (there is no chat channel).
    applyRestartHintWebOnly: "This change needs AgEnD itself restarted. You can restart it here.",
    restartFleetConfirmWebOnly: "Restart AgEnD now?\n\nEvery agent stops and starts again, work in progress is interrupted, and the panel is unreachable for up to a minute. It is recorded in this dashboard's Notices.",
  },
  "zh-TW": {
    applyRestartHintWebOnly: "此變更需要重新啟動 AgEnD 本身。可以在這裡重新啟動。",
    restartFleetConfirmWebOnly: "現在重新啟動 AgEnD？\n\n所有 agent 都會停止再啟動，進行中的工作會被中斷，面板會有最多約一分鐘無法連線。這次重新啟動會記錄在這個儀表板的通知中。",
  },
});
