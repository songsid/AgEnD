import { html } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { identityText } from "./account-identity.js";
import { capsOf } from "./cli-caps.js";
import { cliLabel } from "./cli-picker.js";

/**
 * Claude (and, AGEND-124, Antigravity) accounts on a paired Windows computer ("credential profiles"). AgEnD only ever shows and sends a profile NAME; the sign-in itself
 * stays on that computer, and a Runtime reports nothing but each name and whether it is signed in. No path, e-mail or token is read here.
 */
register("claudeAccount", {
  en: { label:"Claude account", none:"This computer's default connection", default:"default", signedOut:"not connected", unchecked:"not checked", notReported:"not reported",
    old:"Update the Runtime on that computer to choose a Claude account for this agent.",
    empty:"No Claude accounts reported yet. On that computer run agend-runtime login claude-code NAME, then choose Detect again in that computer's CLI diagnostics (Settings → Runtime).",
    hint:"The account is chosen by name; its connection stays on that computer. A name that does not exist or is not connected there is refused, never replaced by another account.",
    changeNote:"Changing the account starts a new conversation.",
    labelOther:"{0} account", noneOther:"This computer's own {0} connection", oldOther:"Update the Runtime on that computer to choose a {0} account for this agent.",
    emptyOther:"No {0} accounts reported yet. Add one in Settings → Agent → Accounts, under that computer's name." },
  "zh-TW": { label:"Claude 帳號", none:"這台電腦的預設連接", default:"預設", signedOut:"尚未連接", unchecked:"未確認", notReported:"未回報",
    old:"請更新那台電腦上的 Runtime，才能為這個 Agent 選擇 Claude 帳號。",
    empty:"尚未回報任何 Claude 帳號。請在那台電腦執行 agend-runtime login claude-code 名稱，再到設定 → Runtime，在該電腦的「CLI 診斷」按「重新偵測」。",
    hint:"帳號以名稱選擇，連接資料只保留在那台電腦。不存在或尚未連接的名稱會被拒絕，不會改用其他帳號。",
    changeNote:"更換帳號會開始新的對話。",
    labelOther:"{0} 帳號", noneOther:"這台電腦自己的 {0} 連接", oldOther:"請更新那台電腦上的 Runtime，才能為這個 Agent 選擇 {0} 帳號。",
    emptyOther:"尚未回報任何 {0} 帳號。請到設定 → Agent → 帳號，在該電腦的名稱下新增。" },
});
export const accountText = (key, ...values) => t(`claudeAccount.${key}`, ...values);

/** The CLIs whose accounts an agent on a computer can choose (the registry's `runtime.namedAccounts`, as cli-caps.js renders it), and what each is called here. */
export const accountCli = backend => !!(capsOf(backend) && capsOf(backend).runtimeNamedAccounts);
const productOf = backend => backend === "claude-code" ? "Claude" : cliLabel(backend);
/** What a computer reports: whether its Runtime can choose an account (`backend`: of this CLI, default Claude Code), each account's name and signed-in yes/no, and its default name. */
export function credentialProfileView(machine, backend = "claude-code") {
  const caps = machine?.runtimeInfo?.capabilities;
  // Claude Code's come with `credential-profiles`; any other CLI's also need the capability of its own (`accounts-<id>`): an older Runtime would run the agent on the Windows user's own login.
  const capable = caps?.includes("credential-profiles") === true && (backend === "claude-code" || caps.includes(`accounts-${backend}`));
  const report = machine?.inventory?.credentialProfiles;
  const own = backend === "claude-code" ? report?.profiles : report?.byCli?.[backend];
  const profiles = Array.isArray(own) ? own.filter(row => row && typeof row.name === "string") : [];
  // The default sign-in's own account (the computer's Claude Code, as its last detection saw it), for the "default sign-in" choice.
  const claude = Array.isArray(machine?.inventory?.clis) ? machine.inventory.clis.find(cli => cli?.id === "claude-code") : undefined;
  const defaultName = backend === "claude-code" && typeof report?.default === "string" ? report.default : "";
  return { capable, profiles, defaultName, machineIdentity: identityText(profiles.find(row => row.name === defaultName)?.identity ?? claude?.identity) };
}
export const credentialProfileState = loggedIn => loggedIn === true ? "signedIn" : loggedIn === false ? "signedOut" : "unchecked";
/** The choice exists for Claude Code and Antigravity (a CLI with named accounts on a computer) on a paired computer. */
export const offersClaudeAccount = (machine, backend) => !!machine && accountCli(backend);

/**
 * `value` is the chosen name ("" = the computer's own sign-in). A signed-out account is listed but cannot be chosen; one that is
 * "not checked" can, because the Runtime asks the CLI again before anything starts and refuses if it is not signed in.
 */
export function ClaudeAccountSelect({ machine, backend, value, onChange, id, disabled = false, changeNote = false }) {
  if (!offersClaudeAccount(machine, backend)) return null;
  const view = credentialProfileView(machine, backend), known = view.profiles.some(row => row.name === value);
  const locked = disabled || !view.capable, claude = backend === "claude-code", product = productOf(backend);
  return html`<div class="claude-account-field"><label class="field"><span>${claude ? accountText("label") : accountText("labelOther", product)}</span>
    <select id=${id} value=${value || ""} disabled=${locked} onChange=${event => onChange(event.target.value)}>
      <option value="">${claude ? accountText("none") : accountText("noneOther", product)}${view.machineIdentity ? ` · ${view.machineIdentity}` : ""}</option>
      ${view.profiles.map(row => html`<option key=${row.name} value=${row.name} disabled=${row.loggedIn === false}>${row.name}${row.identity ? ` · ${identityText(row.identity)}` : ""}${row.loggedIn === false ? ` · ${accountText("signedOut")}` : row.loggedIn === null ? ` · ${accountText("unchecked")}` : ""}${row.name === view.defaultName ? ` · ${accountText("default")}` : ""}</option>`)}
      ${value && !known ? html`<option key=${value} value=${value}>${value} · ${accountText("notReported")}</option>` : null}
    </select></label>
    ${!view.capable ? html`<p class="note claude-account-old" role="status">${claude ? accountText("old") : accountText("oldOther", product)}</p>`
      : !view.profiles.length ? html`<p class="note claude-account-empty">${claude ? accountText("empty") : accountText("emptyOther", product)}</p>` : html`<p class="note">${accountText("hint")}</p>`}
    ${changeNote ? html`<p class="note claude-account-change">${accountText("changeNote")}</p>` : null}</div>`;
}
