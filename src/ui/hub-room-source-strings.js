import { register, t } from "/assets/app-i18n.js";

register("hubRoomSource", {
  en: {
    agend: "AgEnD agent",
    fleet: "An agent in {0}'s Fleet",
    personal: "{0}'s personal agent",
    app: 'Posted by {0} through an AI app. The app gave the name "{1}" itself.',
  },
  "zh-TW": {
    agend: "AgEnD Agent",
    fleet: "{0} 的 Fleet 裡的 Agent",
    personal: "{0} 的個人 Agent",
    app: "由 {0} 透過 AI App 發出。「{1}」是 App 自己提供的名稱。",
  },
});
export const hsource = (key, ...args) => t(`hubRoomSource.${key}`, ...args);
