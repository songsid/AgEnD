// Grant feedback lives in a fresh module, including in a tab that cached the older owner dictionary.
import { register, t } from "/assets/app-i18n.js";
register("hubGrant", {
  en: {
    recipientRefused: "This account can't be allowed here. Check the sign-in name and that the account is active, then try again.",
    directoryUnavailable: "The directory couldn't be checked. Try again later.",
  },
  "zh-TW": {
    recipientRefused: "目前無法允許這個帳號。請確認登入名稱正確、帳號仍可使用，再試一次。",
    directoryUnavailable: "目前無法查核目錄服務，請稍後再試。",
  },
});
export const hg = (key, ...values) => t(`hubGrant.${key}`, ...values);
