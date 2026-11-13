// Hub rooms, invitations on the owner's side (docs/design/hub-rooms-ux.md section 8): only the words the shared room
// vocabulary (hub-room-strings.js, namespace hubRoom) does not have. A module of its own, so a tab holding an older
// dictionary still has every word (upgrade skew).
import { register, t } from "/assets/app-i18n.js";

register("hubInvitations", {
  en: {
    leadOne: "The 1 person in the room can @ it there; everyone in the room sees its answers.",
    gone: "This invitation is no longer open.",
    failed: "That did not go through. Try again.",
    loadFailed: "Invitations could not be loaded.",
    retry: "Try again",
    roomPeople: "{0} · {1} people",
    leaveFailed: "It did not leave the room. Try again.",
  },
  "zh-TW": {
    leadOne: "房間裡的 1 個人可以在那裡 @ 它；它的回答房間裡的人都看得到。",
    gone: "這個邀請已經不在了。",
    failed: "沒有送出，請再試一次。",
    loadFailed: "無法載入邀請。",
    retry: "再試一次",
    roomPeople: "{0} · {1} 人",
    leaveFailed: "沒有退出房間，請再試一次。",
  },
});
export const hi = (key, ...args) => t(`hubInvitations.${key}`, ...args);
