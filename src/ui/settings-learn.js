// #2056 B: a card title with a small "?" that opens the card's section of the docs, so Settings → Web appearance
// keeps one short line per control and the long explanations live in docs/web-dashboard(.zh-TW).md.
import { html } from "/assets/app-html.js";
import { lang, t } from "/assets/app-i18n.js";
import "./settings-strings.js";

/**
 * #2056 B: where each card's long explanation lives — a heading of docs/web-dashboard(.zh-TW).md on GitHub, so the
 * page keeps one short line per control and a small "?" for the rest.
 */
const DOCS = { en: "https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.md", "zh-TW": "https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.zh-TW.md" };
export const LEARN_ANCHORS = {
  colors: ["identity-colours", "識別色"], css: ["custom-css-settings--web-appearance", "自訂-css設定--網頁外觀"], themes: ["agents-themes", "agent-的主題"],
  cards: ["identity-cards", "身分卡"], limits: ["card-upload-limits", "身分卡上傳限制"], widgets: ["widgets", "小工具"], mods: ["mods", "mod"],
  effects: ["effects", "效果"], restore: ["restore-defaults", "還原預設值"],
};
export function learnHref(topic, language = lang()) {
  const zh = language === "zh-TW";
  return `${DOCS[zh ? "zh-TW" : "en"]}#${encodeURIComponent(LEARN_ANCHORS[topic][zh ? 1 : 0])}`;
}
/** A card title with its "?" link to the docs (a new tab; the page itself never fetches anything). */
export function CardTitle({ title, topic }) {
  return html`<h3 class="s-ap-title"><span>${title}</span>${topic ? html`<a class="s-learn" href=${learnHref(topic)} target="_blank" rel="noopener noreferrer"
    aria-label=${t("settings.learnMore", title)} title=${t("settings.learnMore", title)}>?</a>` : null}</h3>`;
}
