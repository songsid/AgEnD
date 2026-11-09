// Read recovery copy is loaded with its consumers, including tabs retaining older group strings.
import { register, t } from "/assets/app-i18n.js";
register("hubRead", {
  en: { noticesRetry: "Live security notices are reconnecting. Retrying shortly…", noticesUnavailable: "Security notices can't be checked right now. Retrying shortly…", busy: "The Hub is busy. Retrying shortly…", catalogUnavailable: "Shared agents can't be checked right now. Retry." },
  "zh-TW": { noticesRetry: "安全通知連線中斷，稍後會自動重試…", noticesUnavailable: "目前無法讀取安全通知，稍後會自動重試…", busy: "Hub 忙碌中，稍後會自動重試…", catalogUnavailable: "目前無法確認已分享的 Agent，請重試。" },
});
export const hr = (key) => t(`hubRead.${key}`);
