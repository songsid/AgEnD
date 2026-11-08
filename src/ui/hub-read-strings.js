// Read recovery copy is loaded with its consumers, including tabs retaining older group strings.
import { register, t } from "/assets/app-i18n.js";
register("hubRead", {
  en: { busy: "The Hub is busy. Retrying shortly…", catalogUnavailable: "Shared agents can't be checked right now. Retry." },
  "zh-TW": { busy: "Hub 忙碌中，稍後會自動重試…", catalogUnavailable: "目前無法確認已分享的 Agent，請重試。" },
});
export const hr = (key) => t(`hubRead.${key}`);
