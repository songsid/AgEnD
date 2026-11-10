// TEMPORARY (#3486): the minimum page for trying "sign in with your own authenticator" by hand; the leader's sign-in page replaces it.
// It posts {account, code} to /auth/totp and reads the answer as docs/SECURITY.md says: 200 signed in; 401 wrong_code (one answer for a
// wrong code, a name that is nobody's and an admin with no app); 429 paused (retryAfterMs); 404 not available here; 5xx unavailable.
(function () {
  "use strict";
  const T = {
    en: {
      title: "Sign in with your authenticator", lead: "Use the authenticator app you set up in AgEnD for your own account.",
      account: "Your account name", code: "6-digit code", submit: "Sign in", working: "Signing in…",
      hint: "Your account name is your chat handle or user id, shown in Settings → Access & security → Owner verification. No authenticator yet? Use the sign-in code from chat instead.",
      back: "Use a sign-in code instead",
      refused: "That did not work. Check the account name and the newest code in your app (and that the phone's clock is right).",
      refused_hint: "If you are sure the code is right, sign-in may be limited for a while: use the 8-character sign-in code instead, or a device you have signed in from before.",
      paused: "Too many wrong tries. Try again in {duration}.", minutes: "{0} minutes", minute: "1 minute", hours: "{0} hours", hour: "1 hour",
      closed: "Signing in with an authenticator is not available here.", failed: "Could not sign in. Try again.", network: "Cannot reach AgEnD. Check the connection.",
    },
    "zh-TW": {
      title: "用驗證器登入", lead: "請使用你在 AgEnD 為自己帳號設定的驗證器 App。",
      account: "你的帳號名稱", code: "6 位數驗證碼", submit: "登入", working: "登入中…",
      hint: "帳號名稱是你的聊天帳號代號或使用者 ID，可在「設定 → 存取與安全 → 擁有者驗證」看到。還沒設定驗證器？請改用聊天傳來的登入碼。",
      back: "改用登入碼",
      refused: "無法登入。請確認帳號名稱，以及 App 裡最新的驗證碼（和手機時間是否正確）。",
      refused_hint: "如果確定驗證碼正確，可能暫時被限制了：請改用 8 碼登入碼，或用之前登入過的裝置。",
      paused: "錯誤次數太多，請 {duration} 後再試。", minutes: "{0} 分鐘", minute: "1 分鐘", hours: "{0} 小時", hour: "1 小時",
      closed: "這裡無法使用驗證器登入。", failed: "無法登入，請再試一次。", network: "連不上 AgEnD，請檢查連線。",
    },
  };
  const lang = /^zh/i.test(navigator.language || "") ? "zh-TW" : "en";
  const t = (k) => T[lang][k] || T.en[k] || k;
  const $ = (id) => document.getElementById(id);
  document.documentElement.lang = lang === "zh-TW" ? "zh-Hant" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.getAttribute("data-i18n")); });
  // A web-only fleet has one admin: no name to give.
  const webOnly = new URLSearchParams(location.search).get("webonly") === "1" || document.body.getAttribute("data-web-only") === "1";
  if (webOnly) $("accountRow").hidden = true;
  const duration = (ms) => {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    if (minutes < 60) return minutes === 1 ? t("minute") : t("minutes").replace("{0}", String(minutes));
    const hours = Math.ceil(minutes / 60);
    return hours === 1 ? t("hour") : t("hours").replace("{0}", String(hours));
  };
  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("go"), msg = $("msg");
    msg.textContent = ""; button.disabled = true; button.textContent = t("working");
    try {
      const r = await fetch("/auth/totp", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webOnly ? { code: $("code").value } : { account: $("account").value, code: $("code").value }),
      });
      if (r.ok) { location.replace("/ui"); return; }
      if (r.status === 429) {
        let wait = Number(r.headers.get("Retry-After")) * 1000;
        try { const body = await r.json(); if (Number.isFinite(body && body.retryAfterMs)) wait = body.retryAfterMs; } catch { /* the header's */ }
        msg.textContent = t("paused").replace("{duration}", duration(Number.isFinite(wait) && wait > 0 ? wait : 60000));
      } else msg.textContent = r.status === 401 ? `${t("refused")} ${t("refused_hint")}` : r.status === 404 ? t("closed") : t("failed");
    } catch { msg.textContent = t("network"); }
    button.disabled = false; button.textContent = t("submit"); $("code").select();
  });
})();
