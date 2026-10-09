// Sign-in page logic. Loaded from /assets/signin.js.
//
// Two jobs: (1) when the page is what a gated URL answered with because the browser sent no cookie
// (a SameSite=Strict cookie is not sent on a navigation that came from a chat app), probe the session
// from *here* — a same-site request does carry the cookie — and carry on to the page that was asked
// for; (2) otherwise take the one-time code and exchange it.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const T = {
    en: {
      checking: "Checking your session…", title: "Sign in to AgEnD", lead: "Enter the one-time code from your chat channel.",
      label: "One-time code", submit: "Sign in", working: "Signing in…",
      hint: "Send /dashboard to your AgEnD bot, or run “agend web --code” on the host. A code works once and expires in 5 minutes.",
      refused: "That code did not work — it may be wrong, expired or already used. Ask for a new one with /dashboard.",
      paused: "Too many wrong codes — sign-in is paused for a few minutes.",
      network: "Could not reach AgEnD. Check the connection and try again.",
    },
    "zh-TW": {
      checking: "正在確認登入狀態…", title: "登入 AgEnD", lead: "請輸入聊天頻道給你的一次性登入碼。",
      label: "一次性登入碼", submit: "登入", working: "登入中…",
      hint: "在 AgEnD bot 傳 /dashboard，或在主機執行「agend web --code」。登入碼只能用一次，5 分鐘內有效。",
      refused: "登入碼無效：可能輸入錯誤、已過期或已使用。請用 /dashboard 再要一個。",
      paused: "錯誤次數過多，登入暫停幾分鐘。",
      network: "連不上 AgEnD，請檢查連線後再試。",
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
  // The command in the hint is a <code> that never breaks across lines (a break inside "--code" reads as two dashes
  // and a word, alpha.2 sweep); the text around it is text.
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
  }

  async function probe() {
    // A second bounce inside ten seconds means the cookie is valid but not being sent on the
    // navigation; going round again would loop, so stop and let the person type a code.
    if (recentlyBounced()) return false;
    try {
      const r = await fetch("/auth/session", { credentials: "same-origin", cache: "no-store" });
      return r.ok;
    } catch { return false; }
  }

  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("go");
    const msg = $("msg");
    msg.textContent = "";
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
      msg.textContent = r.status === 429 ? t("paused") : t("refused");
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
