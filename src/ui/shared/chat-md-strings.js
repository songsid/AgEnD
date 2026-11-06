// M-2448 (Prism on #3155): the Markdown side panel's own words, registered by the panel's module (preview-panel.js). A
// page that opened Log or Details before an upgrade may hold an older chat-strings.js without them; these keep the
// panel saying what it shows, never a raw key.
import { register } from "./app-i18n.js";

register("chat", {
  en: { pvMdPanel: "Markdown preview", pvMdRendered: "Formatted", pvMdSource: "Source" },
  "zh-TW": { pvMdPanel: "Markdown 預覽", pvMdRendered: "排版", pvMdSource: "原始內容" },
});
