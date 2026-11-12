/* Shared browser controls. No terminal relay, provider output or secrets in diagnostics. */
// #2726: in English and 繁體中文 — served alone to the setup page (no dashboard i18n there), so its words live here.
export const SIGNIN_STRINGS = {
  en: {
    heading: "Connect your AI accounts",
    lead: "Use the controls here; no terminal typing is needed for Kiro, Claude Code or Codex. Each one finishes on the provider's official website. You can connect them later from the dashboard.",
    check: "Check connections", skipped: "Connect later · remains in Needs you", valid: "Connected ✓", notInstalled: "Not installed on this host",
    consoleOnly: "Use the explicit console fallback, or connect later.", needed: "Not connected", waiting: "Waiting for the CLI…", login: "Connecting: {0}",
    openProvider: "Finish on the provider's official website", deviceCode: "Authorization code:", answerSent: "Answer sent. Waiting for the next screen; it will not be sent twice.",
    cancel: "Cancel connecting", signIn: "Connect account", signInAgain: "Reconnect", later: "Connect later", submit: "Submit {0}",
    relogin: "Reconnect {0}? It disconnects its current account first.", reloginReplace: "Reconnect {0}? The new connection replaces the account it uses now.", ready: "You can continue setup.",
    field_code: "Paste the authorization code", field_start_url: "Organization Start URL", field_region: "AWS region",
    phase_method: "method", phase_code: "authorization code", phase_start_url: "start URL", phase_region: "region", phase_authorization: "authorization",
    choice_organization: "Your organization", choice_subscription: "Claude subscription",
    antigravity: "Antigravity (console fallback)",
    error: "Could not connect the account. Check status, retry, or connect later.",
    error_unsupported_prompt: "This CLI screen is not supported. Cancel and use the console fallback.",
    error_cleanup_failed: "The login process could not be confirmed closed. Close it on the host and restart setup before retrying.",
    error_signin_cleanup_failed: "The login process could not be confirmed closed. Close it on the host and restart setup before retrying.",
    error_signin_action_stale: "That prompt changed or was already answered. Refresh its status; do not submit it again.",
    error_signin_console_only: "This backend uses the explicit console fallback.",
    error_backend_signin_local_only: "AI accounts can be connected only on this computer. Use the local setup page, or connect later.",
    error_signin_session_expired: "This setup session has ended. Reopen setup on the host.",
    error_expired: "This login attempt expired. Start a new attempt.",
    error_busy: "Another sign-in is already running. Finish or cancel it, then try again.",
    error_signin_busy: "Another sign-in is already running. Finish or cancel it, then try again.",
    error_signin_profile_unknown: "This account is not in the list. Add it with + Add account in Settings → Accounts, then connect it.",
    error_auth_unconfirmed: "The CLI exited, but credentials could not be verified. Retry or connect later.",
    error_provider_rejected: "The provider rejected this authorization. Retry or connect later.",
    // #3190 Part 3c: a profile on a paired computer (the dashboard's Accounts view).
    error_machine_unknown: "That computer is not paired any more.",
    error_machine_offline: "That computer is offline. Start its Runtime, then try again.",
    error_machine_unsupported: "That computer's Runtime is too old to sign in from here. Update the Runtime on it, then try again.",
    error_machine_accounts_off: "The owner of that computer has not allowed this. On that computer run: agend-runtime remote-setup accounts on",
    error_machine_unreachable: "That computer did not answer. Check its Runtime window, then try again.",
    error_machine_profile_not_owned: "This account was not created by AgEnD's Runtime, so it can only be connected on that computer: agend-runtime login claude-code NAME",
    error_machine_busy: "Another sign-in is already running on that computer.",
    error_invalid_machine_target: "That is not a valid account on a computer.",
    error_machine_transport_failed: "That computer could not complete the sign-in. Check its Runtime window, then try again.",
  },
  "zh-TW": {
    heading: "連接你的 AI 帳號",
    lead: "用這裡的按鈕操作；Kiro、Claude Code 和 Codex 都不需要在終端機輸入，各自會前往官方網站完成授權。也可以之後再從儀表板連接。",
    check: "檢查連接狀態", skipped: "稍後連接 · 會留在「等你回應」", valid: "已連接 ✓", notInstalled: "這台主機上沒有安裝",
    consoleOnly: "請改用主控台備援，或稍後連接。", needed: "尚未連接", waiting: "等待 CLI 回應…", login: "連接中：{0}",
    openProvider: "前往官方網站完成授權", deviceCode: "授權碼：", answerSent: "已送出。等待下一個畫面；不會重複送出。",
    cancel: "取消連接", signIn: "連接帳號", signInAgain: "重新連接", later: "稍後連接", submit: "送出{0}",
    relogin: "要重新連接 {0} 嗎？會先撤銷目前帳號的連接。", reloginReplace: "要重新連接 {0} 嗎？新的連接會取代目前使用的帳號。", ready: "可以繼續設定了。",
    field_code: "貼上取得的授權碼", field_start_url: "組織的 Start URL", field_region: "AWS 區域",
    phase_method: "選擇方式", phase_code: "授權碼", phase_start_url: "Start URL", phase_region: "區域", phase_authorization: "授權",
    choice_organization: "你的組織", choice_subscription: "Claude 訂閱",
    antigravity: "Antigravity（主控台備援）",
    error: "無法連接帳號。請檢查狀態、重試，或稍後連接。",
    error_unsupported_prompt: "不支援這個 CLI 畫面。請取消並改用主控台備援。",
    error_cleanup_failed: "無法確認登入程序已關閉。請在主機上關閉它，並重新開始設定後再試。",
    error_signin_cleanup_failed: "無法確認登入程序已關閉。請在主機上關閉它，並重新開始設定後再試。",
    error_signin_action_stale: "這個畫面已改變或已回答過。請重新整理狀態，不要再送一次。",
    error_signin_console_only: "這個後端使用主控台備援。",
    error_backend_signin_local_only: "AI 帳號只能在這台電腦上連接。請使用本機的設定頁，或稍後連接。",
    error_signin_session_expired: "這個設定工作階段已結束。請在主機上重新開啟設定。",
    error_expired: "這次登入已過期。請重新開始。",
    error_busy: "已有另一個登入正在進行。請等它結束或先取消，再試一次。",
    error_signin_busy: "已有另一個登入正在進行。請等它結束或先取消，再試一次。",
    error_signin_profile_unknown: "清單裡沒有這個帳號。請先在 設定 → 帳號 用 + 新增帳號 加入，再連接。",
    error_auth_unconfirmed: "CLI 已結束，但無法確認憑證。請重試或稍後連接。",
    error_provider_rejected: "平台拒絕了這次授權。請重試或稍後連接。",
    // #3190 Part 3c：配對電腦上的憑證設定檔（儀表板的「帳號」頁）。
    error_machine_unknown: "那台電腦已不再配對。",
    error_machine_offline: "那台電腦離線了。請先啟動它的 Runtime，再試一次。",
    error_machine_unsupported: "那台電腦的 Runtime 太舊，無法在這裡登入。請先更新它的 Runtime，再試一次。",
    error_machine_accounts_off: "那台電腦的擁有者尚未允許這件事。請在那台電腦上執行：agend-runtime remote-setup accounts on",
    error_machine_unreachable: "那台電腦沒有回應。請檢查它的 Runtime 視窗，再試一次。",
    error_machine_profile_not_owned: "這個帳號不是 AgEnD 的 Runtime 建立的，只能在那台電腦上連接：agend-runtime login claude-code NAME",
    error_machine_busy: "那台電腦上已經有另一個登入在進行。",
    error_invalid_machine_target: "這不是電腦上的有效帳號。",
    error_machine_transport_failed: "那台電腦沒有完成這次登入。請檢查它的 Runtime 視窗，再試一次。",
  },
};
const NAMES = { "kiro-cli": "Kiro", "claude-code": "Claude Code", codex: "Codex", antigravity: "Antigravity" };
const CHOICES = { builder_id: "Builder ID", google: "Google", github: "GitHub", organization: null, subscription: null, console: "Anthropic Console" };
/** The page's language, as its <html lang> says (the setup page and the dashboard both keep it current). */
const pageLang = doc => /^zh/i.test(doc?.documentElement?.lang || "") ? "zh-TW" : "en";

