/** New flow copy stays with the fresh modules even when a tab holds the older B2 dictionary. */
import { register, t } from "/assets/app-i18n.js";
import { he } from "./hub-enrolment-code-strings.js";
register("joinCodeFlow", {
  en: {
    liveLimit: "At most 8 join codes can be live. End one before creating another.",
    hourlyLimit: "At most 10 join codes can be created in one hour. Try again later.",
    endTitle: "End this join code?", endConfirm: "This code cannot be used again.",
    endPending: "{0} Fleet connections in progress will stop.", endNames: "Including these Fleets:", endOthers: "And {0} others.",
    endUnchanged: "Fleets already connected are unchanged.", queuedProgress: "Waiting in the queue… Retry {0} of 8.",
  },
  "zh-TW": {
    liveLimit: "最多 8 組有效的加入碼，請先停用一組，再建立新的加入碼。",
    hourlyLimit: "一小時內最多建立 10 組加入碼，請晚點再試。",
    endTitle: "停用這組加入碼？", endConfirm: "這組加入碼將無法再使用。",
    endPending: "正在連接的 {0} 台 Fleet 將中斷。", endNames: "包含以下 Fleet：", endOthers: "以及另外 {0} 台。",
    endUnchanged: "已連接的 Fleet 不受影響。", queuedProgress: "正在排隊…第 {0} 次重試，共 8 次。",
  },
});
export const jf = (key, ...args) => t(`joinCodeFlow.${key}`, ...args);
/** An older hook has no attempt counter: retain the truthful generic queue message. */
export const queueMessage = attempt => Number.isInteger(attempt) && attempt >= 1 && attempt <= 8 ? jf("queuedProgress", attempt) : he("queued");
