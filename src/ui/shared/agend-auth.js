// Shared by the panels. Loaded from /assets/agend-auth.js.
//
// Writes are authorized by the session cookie *and* a per-session CSRF value, which this
// script fetches once and adds to every same-origin write. It wraps `fetch` so the panels'
// own request code did not have to change; the shared shell (design Phase 2) replaces this.
// It also says so — once, and without losing the page — when the session has ended.
(() => {
  "use strict";
  if (window.AgendAuth) return;

  // An old link carries `?token=` (e.g. /view?token=…, which is open to read and so is served, not
  // answered with the sign-in page). It is not a credential any more, but it is still the fleet's
  // token: take it out of the address bar and this history entry at once.
  try {
    const here = new URL(location.href);
    if (here.searchParams.has("token")) {
      here.searchParams.delete("token");
      history.replaceState(null, "", here.pathname + here.search + here.hash);
    }
  } catch { /* nothing to clean */ }

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
    const response = await nativeFetch(input, init);
    if (sameOrigin && response.status === 401 && !target.pathname.startsWith("/auth/")) sessionEndedBanner();
    return response;
  };

  window.AgendAuth = {
    csrf,
    async signOut() {
      const value = await csrf();
      const r = await nativeFetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: value ? { "X-Agend-CSRF": value } : {} });
      // A sign-out the server could not make durable is not quietly reported as done: say so before leaving.
      if (r.status === 500) {
        let message = "Signed out for now, but the change could not be saved — a fleet restart may sign this browser back in.";
        try { const body = await r.json(); if (body && typeof body.error === "string") message = body.error; } catch { /* keep the default */ }
        window.alert(message);
      }
      location.href = "/signin";
    },
  };
})();
