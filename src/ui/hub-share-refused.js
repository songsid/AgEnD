// M-3007 (alpha.2 re-run): an agent the owner switched on, which the Hub refused to list because the administrator has not
// allowed this person to share agents (#3759 keeps the link up and sends the refusal back). The row says so instead of
// "Shared", its switch is off, and the owner can withdraw the request. Once the administrator allows sharing, the next
// snapshot is accepted and the row is "Shared" again. Its own module, so an older cached hub-strings never shows a raw key.
import { register, t } from "/assets/app-i18n.js";

register("hubShareRefused", {
  en: {
    note: "Not shared: your Hub administrator hasn't allowed you to share agents. It will be shared once they do.",
    withdraw: "Don't share it",
  },
  "zh-TW": {
    note: "未分享：Hub 管理員還沒有允許你分享 Agent。管理員允許後就會自動分享。",
    withdraw: "不要分享",
  },
});
export const hr = (key, ...args) => t(`hubShareRefused.${key}`, ...args);
