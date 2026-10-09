// #1519 P1 (docs/design/ux-onboarding-walkthrough.md §5.2): the one bot-token field — the setup wizard, "New
// connection" and a connection's "Replace token" use it. A password field (show/hide), Verify asks the platform who the
// token belongs to (Telegram getMe, Discord /users/@me) and shows the bot's name before anything is written. The token
// lives in this field's state only: never in storage, a URL, a label or the page's other state, and the server never
// hands it back — afterwards a connection shows "Token set · @bot".
import { html, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { api } from "./settings-confirm.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);

/** Who this token is: { valid, username?, reason? } — one outbound check, the token sent once and not kept. */
export async function verifyBotToken(platform, token) {
  const res = await api("/api/settings/quickstart/probe", { method: "POST", body: JSON.stringify({ action: "verify", platform, token }) })
    .catch(() => ({ ok: false, body: {} }));
  // A Discord bot's invite and portal page come with it (#1519 P3).
  if (res.ok && res.body && res.body.identity) return { ...res.body.identity, invite: res.body.invite_url || null, portal: res.body.portal_url || null };
  return { valid: false, reason: (res.body && res.body.error) || tn("verifyFailed") };
}

/** A bot's name as it is addressed: @name, once. */
export const botHandle = (username) => (username ? `@${String(username).replace(/^@/, "")}` : "");

/**
 * The field. props: id, platform, value, onInput(token) (the parent drops its verified identity on a change and moves
 * its credential revision, so a Verify still on its way for the old value cannot land — #1529 review),
 * identity ({ valid, username, reason } | null), busy (the field is locked meanwhile), onVerify(), hint.
 */
export function TokenField({ id, platform, value, onInput, identity, busy, onVerify, hint }) {
  const [shown, setShown] = useState(false);
  return html`<div class="field token-field"><label for=${id}>${tn("wizardToken")}</label>
    <div class="token-row">
      <input id=${id} type=${shown ? "text" : "password"} autocomplete="off" autocapitalize="off" spellcheck="false" disabled=${!!busy}
        placeholder=${platform === "discord" ? "MTA…" : "123456:ABC-DEF…"} value=${value} onInput=${(e) => onInput(e.target.value.trim())} />
      <button type="button" class="icon-btn" aria-pressed=${shown ? "true" : "false"} title=${shown ? tn("tokenHide") : tn("tokenShow")}
        aria-label=${shown ? tn("tokenHide") : tn("tokenShow")} onClick=${() => setShown(!shown)}><${Icon} name="eye" size=${16} /></button>
    </div>
    <p class="note">${hint || (platform === "telegram" ? tn("wizardTokenTelegram") : tn("wizardTokenDiscord"))}</p>
    <div class="dlg-inline-actions"><button type="button" class="btn btn-sm" disabled=${busy || !value} onClick=${onVerify}>${tn("wizardVerify")}</button>
      ${identity ? html`<span class=${`feedback${identity.valid ? " ok" : " error"}`} role="status">${identity.valid
        ? tn("tokenIsBot", botHandle(identity.username) || tn("verified")) : (identity.reason || tn("verifyFailed"))}</span>` : null}</div>
  </div>`;
}

/** The generated env var a token is stored under, read-only with a copy button (the "Advanced" view). */
export function TokenEnvNote({ name }) {
  const [copied, setCopied] = useState(false);
  if (!name) return null;
  const copy = async () => { try { await navigator.clipboard.writeText(name); setCopied(true); } catch { /* the name is on screen */ } };
  return html`<div class="field"><span>${tn("tokenEnv")}</span>
    <div class="dlg-inline-actions"><code>${name}</code><button type="button" class="btn btn-sm btn-ghost" onClick=${copy}>${copied ? tn("copied") : tn("copy")}</button></div>
    <p class="note">${tn("tokenStoredAs")}</p></div>`;
}
