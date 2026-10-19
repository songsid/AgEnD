// #1629 r4 §1 / r4.1: the identity card's words (card.*), in English and zh-TW. Public (/assets/): View's anonymous
// reader sees a card too.
import { register } from "./app-i18n.js";

register("card", {
  en: {
    label: "Identity card of {0}",
    portraitAlt: "{0}'s portrait",
    size: "Card size",
    sizeS: "S", sizeM: "M", sizeL: "L",
    sizeSName: "Small", sizeMName: "Medium", sizeLName: "Large",
    byHuman: "set by a person",
    byAgent: "set by the agent",
    show: "Show card",
    hide: "Hide card",
    showRow: "Show picture and bio",
    hideRow: "Hide picture and bio",
    bannerSafe: "Every screen",
    bannerPhone: "Phone · M card",
  },
  "zh-TW": {
    label: "{0} 的身分卡",
    portraitAlt: "{0} 的肖像",
    size: "卡片大小",
    sizeS: "小", sizeM: "中", sizeL: "大",
    sizeSName: "小", sizeMName: "中", sizeLName: "大",
    byHuman: "由人設定",
    byAgent: "由 agent 設定",
    show: "顯示卡片",
    hide: "隱藏卡片",
    showRow: "顯示小圖與介紹",
    hideRow: "隱藏小圖與介紹",
    bannerSafe: "所有螢幕",
    bannerPhone: "手機 · 中卡片",
  },
});
