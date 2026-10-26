/* Shared browser controls. No terminal relay, provider output or secrets in diagnostics. */
// #2726: in English and 繁體中文 — served alone to the setup page (no dashboard i18n there), so its words live here.
export const SIGNIN_STRINGS = {
  en: {
    heading: "Sign in your AI backends",
    lead: "Use the controls here; no terminal typing is needed for Kiro, Claude Code or Codex. You can sign in later from the dashboard.",
    check: "Check sign-ins", skipped: "Sign in later · remains in Needs you", valid: "Signed in ✓", notInstalled: "Not installed on this host",
    consoleOnly: "Use the explicit console fallback, or sign in later.", needed: "Sign-in needed", waiting: "Waiting for the CLI…", login: "Login: {0}",
    openProvider: "Open provider sign-in", deviceCode: "Device code:", answerSent: "Answer sent. Waiting for the next screen; it will not be sent twice.",
    cancel: "Cancel sign-in", signIn: "Sign in", signInAgain: "Sign in again", later: "Sign in later", submit: "Submit {0}",
    relogin: "Sign in again? Kiro will sign out its existing account first.", ready: "You can continue setup.",
    field_code: "Paste the returned code", field_start_url: "Organization Start URL", field_region: "AWS region",
    phase_method: "method", phase_code: "code", phase_start_url: "start URL", phase_region: "region", phase_authorization: "authorization",
    choice_organization: "Your organization", choice_subscription: "Claude subscription",
    antigravity: "Antigravity (console fallback)",
    error: "Could not complete sign-in. Check status, retry, or sign in later.",
    error_unsupported_prompt: "This CLI screen is not supported. Cancel and use the console fallback.",
    error_cleanup_failed: "The login process could not be confirmed closed. Close it on the host and restart setup before retrying.",
    error_signin_cleanup_failed: "The login process could not be confirmed closed. Close it on the host and restart setup before retrying.",
    error_signin_action_stale: "That prompt changed or was already answered. Refresh its status; do not submit it again.",
    error_signin_console_only: "This backend uses the explicit console fallback.",
    error_backend_signin_local_only: "Backend sign-in is available only on this computer. Use the local setup page, or sign in later.",
    error_signin_session_expired: "This setup session has ended. Reopen setup on the host.",
    error_expired: "This login attempt expired. Start a new attempt.",
    error_auth_unconfirmed: "The CLI exited, but credentials could not be verified. Retry or sign in later.",
    error_provider_rejected: "The provider rejected this sign-in. Retry or sign in later.",
  },
  "zh-TW": {
    heading: "登入你的 AI 後端",
    lead: "用這裡的按鈕操作；Kiro、Claude Code 和 Codex 都不需要在終端機輸入。也可以之後再從儀表板登入。",
    check: "檢查登入狀態", skipped: "稍後登入 · 會留在「等你回應」", valid: "已登入 ✓", notInstalled: "這台主機上沒有安裝",
    consoleOnly: "請改用主控台備援，或稍後登入。", needed: "需要登入", waiting: "等待 CLI 回應…", login: "登入：{0}",
    openProvider: "開啟登入頁", deviceCode: "裝置代碼：", answerSent: "已送出。等待下一個畫面；不會重複送出。",
    cancel: "取消登入", signIn: "登入", signInAgain: "重新登入", later: "稍後登入", submit: "送出{0}",
    relogin: "要重新登入嗎？Kiro 會先登出目前的帳號。", ready: "可以繼續設定了。",
    field_code: "貼上取得的代碼", field_start_url: "組織的 Start URL", field_region: "AWS 區域",
    phase_method: "選擇方式", phase_code: "代碼", phase_start_url: "Start URL", phase_region: "區域", phase_authorization: "授權",
    choice_organization: "你的組織", choice_subscription: "Claude 訂閱",
    antigravity: "Antigravity（主控台備援）",
    error: "無法完成登入。請檢查狀態、重試，或稍後登入。",
    error_unsupported_prompt: "不支援這個 CLI 畫面。請取消並改用主控台備援。",
    error_cleanup_failed: "無法確認登入程序已關閉。請在主機上關閉它，並重新開始設定後再試。",
    error_signin_cleanup_failed: "無法確認登入程序已關閉。請在主機上關閉它，並重新開始設定後再試。",
    error_signin_action_stale: "這個畫面已改變或已回答過。請重新整理狀態，不要再送一次。",
    error_signin_console_only: "這個後端使用主控台備援。",
    error_backend_signin_local_only: "後端登入只能在這台電腦上進行。請使用本機的設定頁，或稍後登入。",
    error_signin_session_expired: "這個設定工作階段已結束。請在主機上重新開啟設定。",
    error_expired: "這次登入已過期。請重新開始。",
    error_auth_unconfirmed: "CLI 已結束，但無法確認憑證。請重試或稍後登入。",
    error_provider_rejected: "平台拒絕了這次登入。請重試或稍後登入。",
  },
};
const NAMES = { "kiro-cli": "Kiro", "claude-code": "Claude Code", codex: "Codex", antigravity: "Antigravity" };
const CHOICES = { builder_id: "Builder ID", google: "Google", github: "GitHub", organization: null, subscription: null, console: "Anthropic Console" };
/** The page's language, as its <html lang> says (the setup page and the dashboard both keep it current). */
const pageLang = doc => /^zh/i.test(doc?.documentElement?.lang || "") ? "zh-TW" : "en";

