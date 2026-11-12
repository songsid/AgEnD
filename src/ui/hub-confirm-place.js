// M-2988 (Lumen's Hub story board, findings 8 and 9): where a Hub step that waits for the Settings confirmation is confirmed,
// in the words of that place. A card posted to a General names its chat app; every other way (no chat app connected, a card
// still being sent, the inline card, the authenticator code, Apply now) is the confirm card on this page. Read from the
// pending request's live view (appStore.pendingChanges / hubJoinChanges, kept current by settings-confirm.js), so the hint
// follows the request when its card moves from "sending" to General or to the host. Its own module and namespace: a tab
// that still holds an older hub-strings dictionary gets these words too (upgrade skew).
import { register, t } from "/assets/app-i18n.js";

register("hubConfirmPlace", {
  en: {
    shareChat: "Sent for confirmation: press Confirm on the card in General on {0} to share it.",
    shareCard: "Sent for confirmation: finish it on the confirm card at the top of this page to share it.",
    joinChat: "First press Confirm on the card in General on {0}, so AgEnD knows it's really you connecting this Fleet. The Hub sign-in opens after that.",
    joinCard: "First confirm on the confirm card that it's really you connecting this Fleet. The Hub sign-in opens after that.",
  },
  "zh-TW": {
    shareChat: "已送出確認：請到 {0} 的 General，在確認卡上按「確認」，才會分享。",
    shareCard: "已送出確認：請在上方的確認卡完成，才會分享。",
    joinChat: "請先到 {0} 的 General，在確認卡上按「確認」，確定是你本人要連接這個 Fleet；之後才會開啟 Hub 登入。",
    joinCard: "請先在確認卡上確認是你本人要連接這個 Fleet；之後才會開啟 Hub 登入。",
  },
});

const PLATFORM_NAMES = { discord: "Discord", telegram: "Telegram" };

/** The chat apps whose General holds this request's card ("Discord", "Discord (team-b)"), or null when no General has it. */
export function confirmChat(view) {
  const c = view && view.confirmation;
  if (!c || c.kind !== "chat") return null;
  const names = (Array.isArray(c.where) ? c.where : []).map((w) => `${PLATFORM_NAMES[w.platform] || w.platform}${w.connection && w.connection !== w.platform ? ` (${w.connection})` : ""}`);
  return names.length ? [...new Set(names)].join(" / ") : null;
}

/** The pending request's live view by id, from the shell's lists. */
export function pendingView(state, id) {
  if (!id || !state) return null;
  return [...(state.pendingChanges || []), ...(state.hubJoinChanges || [])].find((v) => v && v.id === id) || null;
}

/** "share" (an agent's Share switch) or "join" (a company Hub connection): the one sentence for where to confirm it. */
export function confirmPlace(kind, view) {
  const chat = confirmChat(view);
  return chat ? t(`hubConfirmPlace.${kind}Chat`, chat) : t(`hubConfirmPlace.${kind}Card`);
}
