// Shared navigation and session menu. Loaded from /assets/shell.js (after /assets/agend-auth.js).
//
// A page opts in with `<nav data-agend-nav data-current="ui|view|settings"></nav>` wherever it wants the
// links; everything else about the page stays the page's own. Nothing here builds HTML from a string:
// device labels come from other browsers' User-Agents, so they only ever reach the page as text.
(() => {
  "use strict";
  if (window.AgendShell) return;

  const T = {
    en: {
      ui: "Dashboard", view: "View", settings: "Settings", session: "Session", signIn: "Sign in",
      signedIn: "Signed in", signedOut: "Not signed in", thisDevice: "This device", lastActive: "active {0}",
      justNow: "just now", minAgo: "{0} min ago", hrAgo: "{0} h ago", signOut: "Sign out", signOutOthers: "Sign out other devices",
      signOutAll: "Sign out everywhere", devices: "Signed-in devices", expires: "Ends by {0} at the latest, or after {1} unused",
      idle: "idle", failed: "That did not work — try again.", viewOnly: "Reading is open; sign in to make changes.",
    },
    "zh-TW": {
      ui: "儀表板", view: "檢視", settings: "設定", session: "登入狀態", signIn: "登入",
      signedIn: "已登入", signedOut: "尚未登入", thisDevice: "這台裝置", lastActive: "{0}活動",
      justNow: "剛剛", minAgo: "{0} 分鐘前", hrAgo: "{0} 小時前", signOut: "登出", signOutOthers: "登出其他裝置",
      signOutAll: "全部登出", devices: "已登入的裝置", expires: "最晚 {0} 結束；閒置 {1} 也會結束",
      idle: "閒置", failed: "沒有成功，請再試一次。", viewOnly: "目前開放讀取；登入後才能修改。",
    },
  };
  const currentLang = () => {
    let saved = null;
    try { saved = localStorage.getItem("agend_lang"); } catch { /* storage blocked */ }
    return saved === "zh-TW" || saved === "en" ? saved : (/^zh/i.test(navigator.language || "") ? "zh-TW" : "en");
  };
  const t = (key, ...args) => {
    let s = (T[currentLang()] || T.en)[key] || T.en[key] || key;
    args.forEach((a, i) => { s = s.replace("{" + i + "}", a); });
    return s;
  };

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  const clock = (ms) => new Date(ms).toLocaleTimeString(currentLang() === "zh-TW" ? "zh-TW" : undefined, { hour: "2-digit", minute: "2-digit" });
  const span = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m >= 90 ? Math.round(m / 60) + " h" : m + " min"; };
  const ago = (ms) => {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return t("justNow");
    return m < 90 ? t("minAgo", m) : t("hrAgo", Math.round(m / 60));
  };

  async function getJson(url) {
    try {
      const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  const navs = [];

  function mount(el) {
    const current = el.getAttribute("data-current") || "";
    el.classList.add("agend-nav");
    el.setAttribute("aria-label", "AgEnD");
    const state = { me: null, sessions: null, open: false, error: false };

    const pop = h("div", { class: "agend-pop", hidden: true, role: "dialog", "aria-label": t("session") });
    const meBtn = h("button", { class: "agend-me", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false" });

    function link(key, href) {
      return h("a", { href, "aria-current": key === current ? "page" : false, text: t(key) });
    }

    async function refreshMe() {
      state.me = await getJson("/auth/session");
      state.sessions = null;
      if (state.me) { const s = await getJson("/auth/sessions"); state.sessions = s && s.sessions ? s.sessions : null; }
      render();
    }

    async function act(method, url, after) {
      state.error = false;
      try {
        const r = await fetch(url, { method, credentials: "same-origin" });
        if (!r.ok) throw new Error(String(r.status));
        after();
      } catch { state.error = true; render(); }
    }

    function popContent() {
      const box = [];
      if (!state.me) {
        box.push(h("h3", { text: t("signedOut") }));
        box.push(h("div", { class: "agend-sub", text: t("viewOnly") }));
        box.push(h("a", { class: "agend-act", href: "/signin?next=" + encodeURIComponent(location.pathname), text: t("signIn") }));
        return box;
      }
      box.push(h("h3", { text: t("signedIn") + " · " + state.me.label }));
      box.push(h("div", { class: "agend-sub", text: t("expires", clock(state.me.expiresAt), span(state.me.idleMs)) }));
      const rows = (state.sessions || []).map((s) => h("li", {},
        h("span", { class: "grow" }, h("span", { class: "name", text: s.label + (s.current ? " · " + t("thisDevice") : "") }),
          h("span", { class: "when", text: t("lastActive", ago(s.lastSeen)) })),
        s.current ? null : h("button", { class: "agend-act agend-danger", type: "button", text: t("signOut"),
          onclick: () => act("DELETE", "/auth/sessions/" + encodeURIComponent(s.handle), refreshMe) })));
      if (rows.length > 1) { box.push(h("h3", { text: t("devices") })); box.push(h("ul", {}, ...rows)); }
      box.push(h("div", { class: "agend-row" },
        h("button", { class: "agend-act", type: "button", text: t("signOut"), onclick: () => act("POST", "/auth/logout", () => { location.href = "/signin"; }) }),
        rows.length > 1 ? h("button", { class: "agend-act agend-danger", type: "button", text: t("signOutAll"), onclick: () => act("DELETE", "/auth/sessions", () => { location.href = "/signin"; }) }) : null));
      if (state.error) box.push(h("div", { class: "agend-err", role: "alert", text: t("failed") }));
      return box;
    }

    function render() {
      el.replaceChildren(link("ui", "/ui"), link("view", "/view"), link("settings", "/settings"), meBtn, pop);
      const label = state.me ? t("session") : t("signIn");
      meBtn.replaceChildren(h("span", { class: "agend-dot" + (state.me ? "" : " off"), "aria-hidden": "true" }), h("span", { class: "agend-me-label", text: label }));
      meBtn.setAttribute("title", label);
      meBtn.setAttribute("aria-label", label);
      meBtn.setAttribute("aria-expanded", String(state.open));
      pop.hidden = !state.open;
      pop.replaceChildren(...(state.open ? popContent() : []));
    }

    meBtn.addEventListener("click", () => { state.open = !state.open; if (state.open) refreshMe(); else render(); });
    document.addEventListener("click", (e) => { if (state.open && !el.contains(e.target)) { state.open = false; render(); } });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.open) { state.open = false; render(); meBtn.focus(); } });

    navs.push({ render });
    render();
    refreshMe();
  }

  function init() { document.querySelectorAll("[data-agend-nav]").forEach(mount); }
  // The pages switch language with their own button and tell nobody; re-label when it is pressed.
  document.addEventListener("click", (e) => { if (e.target instanceof Element && e.target.closest("#langBtn")) setTimeout(() => navs.forEach((n) => n.render()), 0); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

  window.AgendShell = { refresh: () => navs.forEach((n) => n.render()) };
})();
