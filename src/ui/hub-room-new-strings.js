// Hub rooms, the New room dialog and its pickers (docs/design/hub-rooms-ux.md section 6; the pickers are reused by Room
// settings, section 7): only the words the shared room vocabulary (hub-room-strings.js, namespace hubRoom) does not have.
// A module of its own, so a tab holding an older dictionary still has every word (upgrade skew).
import { register, t } from "/assets/app-i18n.js";

register("hubRoomNew", {
  en: {
    agents: "Agents",
    withCount: "{0} ({1} people)",
    teamAgents: "Every member's agents in “{0}”",
    remove: "Remove {0}",
    noMatch: "Nothing matches.",
    searchFailed: "Search did not work. Try again.",
    createFailed: "The room was not created. Try again.",
    nameTooLong: "A room name is at most 60 characters.",
  },
  "zh-TW": {
    agents: "Agent",
    withCount: "{0}（{1} 人）",
    teamAgents: "「{0}」所有人的 Agent",
    remove: "移除 {0}",
    noMatch: "找不到符合的結果。",
    searchFailed: "搜尋沒有成功，請再試一次。",
    createFailed: "房間沒有建立，請再試一次。",
    nameTooLong: "房間名稱最多 60 個字。",
  },
});
export const hn = (key, ...args) => t(`hubRoomNew.${key}`, ...args);