export function mountStructuredSignIns(root, { endpoint, fetcher = fetch, changed = () => {}, lang } = {}) {
  const doc = root.ownerDocument;
  let view = null, busy = false, disposed = false, timer = null, generation = 0, message = "", rendered = "";
  const language = () => (lang ? lang() : pageLang(doc)) === "zh-TW" ? "zh-TW" : "en";
  const tr = (key, value) => { const text = SIGNIN_STRINGS[language()][key] ?? SIGNIN_STRINGS.en[key] ?? key; return value === undefined ? text : text.split("{0}").join(value); };
  const el = (tag, text, parent = root) => { const node = doc.createElement(tag); if (text) node.textContent = text; parent.append(node); return node; };
  // An error is kept as its code, so it is said again in the other language when that changes.
  const errorText = code => SIGNIN_STRINGS.en["error_" + code] ? tr("error_" + code) : tr("error");
  const name = backend => backend === "antigravity" ? tr("antigravity") : NAMES[backend] || backend;
  const choiceName = choice => CHOICES[choice] ?? tr("choice_" + choice);
  const phaseName = phase => SIGNIN_STRINGS.en["phase_" + phase] ? tr("phase_" + phase) : phase.replaceAll("_", " ");
  const button = (parent, label, action) => { const b = el("button", label, parent); b.type = "button"; b.disabled = busy; b.onclick = action; return b; };
  const request = async data => {
    const response = await fetcher(endpoint, { method: data ? "POST" : "GET", cache: "no-store", headers: { "Content-Type": "application/json" }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || "signin_failed");
    return body;
  };
  const accept = next => { view = next; root.dataset.ready = String(view.ready); changed(view); };
  async function perform(data) {
    if (busy || disposed) return;
    busy = true; generation++; message = ""; render();
    try { const next = await request(data); if (!disposed) accept(next); }
    catch (error) { if (!disposed) message = String(error?.message || "error"); }
    finally { busy = false; if (!disposed) render(); }
  }
  function render() {
    const signature = JSON.stringify([view, busy, message, language()]);
    if (disposed || rendered === signature) return;
    rendered = signature; root.replaceChildren();
    el("h2", tr("heading"));
    el("p", tr("lead"));
    if (message) { const alert = el("p", errorText(message)); alert.setAttribute("role", "alert"); }
    if (!view) { button(root, tr("check"), () => perform({ operation: "refresh" })); return; }
    for (const backend of view.selected) {
      const card = el("section"); card.dataset.backend = backend;
      el("h3", name(backend), card);
      const state = view.states[backend], pending = view.pending.includes(backend), skipped = view.skipped.includes(backend);
      el("p", tr(skipped ? "skipped" : state === "valid" ? "valid" : state === "not_installed" ? "notInstalled" : state === "console_only" ? "consoleOnly" : "needed"), card);
      const login = view.login?.backend === backend ? view.login : null;
      const active = login && login.phase !== "done" && !(login.phase === "failed" && login.reason);
      if (active) {
        el("p", login.phase === "waiting" || login.phase === "starting" ? tr("waiting") : tr("login", phaseName(login.phase)), card);
        if (login.phase === "method" && login.canAct) for (const choice of login.choices || []) {
          if (Object.hasOwn(CHOICES, choice)) button(card, choiceName(choice), () => perform({ operation: "input", id: login.id, revision: login.revision, action: { kind: "method", choice } }));
        }
        if (login.url) {
          // The host already allowlists these; still never turn a non-HTTPS URL into a link.
          let url; try { url = new URL(login.url); } catch {}
          if (url?.protocol === "https:" && !url.username && !url.password) {
            const link = el("a", tr("openProvider"), card); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
          }
        }
        if (login.code) { el("p", tr("deviceCode"), card); el("code", login.code, card); }
        if (login.canAct && ["code", "start_url", "region"].includes(login.phase)) {
          const label = el("label", tr("field_" + login.phase), card);
          const input = el("input", null, label); input.type = login.phase === "code" ? "password" : "text"; input.autocomplete = "off"; input.spellcheck = false;
          input.setAttribute("aria-label", label.textContent); input.disabled = busy;
          button(card, tr("submit", phaseName(login.phase)), () => { const value = input.value; input.value = ""; void perform({ operation: "input", id: login.id, revision: login.revision, action: { kind: login.phase, value } }); });
        }
        if (["method", "code", "start_url", "region"].includes(login.phase) && !login.canAct) el("p", tr("answerSent"), card);
        button(card, tr("cancel"), () => perform({ operation: "cancel" }));
      } else {
        if (login?.reason && login.reason !== "cancelled") el("p", errorText(login.reason), card);
        const usable = !["antigravity"].includes(backend) && state !== "not_installed";
        if (usable) button(card, tr(state === "valid" ? "signInAgain" : "signIn"), () => {
          const relogin = state === "valid";
          if (relogin && !globalThis.confirm(tr("relogin"))) return;
          void perform({ operation: "start", backend, relogin });
        });
      }
      if (pending && !skipped) button(card, tr("later"), () => perform({ operation: "skip", backend }));
    }
    button(root, tr("check"), () => perform({ operation: "refresh" }));
    if (view.ready) el("p", tr("ready"));
  }
  async function poll() {
    if (disposed) return;
    const before = generation;
    if (!busy) try { const next = await request(); if (!disposed && before === generation) { accept(next); render(); } }
    catch (error) { if (!disposed && before === generation) { message = String(error?.message || "error"); render(); } }
    if (!disposed) timer = setTimeout(poll, 1000);
  }
  render(); void poll();
  return {
    addBackends(backends) {
      if (view && Array.isArray(backends) && backends.every(b => NAMES[b]) && backends.some(b => !view.selected.includes(b)))
        return perform({ operation: "select", backends: [...new Set([...view.selected, ...backends])] });
    },
    addBackend(backend) { if (view && NAMES[backend] && !view.selected.includes(backend)) return perform({ operation: "select", backends: [...view.selected, backend] }); },
    /** Draw it again in the page's language now (it also follows on its next poll). */
    relabel() { render(); },
    dispose() { disposed = true; generation++; clearTimeout(timer); root.replaceChildren(); },
  };
}

const setupRoot = typeof document === "undefined" ? null : document.getElementById("setupSignins");
if (setupRoot) {
  const cards = mountStructuredSignIns(setupRoot, { endpoint: "setup/signins" });
  const backend = document.getElementById("backend");
  const select = () => cards.addBackend(backend?.value);
  backend?.addEventListener("change", select);
  const observer = new MutationObserver(select); if (backend) observer.observe(backend, { childList: true });
  // Initial GET may finish after the environment list, so also observe our readiness result.
  const ready = new MutationObserver(select); ready.observe(setupRoot, { attributes: true, attributeFilter: ["data-ready"] });
  // #2726: the page's language toggle changes <html lang>; the cards follow at once.
  const language = new MutationObserver(() => cards.relabel()); language.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  addEventListener("pagehide", () => { observer.disconnect(); ready.disconnect(); language.disconnect(); cards.dispose(); }, { once: true });
}
