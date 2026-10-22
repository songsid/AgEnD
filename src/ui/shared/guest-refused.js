// What a guest's browser is shown for a page it cannot open. Loaded from /assets/guest-refused.js.
//
// The gate answers a guest's navigation with this page instead of its JSON (#2399 smoke): "members" for a page that is
// not a guest's (Fleet, Settings…), "ended" when no chat is shared with the guest any more. The page's words are in
// the browser's language, as the sign-in page's are; the HTML carries the English for a browser without scripts.
(() => {
  "use strict";
  const T = {
    en: {
      members_title: "This page is not open to guests",
      members_lead: "This page is for the fleet's members. As a guest you can use the chats shared with you.",
      members_go: "Open your chats",
      ended_title: "No chats are shared with you",
      ended_lead: "Your guest access on this fleet has no chat now — you may have left the room it came from. Ask whoever invited you to share a chat with you again.",
    },
    "zh-TW": {
      members_title: "訪客無法開啟這個頁面",
      members_lead: "這個頁面只給 fleet 的成員使用。身為訪客，你可以使用分享給你的聊天。",
      members_go: "打開你的聊天",
      ended_title: "目前沒有分享給你的聊天",
      ended_lead: "你在這個 fleet 的訪客權限目前沒有任何聊天——你可能已經離開當初的頻道。請聯絡邀請你的人，再分享聊天給你。",
    },
  };
  const lang = /^zh/i.test(navigator.language || "") ? "zh-TW" : "en";
  const t = (k) => T[lang][k] || T.en[k] || k;
  document.documentElement.lang = lang === "zh-TW" ? "zh-Hant" : "en";
  const main = document.getElementById("refused");
  const why = main && main.dataset.why === "ended" ? "ended" : "members";
  document.getElementById("title").textContent = t(`${why}_title`);
  document.getElementById("lead").textContent = t(`${why}_lead`);
  // Nothing to open when no chat is shared (the chats would answer this page again): no button then.
  const go = document.getElementById("go");
  if (go) { if (why === "ended") go.remove(); else go.textContent = t("members_go"); }
  document.title = `AgEnD — ${t(`${why}_title`)}`;
})();
