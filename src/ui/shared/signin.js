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
      safe: "Page looks wrong after signing in?", safe_body: "Your custom CSS may be hiding something. Add ?safe=1 to the end of the address to load the page without it, then fix it or turn it off in Settings → Look.",
      refused: "The code is invalid or no longer works. Send /web in General, then press a sign-in button for a new code.",
      unconfirmed: "Sign-in could not be confirmed. Get a new code and try again; if it keeps failing, contact the operator.",
      paused: "Too many wrong codes — sign-in is paused for a few minutes.",
      network: "Could not reach AgEnD. Check the connection and try again.",
      resend: "Send me a new code", resent: "A new code was sent to you privately in chat. Enter it above.",
      resend_wait: "A code was asked for a moment ago — wait a little and try again.",
      resend_refused: "A new code could not be sent. Ask for one with /web.",
      // #2910 D5: a web-only fleet (no chat connection): there is no /web to send — the code comes from the AgEnD computer.
      hint_web: "On the AgEnD computer, run agend web --code to get a sign-in code.",
      refused_web: "The code is invalid or no longer works. Run agend web --code on the AgEnD computer for a new one.",
      resend_refused_web: "A new code could not be sent. Run agend web --code on the AgEnD computer for one.",
      // #3008: through the link "Allow connections from outside" opened — the authenticator app's code (the leader's wording).
      label_outside: "Authenticator code", lead_outside: "Open your authenticator app and enter the 6-digit code for AgEnD.",
      hint_outside: "Lost your phone? On the AgEnD computer, choose \u201cSet up again\u201d.",
      refused_outside: "That code didn't work. Check that your phone's clock is right and try the newest code.",
      paused_outside: "Too many wrong codes. Try again in {duration}.",
      minutes: "{0} minutes", minute: "1 minute", hours: "{0} hours", hour: "1 hour",
      // #3061: sign in with another device — an 8-character code shown here, approved on a device that is already signed in.
      another: "Sign in with another device", dev_title: "Sign in with another device",
      dev_lead: "On a device that is already signed in to AgEnD as the owner, open Settings → Access & security → Add device and enter this code.",
      dev_waiting: "Waiting for approval… Expires in {time}.", dev_approved: "Approved — signing in…",
      dev_expired: "This code has expired.", dev_denied: "This request was denied.", dev_new: "Get a new code", dev_back: "Back",
      dev_busy: "Too many devices are waiting right now. Try again in a moment.", dev_limited: "Too many codes asked for. Try again in {duration}.",
      dev_unavailable: "Signing in with another device isn't available here.", dev_failed: "Could not get a code. Check the connection and try again.",
      dev_lost: "Could not reach AgEnD. Still trying…",
    },
    "zh-TW": {
      checking: "正在確認登入狀態…", title: "登入 AgEnD", lead: "輸入登入碼。",
      label: "一次性登入碼", submit: "登入", working: "登入中…",
      hint: "沒收到？在 General 傳 /web，再按登入按鈕取碼。",
      nobot: "沒有聊天 bot？", nobot_body: "請管理員在 AgEnD 電腦執行 agend web --code。",
      safe: "登入後畫面不對勁？", safe_body: "可能是你的自訂 CSS 把東西藏起來了。在網址最後加上 ?safe=1，就會不套用它地載入；再到「設定 → 外觀」修正或關閉。",
      refused: "登入碼無效或已失效。請在 General 傳 /web，再按登入按鈕取新碼。",
      unconfirmed: "登入暫時無法確認。請重新取碼再試；若仍失敗，請聯絡管理員。",
      paused: "錯誤次數過多，登入暫停幾分鐘。",
      network: "連不上 AgEnD，請檢查連線後再試。",
      resend: "傳一組新的登入碼給我", resent: "新的登入碼已私訊給你，請在上方輸入。",
      resend_wait: "剛剛才要過登入碼，請稍候再試。",
      resend_refused: "無法傳送新的登入碼。請用 /web 再要一個。",
      hint_web: "在 AgEnD 電腦上執行 agend web --code 取得登入碼。",
      refused_web: "登入碼無效或已失效。請在 AgEnD 電腦上執行 agend web --code 取得新碼。",
      resend_refused_web: "無法傳送新的登入碼。請在 AgEnD 電腦上執行 agend web --code 取得。",
      label_outside: "驗證器代碼", lead_outside: "打開驗證器 App，輸入 AgEnD 的 6 位數代碼。",
      hint_outside: "手機遺失？請在 AgEnD 電腦上選「重新設定」。",
      refused_outside: "代碼不對。請確認手機時間正確，並輸入最新的代碼。",
      paused_outside: "錯誤次數太多，請 {duration} 後再試。",
      minutes: "{0} 分鐘", minute: "1 分鐘", hours: "{0} 小時", hour: "1 小時",
      another: "使用其他裝置登入", dev_title: "使用其他裝置登入",
      dev_lead: "在已登入且已驗證擁有者的裝置上，開啟「設定 → 存取與安全 → 新增裝置」，輸入這組代碼。",
      dev_waiting: "等待核准中… {time} 後失效。", dev_approved: "已核准，登入中…",
      dev_expired: "這組代碼已失效。", dev_denied: "這個請求已被拒絕。", dev_new: "取得新代碼", dev_back: "返回",
      dev_busy: "目前等待核准的裝置太多，請稍後再試。", dev_limited: "要求代碼的次數太多，請 {duration} 後再試。",
      dev_unavailable: "這裡無法使用其他裝置登入。", dev_failed: "無法取得代碼。請檢查連線後再試。",
      dev_lost: "連不上 AgEnD，仍在重試…",
    },
  };
  const lang = /^zh/i.test(navigator.language || "") ? "zh-TW" : "en";
  // #2910 D5: the server marks a web-only fleet's page (<body data-web-only="1">): its own words where it has them.
  const webOnly = !!document.body && document.body.getAttribute("data-web-only") === "1";
  // #3008: …and one served through the link "Allow connections from outside" opened (<body data-outside="1">): signing in
  // is the authenticator app's code, posted to /auth/totp.
  const outside = webOnly && document.body.getAttribute("data-outside") === "1";
  // #3061: …and one on this computer's own listener (<body data-device-login="1">, never the public link) offers "Sign in
  // with another device".
  const deviceLogin = webOnly && !outside && document.body.getAttribute("data-device-login") === "1";
  const t = (k) => (outside && (T[lang][`${k}_outside`] || T.en[`${k}_outside`])) || (webOnly && (T[lang][`${k}_web`] || T.en[`${k}_web`])) || T[lang][k] || T.en[k] || k;
  /** A wait as words: "15 minutes" / 「15 分鐘」, "2 hours" / 「2 小時」 (rounded up). */
  const duration = (ms) => {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    if (minutes < 60) return minutes === 1 ? t("minute") : t("minutes").replace("{0}", String(minutes));
    const hours = Math.ceil(minutes / 60);
    return hours === 1 ? t("hour") : t("hours").replace("{0}", String(hours));
  };
  // …and no "No chat bot?" help: the hint above already is it.
  if (webOnly) document.querySelectorAll("details.help").forEach((d) => { if (d.querySelector && d.querySelector('[data-i18n="nobot"]')) d.hidden = true; });
  document.documentElement.lang = lang === "zh-TW" ? "zh-Hant" : "en";
  if (outside) {
    const input = $("code");
    input.setAttribute("inputmode", "numeric"); input.setAttribute("maxlength", "7"); input.setAttribute("placeholder", "123456");
    input.setAttribute("pattern", "[0-9 ]*");
  }

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
    if (deviceLogin) $("another").hidden = false;
  }

  // Only a returning device gets the button; the answer is a boolean and asking has no side effect. Never from outside
  // (#3008): the code there is the app's, nothing is sent.
  async function offerResend() {
    if (outside) return;
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

  // ── #3061: sign in with another device ──
  // POST /auth/device-login → the code to show (and an HttpOnly cookie that is this browser's request); then POST
  // /auth/device-login/poll every couple of seconds until a signed-in owner has approved it (the poll that finds it
  // approved is what signs this browser in, so nothing is handed over by the approving device), denied it, or it ran out.
  // Never a GET: asking and polling both change state, and a preview must not.
  const DEV_POLL_MS = 2000;
  let dev = null;
  const devPost = (path) => fetch(`/auth/device-login${path}`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}" });
  const clock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  function devStop() {
    if (!dev) return;
    dev.stopped = true;
    clearTimeout(dev.poll); clearInterval(dev.tick);
    dev = null;
  }
  function devSay(text, bad, spent) {
    $("devStatus").textContent = text;
    $("devStatus").classList?.[bad ? "add" : "remove"]("bad");
    $("devCode").classList?.[spent ? "add" : "remove"]("spent");
  }
  function devEnded(text, bad) {
    devStop();
    devSay(text, bad, true);
    $("devNew").hidden = false;
  }
  async function devStart() {
    devStop();
    $("form").hidden = true; $("device").hidden = false; $("devNew").hidden = true;
    $("devCode").textContent = "XXXX-XXXX";
    devSay("", false, true);
    const mine = { stopped: false, poll: 0, tick: 0, deadline: 0, lost: 0 };
    dev = mine;
    let r, body = null;
    try { r = await devPost(""); body = r.ok ? await r.json() : null; } catch { if (!mine.stopped) devEnded(t("dev_failed"), true); return; }
    if (mine.stopped) return;
    if (!r.ok || !body || typeof body.code !== "string") {
      if (r.status === 429) {
        let wait = Number(r.headers.get("Retry-After")) * 1000;
        try { const b = await r.json(); if (Number.isFinite(b && b.retryAfterMs)) wait = b.retryAfterMs; } catch { /* the header's */ }
        devEnded(t("dev_limited").replace("{duration}", duration(Number.isFinite(wait) && wait > 0 ? wait : 60000)), true);
      } else devEnded(r.status === 503 ? t("dev_busy") : r.status === 404 ? t("dev_unavailable") : t("dev_failed"), true);
      return;
    }
    $("devCode").textContent = body.code;
    $("devCode").classList?.remove("spent");
    // The countdown runs on this browser's own clock from when the code arrived (the server's is the authority: its poll
    // says `expired` when it is).
    mine.deadline = Date.now() + (Number.isFinite(body.ttlMs) && body.ttlMs > 0 ? body.ttlMs : 300000);
    const waiting = () => devSay(t("dev_waiting").replace("{time}", clock(mine.deadline - Date.now())), false, false);
    waiting();
    mine.tick = setInterval(() => { if (!mine.stopped && !mine.approved) waiting(); }, 1000);
    const again = () => { if (!mine.stopped) mine.poll = setTimeout(ask, DEV_POLL_MS); };
    const ask = async () => {
      let p, state = null, parsed = null;
      try { p = await devPost("/poll"); parsed = await p.json(); state = parsed && parsed.state; } catch { /* below */ }
      if (mine.stopped) return;
      if (state === "approved" && p && p.ok) {
        mine.approved = true;
        devSay(t("dev_approved"), false, false);
        clearBounce(); location.replace(nextTarget());
        return;
      }
      if (state === "denied") { devEnded(t("dev_denied"), true); return; }
      if (state === "expired") { devEnded(t("dev_expired"), true); return; }
      if (state === "pending") { mine.lost = 0; again(); return; }
      // The network, or an answer that is none of these: keep trying — the server ends the request when it is time —
      // but say so after a few, and stop waiting once the code's own time is well past.
      if (Date.now() > mine.deadline + 15000) { devEnded(t("dev_expired"), true); return; }
      if (++mine.lost >= 3) devSay(t("dev_lost"), true, false);
      again();
    };
    again();
  }
  async function devBack() {
    const mine = dev;
    devStop();
    $("device").hidden = true; $("form").hidden = false;
    if (mine && !mine.approved) { try { await devPost("/cancel"); } catch { /* it expires by itself */ } }
    $("code").focus();
  }
  if (deviceLogin) {
    $("another").addEventListener("click", () => { devStart(); });
    $("devNew").addEventListener("click", () => { devStart(); });
    $("devBack").addEventListener("click", () => { devBack(); });
  }

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
      const r = await fetch(outside ? "/auth/totp" : "/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: $("code").value }),
      });
      if (r.ok) { clearBounce(); location.replace(nextTarget()); return; }
      if (outside && r.status === 429) {
        let wait = Number(r.headers.get("Retry-After")) * 1000;
        try { const body = await r.json(); if (Number.isFinite(body && body.retryAfterMs)) wait = body.retryAfterMs; } catch { /* the header's */ }
        msg.textContent = t("paused").replace("{duration}", duration(Number.isFinite(wait) && wait > 0 ? wait : 60000));
        throw "shown";
      }
      // #1854: a 5xx is the server failing to confirm the sign-in (503: a public link's notice did not go out), not a
      // wrong code — say so. The code is spent either way: the way on is a new one.
      msg.textContent = r.status === 429 ? t("paused") : r.status >= 500 ? t("unconfirmed") : t("refused");
    } catch (err) {
      if (err !== "shown") msg.textContent = t("network");
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
