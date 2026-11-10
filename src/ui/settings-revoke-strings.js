// AGEND-138 (PR #3553 review round 2): the words of "Revoke other devices' authorization" — a module of their own, on purpose.
//
// settings-access-strings.js already exists on the release base and search-dialog.js / settings-registry.js import it, so a tab that
// opened search before the upgrade holds the OLD copy of that dictionary and the browser hands it back when the new Settings card
// imports the same URL: a key only the new copy had would show as the raw `settings.vaRevokeOthers…` key, in both languages. This
// file's URL is new, so no tab can hold an older copy of it. (The pattern is settings-shared-strings.js #3087 and
// settings-access-strings.js #3061; here the dictionary that would have been reused is itself a cached one.)
//
// Every module that reads one of these keys imports it: the card (settings-web-authority.js) and the search path that prints the
// button's label (settings-registry.js, search-dialog.js). tests/settings-revoke-strings-138.test.ts checks that, and loads the
// card against the base settings-access-strings.js (a fixture of the base bytes) to show that a stale tab still gets every word.
// The old settings.vaRevoke* keys stay in settings-strings.js untouched (a retained older card still finds its words).
import { register } from "/assets/app-i18n.js";

register("settings", {
  en: {
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
