// Shared by the panels. Loaded from /assets/agend-auth.js.
//
// Writes are authorized by the session cookie *and* a per-session CSRF value, which this
// script fetches once and adds to every same-origin write. It wraps `fetch` so the panels'
// own request code did not have to change; the shared shell (design Phase 2) replaces this.
// It also says so — once, and without losing the page — when the session has ended.
(() => {
  "use strict";
  if (window.AgendAuth) return;
  const nativeFetch = window.fetch.bind(window);
  let csrfPending = null;

  function csrf() {
    if (!csrfPending) {
      csrfPending = nativeFetch("/auth/session", { credentials: "same-origin", cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j && typeof j.csrf === "string" ? j.csrf : null))
        .catch(() => null)
        .then((value) => { if (!value) csrfPending = null; return value; });
    }
    return csrfPending;
  }

  let bannerShown = false;
  function sessionEndedBanner() {
    if (bannerShown || !document.body) return;
    bannerShown = true;
    const bar = document.createElement("div");
    bar.setAttribute("role", "alert");
    bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 16px;background:#f85149;color:#fff;font:14px system-ui,sans-serif;text-align:center";
    const zh = /^zh/i.test(navigator.language || "");
    bar.append(document.createTextNode(zh ? "登入已結束。" : "Your session has ended. "));
    const link = document.createElement("a");
    link.href = "/signin?next=" + encodeURIComponent(location.pathname + location.search);
    link.textContent = zh ? "重新登入" : "Sign in again";
    link.style.cssText = "color:#fff;font-weight:600;text-decoration:underline";
    bar.append(link);
    document.body.prepend(bar);
  }

  // Over the internet, actions that amount to running code here want a sign-in from the last half hour.
  // The server answers those with 403 {"error":"reauth_required"}; rather than let the page report a
  // failure, ask for a fresh code, sign in again, and repeat the request once.
  const REAUTH = "reauth_required";
  const words = {
    en: { title: "Confirm it is you", lead: "This action needs a recent sign-in. Send /dashboard to your AgEnD bot and enter the new code.", go: "Confirm", cancel: "Cancel", bad: "That code did not work." },
    "zh-TW": { title: "請再確認一次身分", lead: "這個動作需要最近的登入。請在 AgEnD bot 傳 /dashboard，並輸入新的登入碼。", go: "確認", cancel: "取消", bad: "登入碼無效。" },
  };
  let reauthPending = null;

  function askForFreshCode() {
    if (reauthPending) return reauthPending;
    const zh = /^zh/i.test((() => { try { return localStorage.getItem("agend_lang") || ""; } catch { return ""; } })() || navigator.language || "");
    const w = words[zh ? "zh-TW" : "en"];
    reauthPending = new Promise((resolve) => {
      const back = document.createElement("div");
      back.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px";
      const box = document.createElement("form");
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.style.cssText = "width:100%;max-width:340px;background:#161b22;color:#f0f6fc;border:1px solid #30363d;border-radius:12px;padding:20px;font:14px/1.5 system-ui,sans-serif";
      const h = document.createElement("div"); h.textContent = w.title; h.style.cssText = "font-weight:700;font-size:16px;margin-bottom:6px";
      const p = document.createElement("div"); p.textContent = w.lead; p.style.cssText = "color:#8b949e;margin-bottom:12px";
      const input = document.createElement("input");
      input.setAttribute("autocomplete", "one-time-code"); input.setAttribute("autocapitalize", "characters"); input.setAttribute("spellcheck", "false");
      input.maxLength = 12; input.placeholder = "XXXX-XXXX";
      input.style.cssText = "width:100%;box-sizing:border-box;padding:10px;text-align:center;letter-spacing:.16em;text-transform:uppercase;font:600 20px ui-monospace,Menlo,monospace;background:#080b12;color:#f0f6fc;border:1px solid #30363d;border-radius:8px";
      const msg = document.createElement("div"); msg.setAttribute("role", "alert"); msg.style.cssText = "color:#f85149;min-height:1.4em;margin-top:8px";
      const row = document.createElement("div"); row.style.cssText = "display:flex;gap:8px;margin-top:8px";
      const ok = document.createElement("button"); ok.type = "submit"; ok.textContent = w.go;
      ok.style.cssText = "flex:1;padding:9px;border:0;border-radius:8px;background:#2aabee;color:#04121b;font-weight:600;cursor:pointer";
      const no = document.createElement("button"); no.type = "button"; no.textContent = w.cancel;
      no.style.cssText = "padding:9px 14px;border:1px solid #30363d;border-radius:8px;background:transparent;color:#f0f6fc;cursor:pointer";
      row.append(ok, no); box.append(h, p, input, msg, row); back.append(box); document.body.append(back);
      input.focus();
      const done = (value) => { back.remove(); reauthPending = null; resolve(value); };
      no.addEventListener("click", () => done(false));
      back.addEventListener("keydown", (e) => { if (e.key === "Escape") done(false); });
      box.addEventListener("submit", async (e) => {
        e.preventDefault();
        ok.disabled = true; msg.textContent = "";
        try {
          const r = await nativeFetch("/auth/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: input.value }) });
          if (r.ok) { csrfPending = null; done(true); return; }
          msg.textContent = w.bad;
        } catch { msg.textContent = w.bad; }
        ok.disabled = false; input.select();
      });
    });
    return reauthPending;
  }

  async function isReauth(response) {
    if (response.status !== 403) return false;
    try { return (await response.clone().json()).error === REAUTH; } catch { return false; }
  }

  window.fetch = async function (input, init) {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const method = String((init && init.method) || (isRequest ? input.method : "GET")).toUpperCase();
    let target;
    try { target = new URL(isRequest ? input.url : String(input), location.href); } catch { return nativeFetch(input, init); }
    const sameOrigin = target.origin === location.origin;
    if (sameOrigin && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const value = await csrf();
      if (value) {
        const headers = new Headers((init && init.headers) || (isRequest ? input.headers : undefined));
        headers.set("X-Agend-CSRF", value);
        init = Object.assign({}, init, { headers });
      }
    }
    // A Request's body can be sent once; keep a spare in case the action has to be repeated.
    const spare = isRequest ? input.clone() : null;
    let response = await nativeFetch(input, init);
    if (sameOrigin && !target.pathname.startsWith("/auth/") && await isReauth(response)) {
      if (await askForFreshCode()) {
        // A new session means a new CSRF value: send the repeat with it, not the one the old session had.
        const headers = new Headers((init && init.headers) || (spare ? spare.headers : undefined));
        const fresh = await csrf();
        if (fresh) headers.set("X-Agend-CSRF", fresh);
        response = await nativeFetch(spare || input, Object.assign({}, init, { headers }));
      }
    }
    if (sameOrigin && response.status === 401 && !target.pathname.startsWith("/auth/")) sessionEndedBanner();
    return response;
  };

  window.AgendAuth = {
    csrf,
    async signOut() {
      const value = await csrf();
      await nativeFetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: value ? { "X-Agend-CSRF": value } : {} });
      location.href = "/signin";
    },
  };
})();
