// Hub rooms, the right-hand members panel (docs/design/hub-rooms-ux.md section 5): only the words the shared room
// vocabulary (hub-room-strings.js, namespace hubRoom) does not have. A module of its own, so a tab holding an older
// dictionary still has every word (upgrade skew).
import { register, t } from "/assets/app-i18n.js";

register("hubRoomMembers", {
  en: { fewer: "Show fewer", ownerOf: "Owner: {0}", removeFailed: "It was not removed. Try again.", agents: "Agents", ownerAgent: "{0}'s agent",
    noAgents: "No agents yet. A room manager can add or invite them in Room settings." },
  "zh-TW": { fewer: "收合", ownerOf: "擁有者：{0}", removeFailed: "沒有移除，請再試一次。", agents: "Agent", ownerAgent: "{0}的 Agent",
    noAgents: "還沒有 Agent。房間管理可以在房間設定加入或邀請。" },
});
export const hm = (key, ...args) => t(`hubRoomMembers.${key}`, ...args);
