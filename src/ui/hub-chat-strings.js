// #3226 B: the Hub chat's own words (the conversation list, the room, the right-hand panel, the menu), en and zh-TW, and
// its stylesheet. A module of its own (a tab opened before an upgrade holds an older hub-strings.js without these words,
// and an older hub.css without these rules). The thread's own words are the fleet chat's (/assets/chat-strings.js).
import { register, t } from "/assets/app-i18n.js";

register("hubChat", {
  en: {
    chats: "Chats", newChat: "New chat", search: "Search chats", noChats: "No chats yet", noChatsHint: "Start one with New chat: it lists the agents someone allowed you to ask.",
    noMatch: "No chat matches.", waiting: "Waiting for an answer", represents: "Answers for {0}",
    pickTitle: "New chat", pickSearch: "Search agents or owners", pickHint: "Only the agents someone allowed you to ask are listed.",
    pickUntil: "Answers for {0} · you can ask until {1}", pickAsk: "Ask", pickOpen: "Open", pickNone: "No agent matches.", pickEmpty: "No agents you can ask yet",
    choose: "Pick a chat", chooseHint: "Or start one with New chat.",
    emptyRoom: "Ask {0} your first question", emptyRoomHint: "It answers for {0}. An answer can take a few minutes.",
    composer: "Ask {0}", composerHint: "You ask as yourself; {0} sees that it was you.", send: "Send", stop: "Stop",
    working: "{0} is working on it", elapsed: "Time since it started",
    tick_queued: "Waiting for the owner's fleet", tick_processing: "At the owner's fleet", tick_delivered: "Answered",
    tick_failed: "Not answered", tick_cancelled: "Outcome unknown",
    notAnswered: "Not answered: {0}", uncertain: "Outcome unknown: it may or may not have been answered.",
    reason_expired: "the question expired before an answer", reason_revoked: "your permission ended", reason_frozen: "the owner paused questions",
    reason_withdrawn: "the agent is no longer shared", reason_unknown: "no reason given",
    closed: "This chat has closed: your permission ended, or the agent is no longer shared.",
    frozen: "The owner has paused questions to {0}. What is here stays readable.",
    tagCanAsk: "Can ask", tagFrozen: "Paused", tagClosed: "Closed",
    info: "Info", infoLabel: "About this chat", showInfo: "Show info", hideInfo: "Hide",
    answersFor: "Answers for {0}", yourAccess: "Your access", canDo: "May", canDoValue: "Ask, and read your own chat",
    until: "Until", daysLeft: "{0} days left", dayLeft: "1 day left", endsToday: "Ends today",
    whoSees: "Who sees this chat", you: "You", youSee: "Only you see this chat's history, while your permission lasts.",
    ownerSees: "Your questions show in {0}'s own fleet chat, marked with your Hub identity.",
    agentShares: "It shares one conversation with everyone allowed to ask it, so it may remember what others asked. Keep out what others mustn't know.",
    adminTitle: "Hub administrator", adminSees: "Can't see the content.",
    notHere: "Not here", notHereText: "{0}'s files and changes, its terminal (View) and its tool progress: only {1} sees them, in their own fleet.",
    oneToOne: "A chat has only you and this agent.",
    menu: "Menu", mine: "My shared agents", mineHint: "Who may ask them, until when", admin: "Administration", adminHint: "Pair fleets",
    back: "Chats",
  },
  "zh-TW": {
    chats: "對話", newChat: "新對話", search: "搜尋對話", noChats: "還沒有對話", noChatsHint: "用「新對話」開始：會列出有人允許你提問的 Agent。",
    noMatch: "沒有符合的對話。", waiting: "等待回答", represents: "代表 {0} 回答",
    pickTitle: "新對話", pickSearch: "搜尋 Agent 或擁有者", pickHint: "只列出有人允許你提問的 Agent。",
    pickUntil: "代表 {0} · 你可以問到 {1}", pickAsk: "提問", pickOpen: "開啟", pickNone: "沒有符合的 Agent。", pickEmpty: "還沒有可以提問的 Agent",
    choose: "選一個對話", chooseHint: "或用「新對話」開始一個。",
    emptyRoom: "問 {0} 第一個問題", emptyRoomHint: "它代表 {0} 回答；回答可能要幾分鐘。",
    composer: "問 {0}", composerHint: "你以自己的 Hub 身分提問；{0} 會看到是你問的。", send: "送出", stop: "停止",
    working: "{0} 正在處理", elapsed: "開始處理後經過的時間",
    tick_queued: "等待擁有者的 fleet", tick_processing: "已送達擁有者的 fleet", tick_delivered: "已回答",
    tick_failed: "未回答", tick_cancelled: "結果未知",
    notAnswered: "未回答：{0}", uncertain: "結果未知：可能已回答，也可能沒有。",
    reason_expired: "問題在回答前就過期了", reason_revoked: "你的權限已結束", reason_frozen: "擁有者暫停了提問",
    reason_withdrawn: "這個 Agent 不再分享", reason_unknown: "沒有說明原因",
    closed: "這個對話已關閉：你的權限已結束，或這個 Agent 不再分享。",
    frozen: "擁有者暫停了 {0} 的提問。這裡的內容仍然看得到。",
    tagCanAsk: "可提問", tagFrozen: "已暫停", tagClosed: "已關閉",
    info: "資訊", infoLabel: "這段對話的資訊", showInfo: "顯示資訊", hideInfo: "關閉",
    answersFor: "代表 {0} 回答", yourAccess: "你的權限", canDo: "可以", canDoValue: "提問、看自己的紀錄",
    until: "期限", daysLeft: "還有 {0} 天", dayLeft: "還有 1 天", endsToday: "今天到期",
    whoSees: "誰看得到這段對話", you: "你", youSee: "這個聊天室的紀錄只有你看得到，而且只在權限有效期間。",
    ownerSees: "你的問題會出現在 {0} 的 fleet 聊天裡，標示你的 Hub 身分。",
    agentShares: "它和其他有權限的人共用同一段對話，可能記得別人問過的事。別放不想讓別人知道的內容。",
    adminTitle: "Hub 管理員", adminSees: "看不到內容。",
    notHere: "這裡沒有", notHereText: "{0} 的檔案與變更、終端機畫面（View）、工具進度：只有 {1} 在自己的 fleet 看得到。",
    oneToOne: "一個聊天室只有你和這個 Agent。",
    menu: "選單", mine: "我分享的 Agent", mineHint: "誰可以提問、到什麼時候", admin: "管理", adminHint: "配對 fleet",
    back: "對話",
  },
});
/** hubChat.* words. */
export const hc = (key, ...values) => t(`hubChat.${key}`, ...values);

/** The Hub chat's stylesheet, linked once (an older hub.css or app.css lacks these rules). */
export function linkHubChatCss(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector('link[data-hub-chat-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/hub-chat.css"); link.setAttribute("data-hub-chat-css", "1");
    doc.head.appendChild(link);
  } catch { /* the chat still works without it */ }
}
