// Help for existing handlers only. Keyboard behavior stays with app-shell.js, panel-chat.js,
// chat-render.js (composerKey) and panel-settings.js; this module registers no keyboard listener.
import { html } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { isMacLike, showDialog } from "/assets/app-shell.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Icon } from "/assets/ui-icons.js";

register("settingsShortcuts", {
  en: {
    title: "Keyboard shortcuts", button: "View shortcuts",
    hint: "Find the existing shortcuts for search, chat and settings.",
    intro: "Shortcuts work in the contexts below. Search availability depends on your account and the fleet's settings.",
    globalTitle: "Search across the fleet", globalAction: "Open search",
    globalScope: "Works in text fields too, on pages that offer search. Does not run while another modal dialog is open or while an input method is composing. Do not hold Alt or Shift.",
    chatSearchTitle: "Search the current chat", chatSearchAction: "Search within this agent",
    chatSearchScope: "On an agent's chat page, when search is available. Other pages keep the browser's Find command. The same dialog and input-method restrictions apply.",
    composerTitle: "Chat input", send: "Send the message or run the typed command", newline: "Add a new line",
    composerScope: "In the chat composer with a physical keyboard. Enter does not send during input-method composition. On a touch screen, Enter adds a line; use Send to send. Alt, Ctrl or Command with Enter also adds a line.",
    settingsTitle: "Settings search", settingsAction: "Focus Search settings",
    settingsScope: "Only on Settings pages, outside inputs, textareas, selects and editable content. Does not run during input-method composition or with Ctrl, Command or Alt held.",
    closeHint: "Closes this help dialog and returns focus to View shortcuts.",
  },
  "zh-TW": {
    title: "快捷鍵", button: "查看快捷鍵",
    hint: "查看搜尋、聊天與設定目前支援的快捷鍵。",
    intro: "快捷鍵依下列情境使用；搜尋是否提供，取決於你的帳號權限與 Fleet 設定。",
    globalTitle: "全域搜尋", globalAction: "開啟搜尋",
    globalScope: "提供搜尋的頁面中，輸入欄內也可使用。其他對話框開啟時或輸入法組字時不觸發；請勿同時按住 Alt 或 Shift。",
    chatSearchTitle: "搜尋目前聊天", chatSearchAction: "搜尋目前 Agent 的對話",
    chatSearchScope: "在提供搜尋功能的 Agent 聊天頁使用；其他頁面保留瀏覽器的尋找功能。對話框與輸入法的限制同上。",
    composerTitle: "聊天輸入", send: "送出訊息或執行輸入的指令", newline: "新增一行",
    composerScope: "適用於聊天輸入框與實體鍵盤；輸入法組字時，Enter 不會送出。觸控螢幕的 Enter 會換行，請按「送出」傳送。Alt、Ctrl 或 Command 加 Enter 也會換行。",
    settingsTitle: "設定搜尋", settingsAction: "聚焦「搜尋設定」",
    settingsScope: "僅限設定頁面，且焦點不在輸入欄、文字區、選單或可編輯內容內。輸入法組字時，或同時按住 Ctrl、Command、Alt 時不觸發。",
    closeHint: "關閉此說明，焦點會回到「查看快捷鍵」。",
  },
});

export const shortcutsText = (key) => t(`settingsShortcuts.${key}`);

/** The Settings preference row is intentionally independent of saved preferences. */
export function ShortcutsHelpRow() {
  return html`<div class="s-pref-help-row s-pref-shortcuts-row"><div><strong>${shortcutsText("title")}</strong><p class="sub">${shortcutsText("hint")}</p></div>
    <button type="button" id="keyboardShortcutsBtn" class="btn" aria-haspopup="dialog" onClick=${openShortcuts}><${Icon} name="info" size=${16} />${shortcutsText("button")}</button></div>`;
}

export function openShortcuts() { showDialog(ShortcutsDialog); }

/** Reuse the shared modal's native Escape, backdrop and focus-restoration behavior. */
export function ShortcutsDialog({ onClose }) {
  const modifier = isMacLike() ? "⌘" : "Ctrl";
  const keys = (parts) => html`<span class="settings-shortcut-keys">${parts.map((key, i) => html`${i ? html`<span aria-hidden="true">+</span>` : null}<kbd key=${key}>${key}</kbd>`)}</span>`;
  const row = (parts, action) => html`<div class="settings-shortcut-row">${keys(parts)}<span>${shortcutsText(action)}</span></div>`;
  return html`<${Dialog} title=${shortcutsText("title")} onClose=${onClose} wide=${true}
    actions=${html`<button type="button" class="btn btn-primary" onClick=${onClose}>${t("app.close")}</button>`}>
    <div class="settings-shortcuts"><p class="settings-shortcuts-intro">${shortcutsText("intro")}</p>
      <section><h3>${shortcutsText("globalTitle")}</h3>${row([modifier, "K"], "globalAction")}<p>${shortcutsText("globalScope")}</p></section>
      <section><h3>${shortcutsText("chatSearchTitle")}</h3>${row([modifier, "F"], "chatSearchAction")}<p>${shortcutsText("chatSearchScope")}</p></section>
      <section><h3>${shortcutsText("composerTitle")}</h3>${row(["Enter"], "send")}${row(["Shift", "Enter"], "newline")}<p>${shortcutsText("composerScope")}</p></section>
      <section><h3>${shortcutsText("settingsTitle")}</h3>${row(["/"], "settingsAction")}<p>${shortcutsText("settingsScope")}</p></section>
      <p class="settings-shortcuts-close"><kbd>Escape</kbd> ${shortcutsText("closeHint")}</p>
    </div>
  </${Dialog}>`;
}
