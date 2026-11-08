// Kept with the new card behavior so a cached earlier hub-strings module cannot expose raw keys.
import { register, t } from "/assets/app-i18n.js";
register("hubPairingProgress", {
  en: {
    connectFailed: "Pairing did not finish. Start a new pairing on the Hub and use its new code here.",
    notApplied: "This request was not applied. Check the pairing status above before trying again.",
    unknown: "The result cannot be checked right now. Review the pairing status and the confirmation card before trying again.",
  },
  "zh-TW": {
    connectFailed: "配對未完成。請在 Hub 重新開始配對，再將新的代碼填在這裡。",
    notApplied: "這次要求未套用。請先查看上方的配對狀態，再決定是否重試。",
    unknown: "目前無法確認結果。請先查看配對狀態與確認卡片，再決定是否重試。",
  },
});
export const hp = key => t(`hubPairingProgress.${key}`);
