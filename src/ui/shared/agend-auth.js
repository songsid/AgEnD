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

  // Before U2, /view kept the fleet's web token in localStorage ("agend_web_token") and sent it with every request.
  // It is not read any more, but the token still opens every write through X-Agend-Token: remove that one key — and
  // nothing else of the page's preferences — on any panel this browser opens. Storage can be blocked (privacy mode,
  // a sandboxed frame); that must not stop the rest of this script.
  try { window.localStorage.removeItem("agend_web_token"); } catch { /* no storage, nothing stored */ }

  const nativeFetch = window.fetch.bind(window);
  let sessionPending = null;

  /**
   * This page's sign-in, read once from GET /auth/session: { csrf, handle } or null (no session, or the read failed —
   * asked again next time). The CSRF value and the session handle (#1568: what "until the next sign-in" is keyed by)
   * come from the one read.
   */
  function session() {
    if (!sessionPending) {
      sessionPending = nativeFetch("/auth/session", { credentials: "same-origin", cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j && typeof j.csrf === "string" ? { csrf: j.csrf, handle: typeof j.handle === "string" ? j.handle : null } : null))
        .catch(() => null)
        .then((value) => { if (!value) sessionPending = null; return value; });
    }
    return sessionPending;
  }
  function csrf() { return session().then((s) => (s ? s.csrf : null)); }

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
    /** #1568: the session handle of this page's sign-in, or null when there is none. */
    sessionHandle() { return session().then((s) => (s && s.handle ? s.handle : null)); },
    async signOut() {
      const value = await csrf();
      const r = await nativeFetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: value ? { "X-Agend-CSRF": value } : {} });
      // A sign-out the server could not make durable is not quietly reported as done: say so before leaving.
      if (r.status === 500) {
        let message = "Signed out for now, but the change could not be saved — a fleet restart may sign this browser back in.";
        try { const body = await r.json(); if (body && typeof body.error === "string") message = body.error; } catch { /* keep the default */ }
        // Said on the sign-in page this goes to (#1408 step 5: no browser alert): the page shows it once.
        try { sessionStorage.setItem("agend_signout_note", message); } catch { /* private mode: nothing to carry it */ }
      }
      location.href = "/signin";
    },
  };
})();
