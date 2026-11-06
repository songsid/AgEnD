// Refs #3061: the words Access & security added to modules a tab can already hold from before an upgrade, kept in a file of their
// own on purpose (the pattern settings-shared-strings.js documents, #3087).
//
// Why a file of their own: Fleet and search import settings-strings.js and settings-layout.js (panel-fleet.js → settings-dialogs.js,
// search-dialog.js → settings-registry.js). A tab that visited either before the upgrade has already run the old copies, and the
// browser hands the same module back when the new Settings page imports that URL again — so a key only the new file had would read
// as the raw `settings.…` / `settingsLayout.…` key there, in both languages. This file's URL is new, so no tab can hold an old
// copy of it: every module that draws one of these words imports it, and register() merges its words into the same tables.
//
// Rules for this file (the same as settings-shared-strings.js):
// - A key lives here or in settings-strings.js / settings-layout.js, never in both. A change to Access & security that adds a word
//   to one of those modules (one an open Fleet or search tab already holds) puts it here instead.
// - Every module that reads one of these keys imports "./settings-access-strings.js": the Settings page (panel-settings.js), the
//   search path (settings-registry.js, search-dialog.js) and the Web authorization card (settings-web-authority.js).
//   tests/settings-access-strings-3061.test.ts checks that every module that reads a key from here imports this file.
// - The strings of modules no tab can have loaded before (settings-devices.js is new) stay in the module that draws them.
import { register } from "/assets/app-i18n.js";

register("settings", {
  en: {
    webLoginQr: "Show a QR code when a new device signs in with another device",
    webLoginQrHint: "On the new device's sign-in page, beside the 8-character code. It holds only that page's address and the code, never a credential, and approving still takes a device signed in as the owner. Off by default; it has no effect on a fleet with a chat connection.",
  },
  "zh-TW": {
    webLoginQr: "新裝置用其他裝置登入時顯示 QR Code",
    webLoginQrHint: "顯示在新裝置登入頁、8 碼代碼旁邊。裡面只有該頁面的網址和代碼，沒有任何憑證；核准仍需要已登入並驗證擁有者的裝置。預設關閉；有連接聊天平台的 fleet 不受影響。",
  },
});

// The Web authorization card on a fleet with no chat connection (settings-web-authority.js; layoutText reads settingsLayout.*).
register("settingsLayout", {
  en: {
    revAuthorityBriefWeb: "This fleet has no chat platform connected. The host owner can verify directly; a remote session confirms who the owner is with the authenticator.",
    revAuthorityEnabledWeb: "Allow web authorization by a verified owner",
    revAuthorityRule: "Signing in a device and authorizing an action are judged separately. When this is off, even a verified web session cannot approve actions that need authority.",
  },
  "zh-TW": {
    revAuthorityBriefWeb: "這個 fleet 未連接聊天平台。主機 owner 可直接驗證；遠端工作階段需透過驗證器確認擁有者身分。",
    revAuthorityEnabledWeb: "允許已驗證擁有者的網頁授權",
    revAuthorityRule: "裝置登入與擁有者授權分開判斷。關閉後，已驗證的網頁工作階段也不能核准需授權的操作。",
  },
});
