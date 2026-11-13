// Hub rooms, the New room dialog and its pickers (docs/design/hub-rooms-ux.md section 6; the pickers are reused by Room
// settings, section 7): only the words the shared room vocabulary (hub-room-strings.js, namespace hubRoom) does not have.
// A module of its own, so a tab holding an older dictionary still has every word (upgrade skew).
import { register, t } from "/assets/app-i18n.js";

register("hubRoomNew", {
  en: {
    agents: "Agents",
    withCount: "{0} · {1} people",
    peopleLimit: "This room would have {0} people, over the limit of {1}. Choose a smaller AD group or team instead.",
    groupUnavailable: "Can't read the members of “{0}” right now. Try again later.",
    neverSignedIn: "Hasn't signed in to the Hub yet",
    teamAgents: "Every member's agents in “{0}”",
    remove: "Remove {0}",
    noMatch: "Nothing matches.",
    searchFailed: "Search did not work. Try again.",
    createFailed: "The room was not created. Try again.",
    nameTooLong: "A room name is at most 60 characters.",
  },
  "zh-TW": {
    agents: "Agent",
    withCount: "{0} · {1} 人",
    peopleLimit: "這個房間會有 {0} 人，超過上限 {1} 人。請改選較小的 AD 群組或團隊。",
    groupUnavailable: "目前無法讀取「{0}」的成員，請稍後再試。",
    neverSignedIn: "還沒登入過 Hub",
    teamAgents: "「{0}」所有人的 Agent",
    remove: "移除 {0}",
    noMatch: "找不到符合的結果。",
    searchFailed: "搜尋沒有成功，請再試一次。",
    createFailed: "房間沒有建立，請再試一次。",
    nameTooLong: "房間名稱最多 60 個字。",
  },
});
export const hn = (key, ...args) => t(`hubRoomNew.${key}`, ...args);

/** The U2 screens' stylesheet, linked once (an older hub-chat.css or hub-owner.css lacks these rules). */
export function linkRoomsU2Css(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector('link[data-hub-rooms-u2-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/hub-rooms-u2.css"); link.setAttribute("data-hub-rooms-u2-css", "1");
    doc.head.appendChild(link);
  } catch { /* the screens still work without it */ }
}
