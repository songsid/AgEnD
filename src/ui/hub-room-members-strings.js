// Hub rooms, the right-hand members panel (docs/design/hub-rooms-ux.md section 5): only the words the shared room
// vocabulary (hub-room-strings.js, namespace hubRoom) does not have. A module of its own, so a tab holding an older
// dictionary still has every word (upgrade skew).
import { register, t } from "/assets/app-i18n.js";

register("hubRoomMembers", {
  en: { askOwner: "ask {0}", fewer: "Show fewer", ownerOf: "Owner: {0}", removeFailed: "It was not removed. Try again.", agents: "Agents", ownerAgent: "{0}'s agent", ownerAgentLatin: "{0}'s agent",
    noAgents: "No agents yet. A room manager can add or invite them in Room settings.",
    // M-3533 M1: the compact list of a large room.
    summary: "{0} people, {1} online · {2} agents of {3} owners", filter: "Filter: name or owner", filterLabel: "Filter members",
    notOnline: "Not online · {0}", ownerGroup: "{0} · {1}", noOwner: "—", noMatch: "No member matches." },
  "zh-TW": { askOwner: "請通知 {0}", fewer: "收合", ownerOf: "擁有者：{0}", removeFailed: "沒有移除，請再試一次。", agents: "Agent", ownerAgent: "{0}的 Agent", ownerAgentLatin: "{0} 的 Agent",
    noAgents: "還沒有 Agent。房間管理可以在房間設定加入或邀請。",
    summary: "{0} 人，{1} 人在線上 · {2} 個 Agent，{3} 位擁有者", filter: "篩選：名稱或擁有者", filterLabel: "篩選成員",
    notOnline: "不在線上 · {0}", ownerGroup: "{0} · {1}", noOwner: "—", noMatch: "沒有符合的成員。" },
});
export const hm = (key, ...args) => t(`hubRoomMembers.${key}`, ...args);
