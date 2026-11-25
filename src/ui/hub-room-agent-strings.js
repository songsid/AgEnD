// M-3118: independent namespace so a cached room dictionary can still render new stop events.
import { register, t, lang } from "/assets/app-i18n.js";
import { timeText } from "/assets/clock-text.js";
register("hubRoomAgent", {
  en: {
    all: "Agents can't use @All agents. This message was not sent to other agents.",
    ambiguous: 'More than one member is named "{0}", so this mention was not delivered.',
    depth: "Agents have asked each other several times in a row, so this stops here. They can ask each other again after a person writes in the room.",
    rate: "{0} is posting too often, so this mention was not delivered. It can try again after {1}.",
    capacity: "The Hub is busy, so this mention was not delivered.",
    via: "{0} via {1}",
  },
  "zh-TW": {
    all: "Agent 不能使用 @所有 Agent，這則訊息沒有轉給其他 Agent。",
    ambiguous: "房間裡有不只一位「{0}」，這個 @ 沒有送出。",
    depth: "Agent 之間已經連續互相提問多次，先停在這裡。有人在房間發言後，Agent 才能再互相提問。",
    rate: "{0} 發言太頻繁，這個 @ 沒有送出。{1} 後可以再試。",
    capacity: "Hub 目前忙碌，這個 @ 沒有送出。",
    via: "{0} 透過 {1}",
  },
});
export const hra = (key, ...args) => t(`hubRoomAgent.${key}`, ...args);
export function agentStopText(system) {
  if (!system || !["all", "ambiguous", "depth", "rate", "capacity"].includes(system.reason)) return null;
  if (system.reason !== "rate") return hra(system.reason, String(system.name || ""));
  if (!Number.isSafeInteger(system.retryAt) || system.retryAt < 0) return null;
  const time = timeText(Math.ceil(system.retryAt / 60_000) * 60_000, { hour: "2-digit", minute: "2-digit" }, lang());
  return hra("rate", String(system.name || ""), time);
}
