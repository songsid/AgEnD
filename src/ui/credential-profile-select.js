import { html } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";

/**
 * Claude accounts on a paired Windows computer ("credential profiles"). AgEnD only ever shows and sends a profile NAME; the sign-in itself
 * stays on that computer, and a Runtime reports nothing but each name and whether it is signed in. No path, e-mail or token is read here.
 */
register("claudeAccount", {
  en: { label:"Claude account", none:"This computer's default sign-in", default:"default", signedOut:"not signed in", unchecked:"not checked", notReported:"not reported",
    old:"Update the Runtime on that computer to choose a Claude account for this agent.",
    empty:"No Claude accounts reported yet. On that computer run agend-runtime login claude-code NAME, then choose Detect again in that computer's CLI diagnostics (Settings → Runtime).",
    hint:"The account is chosen by name; its sign-in stays on that computer. A name that does not exist or is not signed in there is refused, never replaced by another account.",
    changeNote:"Changing the account starts a new conversation." },
  "zh-TW": { label:"Claude 帳號", none:"這台電腦的預設登入", default:"預設", signedOut:"尚未登入", unchecked:"未確認", notReported:"未回報",
    old:"請更新那台電腦上的 Runtime，才能為這個 Agent 選擇 Claude 帳號。",
    empty:"尚未回報任何 Claude 帳號。請在那台電腦執行 agend-runtime login claude-code 名稱，再到設定 → Runtime，在該電腦的「CLI 診斷」按「重新偵測」。",
    hint:"帳號以名稱選擇，登入資料只保留在那台電腦。不存在或尚未登入的名稱會被拒絕，不會改用其他帳號。",
    changeNote:"更換帳號會開始新的對話。" },
});
export const accountText = (key, ...values) => t(`claudeAccount.${key}`, ...values);

/** What a computer reports: whether its Runtime can choose an account, each account's name and signed-in yes/no, and its default name. */
export function credentialProfileView(machine) {
  const capable = machine?.runtimeInfo?.capabilities?.includes("credential-profiles") === true;
  const report = machine?.inventory?.credentialProfiles;
  const profiles = Array.isArray(report?.profiles) ? report.profiles.filter(row => row && typeof row.name === "string") : [];
  return { capable, profiles, defaultName: typeof report?.default === "string" ? report.default : "" };
}
export const credentialProfileState = loggedIn => loggedIn === true ? "signedIn" : loggedIn === false ? "signedOut" : "unchecked";
/** The choice exists only for Claude Code on a paired computer. */
export const offersClaudeAccount = (machine, backend) => !!machine && backend === "claude-code";

/**
 * `value` is the chosen name ("" = the computer's own sign-in). A signed-out account is listed but cannot be chosen; one that is
 * "not checked" can, because the Runtime asks the CLI again before anything starts and refuses if it is not signed in.
 */
export function ClaudeAccountSelect({ machine, backend, value, onChange, id, disabled = false, changeNote = false }) {
  if (!offersClaudeAccount(machine, backend)) return null;
  const view = credentialProfileView(machine), known = view.profiles.some(row => row.name === value);
  const locked = disabled || !view.capable;
  return html`<div class="claude-account-field"><label class="field"><span>${accountText("label")}</span>
    <select id=${id} value=${value || ""} disabled=${locked} onChange=${event => onChange(event.target.value)}>
      <option value="">${accountText("none")}</option>
      ${view.profiles.map(row => html`<option key=${row.name} value=${row.name} disabled=${row.loggedIn === false}>${row.name}${row.loggedIn === false ? ` · ${accountText("signedOut")}` : row.loggedIn === null ? ` · ${accountText("unchecked")}` : ""}${row.name === view.defaultName ? ` · ${accountText("default")}` : ""}</option>`)}
      ${value && !known ? html`<option key=${value} value=${value}>${value} · ${accountText("notReported")}</option>` : null}
    </select></label>
    ${!view.capable ? html`<p class="note claude-account-old" role="status">${accountText("old")}</p>`
      : !view.profiles.length ? html`<p class="note claude-account-empty">${accountText("empty")}</p>` : html`<p class="note">${accountText("hint")}</p>`}
    ${changeNote ? html`<p class="note claude-account-change">${accountText("changeNote")}</p>` : null}</div>`;
}
