// Sign-in page logic. Loaded from /assets/signin.js.
//
// Two jobs: (1) when the page is what a gated URL answered with because the browser sent no cookie
// (a SameSite=Strict cookie is not sent on a navigation that came from a chat app), probe the session
// from *here* — a same-site request does carry the cookie — and carry on to the page that was asked
// for; (2) otherwise take the one-time code and exchange it. A browser that signed in before with a code from
// /web (a returning device, #1570) is also offered "Send me a new code": the server sends it privately to the
// person who received that earlier code — the page never learns who that is.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const T = {
    en: {
      checking: "Checking your session…", title: "Sign in to AgEnD", lead: "Enter your sign-in code.",
      label: "One-time code", submit: "Sign in", working: "Signing in…",
      hint: "No code? Send /web in General, then press a sign-in button to get one.",
      nobot: "No chat bot?", nobot_body: "Ask the operator to run agend web --code on the AgEnD computer.",
      safe: "Page looks wrong after signing in?", safe_body: "Your custom CSS may be hiding something. Add ?safe=1 to the end of the address to load the page without it, then fix it or turn it off in Settings → Web appearance.",
      refused: "The code is invalid or no longer works. Send /web in General, then press a sign-in button for a new code.",
      unconfirmed: "Sign-in could not be confirmed. Get a new code and try again; if it keeps failing, contact the operator.",
      paused: "Too many wrong codes — sign-in is paused for a few minutes.",
      network: "Could not reach AgEnD. Check the connection and try again.",
      resend: "Send me a new code", resent: "A new code was sent to you privately in chat. Enter it above.",
      resend_wait: "A code was asked for a moment ago — wait a little and try again.",
      resend_refused: "A new code could not be sent. Ask for one with /web.",
    },
    "zh-TW": {
      checking: "正在確認登入狀態…", title: "登入 AgEnD", lead: "輸入登入碼。",
      label: "一次性登入碼", submit: "登入", working: "登入中…",
      hint: "沒收到？在 General 傳 /web，再按登入按鈕取碼。",
      nobot: "沒有聊天 bot？", nobot_body: "請管理員在 AgEnD 電腦執行 agend web --code。",
      safe: "登入後畫面不對勁？", safe_body: "可能是你的自訂 CSS 把東西藏起來了。在網址最後加上 ?safe=1，就會不套用它地載入；再到「設定 → 網頁外觀」修正或關閉。",
      refused: "登入碼無效或已失效。請在 General 傳 /web，再按登入按鈕取新碼。",
      unconfirmed: "登入暫時無法確認。請重新取碼再試；若仍失敗，請聯絡管理員。",
      paused: "錯誤次數過多，登入暫停幾分鐘。",
      network: "連不上 AgEnD，請檢查連線後再試。",
      resend: "傳一組新的登入碼給我", resent: "新的登入碼已私訊給你，請在上方輸入。",
      resend_wait: "剛剛才要過登入碼，請稍候再試。",
      resend_refused: "無法傳送新的登入碼。請用 /web 再要一個。",
    },
  };
  const lang = /^zh/i.test(navigator.language || "") ? "zh-TW" : "en";
  const t = (k) => T[lang][k] || T.en[k] || k;
  document.documentElement.lang = lang === "zh-TW" ? "zh-Hant" : "en";

  // An old dashboard link carries `?token=`. It is not a credential any more (the server ignored it and
  // answered with this page), but it is still the fleet's token: take it out of the address bar and
  // the history entry at once, so it is not copied, bookmarked or shared from here.
  try {
    const here = new URL(location.href);
    if (here.searchParams.has("token")) {
      here.searchParams.delete("token");
      history.replaceState(null, "", here.pathname + here.search + here.hash);
    }
  } catch { /* nothing to clean */ }
  // The command in the "No chat bot?" help is a <code> that never breaks across lines (a break inside "--code" reads as
  // two dashes and a word, alpha.2 sweep); the text around it is text.
  const CMD = "agend web --code";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const text = t(el.getAttribute("data-i18n"));
    const at = text.indexOf(CMD);
    if (at < 0) { el.textContent = text; return; }
    const code = document.createElement("code");
    code.textContent = CMD;
    el.replaceChildren(text.slice(0, at), code, text.slice(at + CMD.length));
  });

  // An old deep link, /ui#instance=<name> (#1408 §3): the fragment never reaches the server, and the sign-in page is
  // served at the URL that was asked for, so it is still in location.hash here. Exactly that one form becomes the new
  // path /ui/chat/<name>; any other fragment is dropped. The name is held to the same rule as the server's.
  function legacyChatTarget(pathname, hash) {
    if (pathname !== "/ui") return null;
    const m = /^#instance=([^&#]*)$/.exec(hash || "");
    if (!m) return null;
    let name;
    try { name = decodeURIComponent(m[1]); } catch { return null; }
    if (!name || name.length > 128 || /[/\\\u0000-\u001f\u007f]/.test(name) || name === "." || name.includes("..")) return null;
    return "/ui/chat/" + encodeURIComponent(name);
  }

  // Where to go afterwards: only the app's pages, never an arbitrary URL.
  function nextTarget() {
    let candidate = new URLSearchParams(location.search).get("next");
    if (!candidate && location.pathname !== "/signin") {
      const legacy = legacyChatTarget(location.pathname, location.hash);
      if (legacy) return legacy;
      candidate = location.pathname + location.search;
    }
    try {
      const u = new URL(candidate || "/ui", location.origin);
      u.searchParams.delete("token");
      const path = u.pathname;
      if (u.origin === location.origin && /^\/(ui|view|settings)(\/|$)/.test(path) && !candidate.includes("\\")) return path + u.search;
    } catch { /* fall through */ }
    return "/ui";
  }

  const BOUNCE_KEY = "agend_signin_bounce";
  function recentlyBounced() {
    try { return Date.now() - Number(sessionStorage.getItem(BOUNCE_KEY) || 0) < 10000; } catch { return false; }
  }
  function markBounce() { try { sessionStorage.setItem(BOUNCE_KEY, String(Date.now())); } catch { /* private mode */ } }
  function clearBounce() { try { sessionStorage.removeItem(BOUNCE_KEY); } catch { /* private mode */ } }

  function showForm() {
    $("checking").hidden = true;
    $("form").hidden = false;
    // A sign-out the server could not make durable says so here, once (agend-auth.js signOut).
    try {
      const note = sessionStorage.getItem("agend_signout_note");
      if (note) { sessionStorage.removeItem("agend_signout_note"); $("msg").textContent = note; }
    } catch { /* private mode */ }
    $("code").focus();
    offerResend();
  }

  // Only a returning device gets the button; the answer is a boolean and asking has no side effect.
  async function offerResend() {
    try {
      const r = await fetch("/auth/device", { credentials: "same-origin", cache: "no-store" });
      if (r.ok && (await r.json()).returning === true) $("resend").hidden = false;
    } catch { /* no button */ }
  }

  $("resend").addEventListener("click", async () => {
    const button = $("resend");
    const msg = $("msg");
    msg.textContent = "";
    msg.classList?.remove("ok");
    button.disabled = true;
    try {
      const r = await fetch("/auth/request-code", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (r.status === 202) { msg.classList?.add("ok"); msg.textContent = t("resent"); $("code").focus(); }
      else if (r.status === 429) msg.textContent = t("resend_wait");
      else { msg.textContent = t("resend_refused"); if (r.status === 401) button.hidden = true; }
    } catch {
      msg.textContent = t("network");
    }
    button.disabled = false;
  });

  async function probe() {
    // A second bounce inside ten seconds means the cookie is valid but not being sent on the
    // navigation; going round again would loop, so stop and let the person type a code.
    if (recentlyBounced()) return false;
    try {
      // Signed out, this answers 401 — and the browser logs that request in red in DevTools. That is expected: the
      // probe asks "is there a session?", and no is a normal answer here (decided against reshaping the auth API).
      const r = await fetch("/auth/session", { credentials: "same-origin", cache: "no-store" });
      return r.ok;
    } catch { return false; }
  }

  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("go");
    const msg = $("msg");
    msg.textContent = "";
    msg.classList?.remove("ok");
    button.disabled = true;
    button.textContent = t("working");
    try {
      const r = await fetch("/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: $("code").value }),
      });
      if (r.ok) { clearBounce(); location.replace(nextTarget()); return; }
      // #1854: a 5xx is the server failing to confirm the sign-in (503: a public link's notice did not go out), not a
      // wrong code — say so. The code is spent either way: the way on is a new one.
      msg.textContent = r.status === 429 ? t("paused") : r.status >= 500 ? t("unconfirmed") : t("refused");
    } catch {
      msg.textContent = t("network");
    }
    button.disabled = false;
    button.textContent = t("submit");
    $("code").select();
  });

  probe().then((signedIn) => {
    if (signedIn) { markBounce(); location.replace(nextTarget()); return; }
    showForm();
  });
})();