/**
 * `machine` (#3190 Part 3c): these cards are for ONE credential profile on a paired computer (the endpoint carries `?machine=&profile=`). The dialog around them says
 * so, so the setup page's heading and lead are not repeated; there is no "sign in later" (this is an explicit request); and a sign-in again asks nothing about
 * Kiro (Claude Code's own sign-in replaces the login; it signs nothing out first).
 *
 * `dashboard` (#3321 S01, S12): the cards are inside the dashboard, where the dialog's own title names the CLI and the question "Sign in again?" is asked in the dashboard's
 * own confirmation (`ask`) — the setup page's heading, lead and "You can continue setup" are not repeated, and the browser's `confirm()` is not used.
 *
 * `dialog: true` (#3212, named accounts on this host): the cards are inside Settings → Accounts' sign-in dialog for ONE account, which says WHICH account in its title; it
 * is the same screen for the default account and a named one. So the rest of what the first-install page needs is left out too: no "Check sign-ins" button (the cards read
 * themselves every second) and no "Sign in later" (nothing would remember it). `focus` (a backend id) then shows only that backend's card: the default account's checklist may
 * hold others. The setup page and the installer's `?backend_signins=` list do not pass `dialog`, and look as they did.
 *
 * `started` (run id → void): called with the id of the run a press of Sign in in THESE cards started — the id the server names as created by that very request (`started` in its
 * answer), never one it joined that was already running (another tab's, another backend's, a double click). The account dialog keeps it, to end exactly that run when it closes.
 * `abandoned` (run id → void): the same id, when the cards were disposed (the dialog closed) while that request was still in flight: nobody is left to show or keep the run, so
 * whoever mounted the cards ends it by this id. Nothing is drawn, and no other run is touched.
 */
