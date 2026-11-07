// #3226 C: the words of the Hub's My shared agents and Administration pages, en and zh-TW, and their stylesheet. A module
// of its own (#3261 review): a tab that loaded B's hub-chat-strings.js / hub-chat.css before C keeps them, so C's words
// and rules come only from here.
import { register, t } from "/assets/app-i18n.js";

register("hubOwner", {
  en: {
    memberAddress: "Member address", memberAddressHint: "Enter this address and the code in your fleet's Settings → Hub → Connect to a Hub. This is separate from the Hub's browser address.",
    memberAddressMissing: "Ask the administrator for the member address; it may use a different port from this page.", copyHandoff: "Copy address and code", handoffCopied: "Address and code copied", handoffCopyFailed: "Couldn't copy. Select the address and code above to copy them.",
    active: "Active", adminLead: "Pair a fleet with this Hub and see the fleets that are paired. You can't read anyone's chats here.",
    allow: "Allow…", allowDays: "For", allowGo: "Allow", allowLogin: "Their sign-in name",
    allowLoginHint: "The account they sign in to this Hub with.", allowTitle: "Allow someone to ask {0}", approveGo: "Approve…",
    approvedTag: "Approved", backToMine: "My shared agents", codeFor: "Code for {0}", codeUnusedYet: "Not used yet", fleetOf: "{0}'s fleet",
    makeCode: "Make code", mayAsk: "{0} may ask", mayAskNone: "No one may ask yet", mayAskOne: "1 may ask",
    mineLead: "The agents that answer for you on this Hub: who may ask them, until when, and who asked lately. To share or stop sharing one, use your fleet's Settings → Access & security.",
    noFleets: "No fleet is paired yet.", ownerChecked: "The owner confirmed", ownerLogin: "Owner's sign-in name", pairSteps: "Pair a fleet",
    pairedFleets: "Paired fleets · {0}", pauseGo: "Pause…", pauseLead: "No one can ask it until it is shared again. What was asked stays readable.",
    pauseTitle: "Pause questions", pendingLead: "Check that this fingerprint matches the one your fleet shows, then confirm.",
    pendingPairings: "Pairings waiting for you", recent: "Recent questions",
    recentLead: "Who asked and when, and whether it was answered. What they asked stays in your fleet's chat.", recentNone: "No one has asked yet.",
    refresh: "Refresh", revokeItem: "Revoke…", revokedTag: "Revoked", rowMenu: "More for {0}", scopeHub: "This Hub", scopeYou: "Yours",
    sharedCount: "Shared · {0}", stageAnswered: "Answered", stageNot: "Not answered", stageWaiting: "Waiting", statePaused: "Paused",
    stateShared: "Shared", stateWithdrawn: "Withdrawn", stepApprove: "You approve", stepApproveHint: "Check the same fingerprint, then approve.",
    stepCode: "Make a pairing code", stepCodeHint: "For the fleet's owner: they type it in their fleet within 10 minutes; it works once.",
    stepOwner: "The owner checks the fingerprint", stepOwnerHint: "In their fleet, then on this Hub under My shared agents.",
    untilLeft: "until {0} ({1})", waitingOwner: "Waiting for the owner", whoMayAsk: "Who may ask",
  },
  "zh-TW": {
    memberAddress: "成員連線位址", memberAddressHint: "在你 fleet 的「設定 → Hub → 連線到 Hub」輸入這個位址和配對碼。這與 Hub 的瀏覽器位址不同。",
    memberAddressMissing: "請向管理員索取成員連線位址；它的連接埠可能與這個頁面不同。", copyHandoff: "複製位址與配對碼", handoffCopied: "已複製位址與配對碼", handoffCopyFailed: "無法複製。請選取上方的位址與配對碼來複製。",
    active: "使用中", adminLead: "把 fleet 配對到這個 Hub，並查看已配對的 fleet。這裡看不到任何人的對話。", allow: "允許提問…", allowDays: "期限", allowGo: "允許", allowLogin: "對方的登入名稱",
    allowLoginHint: "對方登入這個 Hub 用的帳號。", allowTitle: "允許提問 {0}", approveGo: "核准…", approvedTag: "已核准", backToMine: "我分享的 Agent",
    codeFor: "給 {0} 的配對碼", codeUnusedYet: "還沒使用", fleetOf: "{0} 的 fleet", makeCode: "產生配對碼", mayAsk: "{0} 人可以提問", mayAskNone: "還沒有人可以提問",
    mayAskOne: "1 人可以提問", mineLead: "在這個 Hub 上代表你回答的 Agent：誰可以提問、到什麼時候、最近誰問過。要開始或停止分享，請到你 fleet 的 設定 → 存取與安全。", noFleets: "還沒有配對的 fleet。",
    ownerChecked: "擁有者已確認", ownerLogin: "擁有者的登入名稱", pairSteps: "配對一個 fleet", pairedFleets: "已配對的 fleet · {0}", pauseGo: "暫停…",
    pauseLead: "重新分享之前，沒有人能再提問。已經問過的內容仍然看得到。", pauseTitle: "暫停提問", pendingLead: "確認這個指紋和你 fleet 上顯示的一致，再按確認。", pendingPairings: "等你核對的配對",
    recent: "最近的提問", recentLead: "誰問的、什麼時候，有沒有回答。問了什麼留在你 fleet 的聊天裡。", recentNone: "還沒有人問過。", refresh: "重新整理", revokeItem: "撤銷…", revokedTag: "已撤銷",
    rowMenu: "{0} 的更多動作", scopeHub: "這個 Hub", scopeYou: "你的", sharedCount: "分享中 · {0}", stageAnswered: "已回答", stageNot: "未回答", stageWaiting: "等待中",
    statePaused: "已暫停", stateShared: "分享中", stateWithdrawn: "已停止分享", stepApprove: "你核准", stepApproveHint: "核對同一個指紋後核准。", stepCode: "產生配對碼",
    stepCodeHint: "給 fleet 的擁有者：10 分鐘內在他的 fleet 輸入，只能用一次。", stepOwner: "擁有者核對指紋", stepOwnerHint: "在他的 fleet 上，然後在這個 Hub 的「我分享的 Agent」確認。",
    untilLeft: "到 {0}（{1}）", waitingOwner: "等待擁有者", whoMayAsk: "可以提問的人",
  },
});
/** hubOwner.* words. */
export const ho = (key, ...values) => t(`hubOwner.${key}`, ...values);

/** The owner and admin pages' stylesheet, linked once (an older hub-chat.css lacks these rules). */
export function linkHubOwnerCss(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector('link[data-hub-owner-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/hub-owner.css"); link.setAttribute("data-hub-owner-css", "1");
    doc.head.appendChild(link);
  } catch { /* the pages still work without it */ }
}
