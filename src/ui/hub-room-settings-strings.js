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
    assistantSwitch: "Room assistant",
  },
  "zh-TW": {
    expiredRow: "{0}（{1}）· 邀請已過期", expiredRowNoOwner: "{0} · 邀請已過期",
    pendingRowNoOwner: "{0} · 已邀請，等擁有者同意",
    inviteAgain: "重新邀請",
    rowMenu: "{0} 的更多動作",
    save: "儲存",
    saveFailed: "沒有儲存，請再試一次。",
    assistantSwitch: "房間助理",
  },
});
export const hs = (key, ...args) => t(`hubRoomSettings.${key}`, ...args);
