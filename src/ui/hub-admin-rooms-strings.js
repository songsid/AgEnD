// Hub rooms, Administration → Rooms (docs/design/hub-rooms-ux.md section 11): only the words the shared room vocabulary
// (hub-room-strings.js, namespace hubRoom) does not have. A module of its own, so a tab holding an older dictionary still
// has every word (upgrade skew).
import { register, t } from "/assets/app-i18n.js";

register("hubAdminRooms", {
  en: {
    adminOnly: "Right now only Hub administrators can start rooms.",
    colPeople: "People", colAgents: "Agents", colLast: "Last activity", colState: "Status",
    none: "No rooms yet.",
    rowMenu: "More for {0}",
    saveFailed: "That was not saved. Try again.",
    loadFailed: "Rooms could not be loaded.", retry: "Try again",
    archiveAsk: "Archive “{0}”? The room becomes read-only; its members can still read it.",
    joined: "You are a room manager of “{0}” now. A line in the room says so.",
  },
  "zh-TW": {
    adminOnly: "目前只有 Hub 管理員可以開房間。",
    colPeople: "人數", colAgents: "Agent 數", colLast: "最後活動", colState: "狀態",
    none: "還沒有房間。",
    rowMenu: "{0} 的更多動作",
    saveFailed: "沒有儲存，請再試一次。",
    loadFailed: "無法載入房間。", retry: "再試一次",
    archiveAsk: "要封存「{0}」嗎？房間會變成唯讀，成員仍然看得到內容。",
    joined: "你現在是「{0}」的房間管理，房間裡會出現一則說明。",
  },
});
export const ha = (key, ...args) => t(`hubAdminRooms.${key}`, ...args);
