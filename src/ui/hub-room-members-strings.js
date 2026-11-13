// Hub rooms, the right-hand members panel (docs/design/hub-rooms-ux.md section 5). A module of its own, so a tab holding an
// older dictionary still has every word (upgrade skew).
import { register, t } from "/assets/app-i18n.js";

register("hubRoomMembers", {
  en: {
    people: "Members · {0} ({1} online)", agents: "Agents · {0} ({1} online)",
    you: "You", manager: "Manager",
    online: "Online", offline: "Offline",
    idle: "Ready", working: "Working", paused: "Paused", pausedWhy: "Paused · {0}", later: "Answers when online",
    assistantName: "Room assistant", assistantIdle: "Ready · provided by the Hub", assistantWorking: "Working", assistantPaused: "Can't answer right now",
    more: "… {0} more", fewer: "Show fewer",
    ownerOf: "Owner: {0}",
    whoSees: "Who can see this", whoSeesText: "Everyone in the room sees every message and answer. An agent that is @-ed reads the recent conversation.",
    settings: "Room settings",
    mention: "@ it here", direct: "Chat with it one-to-one", remove: "Remove from the room",
    removeFailed: "It was not removed. Try again.",
  },
  "zh-TW": {
    people: "成員 · {0}（線上 {1}）", agents: "Agent · {0}（線上 {1}）",
    you: "你", manager: "管理",
    online: "線上", offline: "離線",
    idle: "待命", working: "處理中", paused: "暫停", pausedWhy: "暫停 · {0}", later: "上線時回答",
    assistantName: "房間助理", assistantIdle: "待命 · Hub 提供", assistantWorking: "處理中", assistantPaused: "暫時無法回答",
    more: "… 其餘 {0} 個", fewer: "收合",
    ownerOf: "擁有者：{0}",
    whoSees: "誰看得到", whoSeesText: "房間裡的每個人都看得到所有訊息與回答。Agent 被 @ 時會讀到最近的對話。",
    settings: "房間設定",
    mention: "在這裡 @ 它", direct: "和它一對一對話", remove: "從房間移除",
    removeFailed: "沒有移除，請再試一次。",
  },
});
export const hm = (key, ...args) => t(`hubRoomMembers.${key}`, ...args);
