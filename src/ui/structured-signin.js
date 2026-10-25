/* Shared browser controls. No terminal relay, provider output or secrets in diagnostics. */
const NAMES = { "kiro-cli": "Kiro", "claude-code": "Claude Code", codex: "Codex", antigravity: "Antigravity (console fallback)" };
const CHOICES = { builder_id: "Builder ID", google: "Google", github: "GitHub", organization: "Your organization", subscription: "Claude subscription", console: "Anthropic Console" };
const ERRORS = {
  unsupported_prompt: "This CLI screen is not supported. Cancel and use the console fallback.",
  cleanup_failed: "The login process could not be confirmed closed. Close it on the host and restart setup before retrying.",
  signin_cleanup_failed: "The login process could not be confirmed closed. Close it on the host and restart setup before retrying.",
  signin_action_stale: "That prompt changed or was already answered. Refresh its status; do not submit it again.",
  signin_console_only: "This backend uses the explicit console fallback.",
  backend_signin_local_only: "Backend sign-in is available only on this computer. Use the local setup page, or sign in later.",
  signin_session_expired: "This setup session has ended. Reopen setup on the host.",
  expired: "This login attempt expired. Start a new attempt.",
  auth_unconfirmed: "The CLI exited, but credentials could not be verified. Retry or sign in later.",
  provider_rejected: "The provider rejected this sign-in. Retry or sign in later.",
};

export function mountStructuredSignIns(root, { endpoint, fetcher = fetch, changed = () => {} } = {}) {
  const doc = root.ownerDocument;
  let view = null, busy = false, disposed = false, timer = null, generation = 0, message = "", rendered = "";
  const el = (tag, text, parent = root) => { const node = doc.createElement(tag); if (text) node.textContent = text; parent.append(node); return node; };
  const errorText = code => ERRORS[code] || "Could not complete sign-in. Check status, retry, or sign in later.";
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
    catch (error) { if (!disposed) message = errorText(error?.message); }
    finally { busy = false; if (!disposed) render(); }
  }
  function render() {
    const signature = JSON.stringify([view, busy, message]);
    if (disposed || rendered === signature) return;
    rendered = signature; root.replaceChildren();
    el("h2", "Sign in your AI backends");
    el("p", "Use the controls here; no terminal typing is needed for Kiro, Claude Code or Codex. You can sign in later from the dashboard.");
    if (message) { const alert = el("p", message); alert.setAttribute("role", "alert"); }
    if (!view) { button(root, "Check sign-ins", () => perform({ operation: "refresh" })); return; }
    for (const backend of view.selected) {
      const card = el("section"); card.dataset.backend = backend;
      el("h3", NAMES[backend] || backend, card);
      const state = view.states[backend], pending = view.pending.includes(backend), skipped = view.skipped.includes(backend);
      el("p", skipped ? "Sign in later · remains in Needs you" : state === "valid" ? "Signed in ✓" : state === "not_installed" ? "Not installed on this host" : state === "console_only" ? "Use the explicit console fallback, or sign in later." : "Sign-in needed", card);
      const login = view.login?.backend === backend ? view.login : null;
      const active = login && login.phase !== "done" && !(login.phase === "failed" && login.reason);
      if (active) {
        el("p", login.phase === "waiting" || login.phase === "starting" ? "Waiting for the CLI…" : "Login: " + login.phase.replaceAll("_", " "), card);
        if (login.phase === "method" && login.canAct) for (const choice of login.choices || []) {
          if (CHOICES[choice]) button(card, CHOICES[choice], () => perform({ operation: "input", id: login.id, revision: login.revision, action: { kind: "method", choice } }));
        }
        if (login.url) {
          // The host already allowlists these; still never turn a non-HTTPS URL into a link.
          let url; try { url = new URL(login.url); } catch {}
          if (url?.protocol === "https:" && !url.username && !url.password) {
            const link = el("a", "Open provider sign-in", card); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
          }
        }
        if (login.code) { el("p", "Device code:", card); el("code", login.code, card); }
        if (login.canAct && ["code", "start_url", "region"].includes(login.phase)) {
          const label = el("label", { code: "Paste the returned code", start_url: "Organization Start URL", region: "AWS region" }[login.phase], card);
          const input = el("input", null, label); input.type = login.phase === "code" ? "password" : "text"; input.autocomplete = "off"; input.spellcheck = false;
          input.setAttribute("aria-label", label.textContent); input.disabled = busy;
          button(card, "Submit " + login.phase.replaceAll("_", " "), () => { const value = input.value; input.value = ""; void perform({ operation: "input", id: login.id, revision: login.revision, action: { kind: login.phase, value } }); });
        }
        if (["method", "code", "start_url", "region"].includes(login.phase) && !login.canAct) el("p", "Answer sent. Waiting for the next screen; it will not be sent twice.", card);
        button(card, "Cancel sign-in", () => perform({ operation: "cancel" }));
      } else {
        if (login?.reason && login.reason !== "cancelled") el("p", errorText(login.reason), card);
        const usable = !["antigravity"].includes(backend) && state !== "not_installed";
        if (usable) button(card, state === "valid" ? "Sign in again" : "Sign in", () => {
          const relogin = state === "valid";
          if (relogin && !globalThis.confirm("Sign in again? Kiro will sign out its existing account first.")) return;
          void perform({ operation: "start", backend, relogin });
        });
      }
      if (pending && !skipped) button(card, "Sign in later", () => perform({ operation: "skip", backend }));
    }
    button(root, "Check sign-ins", () => perform({ operation: "refresh" }));
    if (view.ready) el("p", "You can continue setup.");
  }
  async function poll() {
    if (disposed) return;
    const before = generation;
    if (!busy) try { const next = await request(); if (!disposed && before === generation) { accept(next); render(); } }
    catch (error) { if (!disposed && before === generation) { message = errorText(error?.message); render(); } }
    if (!disposed) timer = setTimeout(poll, 1000);
  }
  render(); void poll();
  return {
    addBackends(backends) {
      if (view && Array.isArray(backends) && backends.every(b => NAMES[b]) && backends.some(b => !view.selected.includes(b)))
        return perform({ operation: "select", backends: [...new Set([...view.selected, ...backends])] });
    },
    addBackend(backend) { if (view && NAMES[backend] && !view.selected.includes(backend)) return perform({ operation: "select", backends: [...view.selected, backend] }); },
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
  addEventListener("pagehide", () => { observer.disconnect(); ready.disconnect(); cards.dispose(); }, { once: true });
}
