// M-3765: the Files tab's "show what git ignores" toggle, registered by its own module (workspace-panel.js imports it): a
// page holding an older cached workspace-strings.js never shows a raw key (the module-skew rule, #3155).
import { register } from "/assets/app-i18n.js";

register("chat", {
  en: {
    wsShowIgnored: "Show git-ignored files",
    wsShowIgnoredTitle: "Also list what .gitignore leaves out, such as build output and dependencies. Secret-looking files stay hidden. soul.md is always listed.",
    wsIgnored: "ignored by git",
  },
  "zh-TW": {
    wsShowIgnored: "顯示 git 忽略的檔案",
    wsShowIgnoredTitle: "一併列出 .gitignore 排除的項目，例如建置輸出和相依套件。看起來像機密的檔案仍會隱藏。soul.md 一律會列出。",
    wsIgnored: "git 已忽略",
  },
});