export function mountStructuredSignIns(root, { endpoint, fetcher = fetch, changed = () => {}, lang, machine = false, ask, dashboard = false, dialog = false, focus, started = () => {}, abandoned = () => {} } = {}) {
  const doc = root.ownerDocument;
  let view = null, busy = false, disposed = false, timer = null, generation = 0, message = "", rendered = "";
  const language = () => (lang ? lang() : pageLang(doc)) === "zh-TW" ? "zh-TW" : "en";
  const tr = (key, value) => { const text = SIGNIN_STRINGS[language()][key] ?? SIGNIN_STRINGS.en[key] ?? key; return value === undefined ? text : text.split("{0}").join(value); };
  const el = (tag, text, parent = root) => { const node = doc.createElement(tag); if (text) node.textContent = text; parent.append(node); return node; };
  // An error is kept as its code, so it is said again in the other language when that changes.
  const errorText = code => machine && SIGNIN_STRINGS.en["error_machine_" + code] ? tr("error_machine_" + code) : SIGNIN_STRINGS.en["error_" + code] ? tr("error_" + code) : tr("error");
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
    try {
      const next = await request(data);
      const created = data?.operation === "start" && typeof next?.started === "string" ? next.started : null;   // a start that joined a run already there names none
      if (disposed) { if (created) abandoned(created); }
      else { if (created) started(created); accept(next); }
    }
    catch (error) { if (!disposed) message = String(error?.message || "error"); }
    finally { busy = false; if (!disposed) render(); }
  }
  function render() {
    const signature = JSON.stringify([view, busy, message, language()]);
    if (disposed || rendered === signature) return;
    rendered = signature; root.replaceChildren();
    // Ridge #3321 S12: inside the dashboard (`dashboard`) the dialog's own title names the CLI — the setup page's heading, lead and
    // "continue setup" are not repeated there.
    if (!machine && !dashboard) { el("h2", tr("heading")); el("p", tr("lead")); }
    if (message) { const alert = el("p", errorText(message)); alert.setAttribute("role", "alert"); }
    // In the account dialog the cards read themselves every second, so there is no Check sign-ins — except when the first read failed and there is nothing to show: then it is the Retry.
    if (!view) { if (!dialog || message) button(root, tr("check"), () => perform({ operation: "refresh" })); return; }
    for (const backend of dialog && focus ? view.selected.filter(b => b === focus) : view.selected) {
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
        // Ridge #3321 S01: the question names THIS card's CLI, and says what a sign-in again does to it — only Kiro signs out
        // first (logoutArgv); Claude Code and Codex sign in again over the account they have. The dashboard passes its own
        // in-app confirmation (`ask`); the setup page, which loads nothing else, keeps the browser's.
        if (usable) button(card, tr(state === "valid" ? "signInAgain" : "signIn"), async () => {
          const relogin = state === "valid";
          if (relogin && !machine) {
            const question = tr(backend === "kiro-cli" ? "relogin" : "reloginReplace", name(backend));
            if (!(await (ask ? ask(question, name(backend)) : globalThis.confirm(question)))) return;
          }
          await perform({ operation: "start", backend, relogin });
        });
      }
      if (pending && !skipped && !machine && !dialog) button(card, tr("later"), () => perform({ operation: "skip", backend }));
    }
    if (!dialog) button(root, tr("check"), () => perform({ operation: "refresh" }));
    if (view.ready && !machine && !dashboard) el("p", tr("ready"));
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
