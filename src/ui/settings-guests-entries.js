// #2348: the Guests section's entries in Settings search (settings-registry.js). A file with no imports of its own, so
// the registry can read them while settings-guests.js (which uses settings-dialogs → settings-registry) is still loading
// (M-3276).
export const GUESTS_SETTINGS = [
  { id: "guests.enabled", section: "access", card: "guests", key: "web.guests.enabled",
    label: { en: "Guest sign-in", "zh-TW": "訪客登入" }, words: { en: ["guest", "sign in", "visitor", "share"], "zh-TW": ["訪客", "登入", "分享"] } },
  { id: "guests.chat", section: "access", card: "guests", key: "web.guests.chat",
    label: { en: "Guests may chat", "zh-TW": "訪客可以聊天" }, words: { en: ["guest", "chat", "read-only"], "zh-TW": ["訪客", "聊天", "唯讀"] } },
  { id: "guests.grants", section: "access", card: "guests", key: "web.guests.grants",
    label: { en: "People with access", "zh-TW": "有存取權的人" }, words: { en: ["guest", "grant", "access", "person", "user", "agents", "who can see"], "zh-TW": ["訪客", "授權", "存取", "使用者", "誰可以看"] } },
  // M-3276: a guest's sign-in length and idle sign-out.
  { id: "guests.session", section: "access", card: "guests", key: "web.guests.session", target: "#guestSession",
    label: { en: "Guest sign-in length", "zh-TW": "訪客登入時長" }, words: { en: ["guest", "session", "sign-in length", "idle", "timeout", "expire", "sign out"], "zh-TW": ["訪客", "登入時長", "閒置", "逾時", "登出", "期限"] } },
  { id: "guests.send-code", section: "access", card: "guests",
    label: { en: "Send sign-in code", "zh-TW": "傳送裝置登入碼" }, words: { en: ["code", "sign-in code", "invite", "token", "DM"], "zh-TW": ["裝置登入碼", "登入碼", "邀請", "私訊"] } },
];
