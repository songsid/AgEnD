// Hub rooms, Room settings (docs/design/hub-rooms-ux.md section 7): only the words the shared room vocabulary
// (hub-room-strings.js, namespace hubRoom) does not have. A module of its own, so a tab holding an older dictionary
// still has every word (upgrade skew).
import { register, t } from "/assets/app-i18n.js";

register("hubRoomSettings", {
  en: {
    expiredRow: "{0} ({1}) · invitation expired", expiredRowNoOwner: "{0} · invitation expired",
    pendingRowNoOwner: "{0} · invited, waiting for the owner",
    inviteAgain: "Invite again",
    rowMenu: "More for {0}",
    save: "Save",
    saveFailed: "That was not saved. Try again.",
    membersOwnAgents: "Members can add their own agents",
    membersOwnAgentsHint: "Members can add agents they own and have shared on this Hub. Room managers can remove them. For another owner’s agent, ask a room manager to use Ask its owner.",
    noAgentsMember: "No agents yet. Add an agent you own, or ask a room manager to add or invite one.",
    addOwnAgents: "Add your agents", ownAgentsHint: "Choose an agent you own and have shared on this Hub. Everyone in this room can ask it here.",
    assistantSwitch: "Room assistant",
  },
  "zh-TW": {
    expiredRow: "{0}（{1}）· 邀請已過期", expiredRowNoOwner: "{0} · 邀請已過期",
    pendingRowNoOwner: "{0} · 已邀請，等擁有者同意",
    inviteAgain: "重新邀請",
    rowMenu: "{0} 的更多動作",
    save: "儲存",
    saveFailed: "沒有儲存，請再試一次。",
    membersOwnAgents: "成員可以加入自己擁有的 Agent",
    membersOwnAgentsHint: "成員可以加入自己擁有、且已分享到這個 Hub 的 Agent。房間管理員可以移除。其他人擁有的 Agent，請房間管理員使用「請擁有者加入」。",
    noAgentsMember: "還沒有 Agent。可以加入自己擁有的 Agent，或請房間管理員加入或邀請。",
    addOwnAgents: "加入自己的 Agent", ownAgentsHint: "選擇自己擁有、且已分享到這個 Hub 的 Agent。房間裡的每個人都能在這裡向它提問。",
    assistantSwitch: "房間助理",
  },
});
export const hs = (key, ...args) => t(`hubRoomSettings.${key}`, ...args);
