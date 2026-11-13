// Hub rooms, invitations on the owner's side (docs/design/hub-rooms-ux.md section 8): another person's room asks for
// one of your shared agents, and you agree or decline. A module of its own, so a tab holding an older dictionary still
// has every word (upgrade skew).
import { register, t } from "/assets/app-i18n.js";

register("hubInvitations", {
  en: {
    row: "Invitations · {0}",
    title: "Invitations",
    item: "{0} invited your agent “{1}” to the room “{2}”",
    lead: "The {0} people in the room can @ it there; everyone in the room sees its answers.",
    leadOne: "The 1 person in the room can @ it there; everyone in the room sees its answers.",
    accept: "Accept",
    decline: "Decline",
    gone: "This invitation is no longer open.",
    failed: "That did not go through. Try again.",
    loadFailed: "Invitations could not be loaded.",
    retry: "Try again",
  },
  "zh-TW": {
    row: "邀請 · {0}",
    title: "邀請",
    item: "{0} 邀請你的 Agent「{1}」加入房間「{2}」",
    lead: "房間裡的 {0} 個人可以在那裡 @ 它；它的回答房間裡的人都看得到。",
    leadOne: "房間裡的 1 個人可以在那裡 @ 它；它的回答房間裡的人都看得到。",
    accept: "同意",
    decline: "不要",
    gone: "這個邀請已經不在了。",
    failed: "沒有送出，請再試一次。",
    loadFailed: "無法載入邀請。",
    retry: "再試一次",
  },
});
export const hi = (key, ...args) => t(`hubInvitations.${key}`, ...args);
