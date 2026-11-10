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
    webLoginQrHint: "顯示在新裝置登入頁、8 碼裝置登入碼旁邊。裡面只有該頁面的網址和裝置登入碼，沒有任何憑證；核准仍需要已登入並驗證擁有者的裝置。預設關閉；有連接聊天平台的 fleet 不受影響。",
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

// AGEND-138 (PR #3553 review): the revoke card's words (see above for why they live here).
register("settings", {
  en: {
    // AGEND-138 (PR #3553 review): "Revoke other devices' authorization". New keys on purpose (the old settings.vaRevoke* stay in
    // settings-strings.js untouched): a tab that already ran the previous settings-strings.js must not read a missing key.
    vaRevokeOthers: "Revoke other devices' authorization", vaRevokeOthersTitle: "Revoke other devices' authorization?",
    vaRevokeOthersConfirm: "Every other device's authorization ends, and every authority given from the web so far reads as none. Nobody is signed out, and this does not end any session's ability to confirm Settings changes: to make a session stop working, use Sign out everywhere or /web revoke.",
    vaRevokeAffected: "These devices lose their authorization: {0}.", vaRevokeNoOthers: "No other device is authorized now.", vaRevokeKept: "This device (you) stays authorized.", vaRevokeOwnerOnly: "Only a verified owner can revoke.",
    vaRevokedOthers: "Other devices' authorization is revoked. This device stays authorized.", vaRevokedAll: "Web authority given so far is revoked, this device's included.",
  },
  "zh-TW": {
    vaRevokeOthers: "撤銷其他裝置的授權", vaRevokeOthersTitle: "撤銷其他裝置的授權？",
    vaRevokeOthersConfirm: "其他裝置的授權都會結束，到目前為止從網頁給出的授權也都視為無。不會登出任何人，也不會讓任何 session 失去確認設定變更的能力：要讓某個 session 失效，請用「全部登出」或 /web revoke。",
    vaRevokeAffected: "這些裝置會失去授權：{0}。", vaRevokeNoOthers: "目前沒有其他已授權的裝置。", vaRevokeKept: "這台裝置（你）會保留授權。", vaRevokeOwnerOnly: "只有已驗證擁有者能撤銷。",
    vaRevokedOthers: "已撤銷其他裝置的授權，這台裝置仍保有授權。", vaRevokedAll: "已撤銷到目前為止的網頁授權，包含這台裝置。",
  },
});
