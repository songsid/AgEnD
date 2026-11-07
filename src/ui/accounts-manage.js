// #3212 PR 2: Settings → Accounts — + Add account and Remove (POST/DELETE /ui/accounts/…, accounts-profiles.ts on the
// server, which decides; this page only asks). A module of its own, its words registered here: a tab that loaded PR 1's
// accounts-view.js keeps working without these, and these never meet an older cached strings file.
// - AddAccountDialog: a name (checked here as the server checks it, so the person sees why at once); Add creates the
//   profile's folder; then Sign in opens right away where the dashboard can sign it in, else the row shows the host command.
// - RemoveAccountDialog: names the account and its CLI and what is lost; while anything uses it, Remove is not offered and
//   each user is listed with Move… (an agent: its own dialog's Account field; the fleet default: the card's selector; a
//   ClassicBot room: where its account is set); typing the account's name enables Remove.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { toast } from "/assets/ui-toast.js";

register("accountsManage", {
  en: {
    add: "+ Add account", addTitle: "Add a {0} account", addLead: "A named account is a separate sign-in on this host. Name it, then sign it in.",
    nameLabel: "Name", nameHint: "Letters, digits, dots, hyphens or underscores; it starts with a letter or digit.", addGo: "Add",
    cancel: "Cancel", adding: "Adding…",
    err_name: "Use 1–64 letters, digits, dots, hyphens or underscores, starting with a letter or digit; not ending with a dot, and not a Windows device name (CON, NUL…).",
    err_exists: "An account with this name already exists.", err_case_clash: "“{0}” already exists; names that differ only in letter case would be the same folder.",
    err_unsafe_root: "The accounts folder on this host isn't a plain folder of this account, so nothing was created.",
    err_backend: "This CLI has no named accounts.", err_failed: "That didn't work. Try again.",
    added: "Account “{0}” added.", addedHostSignIn: "Account “{0}” added. Sign it in on the host with the command on its row.",
    remove: "Remove…", removeTitle: "Remove the {0} account “{1}”?",
    removeLead: "This deletes the account's folder on this host: its sign-in.", removeLeadClaude: "This deletes the account's folder on this host: its sign-in and its own copies of conversations.",
    removeAfter: "Agents can't use it afterwards.", sep: " ",
    inUse: "Still used by — move each to another account first:", inUseAgent: "Agent {0}", inUseRoom: "ClassicBot room {0}", inUseDefault: "The fleet default for {0} agents",
    move: "Move…", roomHow: "Change it in that room's ClassicBot settings (its credential_profile).",
    typeLabel: "Type {0} to confirm", removeGo: "Remove", removing: "Removing…", removed: "Account “{0}” removed.",
    err_confirm: "Type the account's name exactly.", err_in_use: "Something still uses this account.", err_signing_in: "A sign-in for this account is running. Wait for it to end, or cancel it.",
    err_missing: "This account's folder is no longer there.", err_unsafe: "This account's folder isn't a plain folder of this account inside AgEnD's accounts folder, so nothing was deleted.",
    err_default_home: "That is the CLI's default sign-in, which is never deleted here.",
    err_users_unknown: "AgEnD can't read the ClassicBot settings, so it can't tell whether a room uses this account. Fix classicBot.yaml, then try again.",
    signOut: "Sign out…", switchAccount: "Switch account…", signOutTitle: "Sign out of {0}'s {1}?", switchTitle: "Switch {0}'s default sign-in?",
    signOutLead: "AgEnD runs {0}'s own logout for this account on the host. Its conversations stay.",
    switchLead: "AgEnD signs this account out with {0}'s own logout, then opens Sign in for the account you want. Agents using it restart on the new account once you've signed in.",
    stopUsers: "Using it now — they stop working until it's signed in again:", nobody: "No agent, ClassicBot room or fleet default uses it.",
    signOutGo: "Sign out", switchGo: "Sign out and sign in", signingOut: "Signing out…", signedOut: "Signed out.",
    keychainLeft: "Signed out, but a Keychain item for this account is still on this Mac. Remove it in Keychain Access.",
    removedKeychainLeft: "Account “{0}” removed, but a Keychain item for it is still on this Mac. Remove it in Keychain Access.",
    err_unsupported: "This CLI can't be signed out from here.", err_signout_failed: "{0}'s logout didn't succeed. Try again, or run it on the host.",
    defName: "default sign-in", acctName: "account “{0}”",
    // #3190 Part 3c: an account on a paired computer (its Runtime does the work; the computer's owner has to allow it there).
    addTitleMachine: "Add a {0} account on {1}", addLeadMachine: "A named account is a separate sign-in kept on {0}. Name it, then sign it in here. Its folder is made by that computer's Runtime.",
    removeLeadMachine: "This deletes the account's folder on {0}: its sign-in and its own copies of conversations. That computer's Runtime does it, and records it.",
    inUseMachineDefault: "This computer's default account for agents (change it on that computer: agend-runtime profile default NAME)",
    signOutLeadMachine: "AgEnD asks {0}'s Runtime to run {1}'s own logout for this account. Its conversations stay.",
    err_machine_unknown: "That computer is not paired any more.", err_machine_offline: "That computer is offline. Start its Runtime, then try again.",
    err_machine_unsupported: "That computer's Runtime is too old for this. Update the Runtime on it, then try again.",
    err_machine_accounts_off: "The owner of that computer has not allowed this. On that computer run: agend-runtime remote-setup accounts on",
    err_machine_unreachable: "That computer did not answer. Check its Runtime window, then try again.",
    err_machine_profile_not_owned: "This account was not created by AgEnD's Runtime, so it can only be changed on that computer.",
    err_machine_default_login: "That is the Windows user's own sign-in on that computer, which is never changed from here.",
    err_machine_refused: "That computer did not do it.",
  },
  "zh-TW": {
    add: "＋ 新增帳號", addTitle: "新增 {0} 帳號", addLead: "具名帳號是這台主機上另一組登入。先取名，再登入。",
    nameLabel: "名稱", nameHint: "英文字母、數字、句點、連字號或底線；以字母或數字開頭。", addGo: "新增",
    cancel: "取消", adding: "正在新增…",
    err_name: "請用 1–64 個英文字母、數字、句點、連字號或底線，以字母或數字開頭；不能以句點結尾，也不能是 Windows 裝置名稱（CON、NUL…）。",
    err_exists: "已經有這個名稱的帳號。", err_case_clash: "已經有「{0}」；只差大小寫的名稱會是同一個資料夾。",
    err_unsafe_root: "這台主機的帳號資料夾不是這個使用者的一般資料夾，所以沒有建立任何東西。",
    err_backend: "這個 CLI 沒有具名帳號。", err_failed: "沒有成功，請再試一次。",
    added: "已新增帳號「{0}」。", addedHostSignIn: "已新增帳號「{0}」。請用它那一列的指令在主機上登入。",
    remove: "移除…", removeTitle: "要移除 {0} 帳號「{1}」嗎？",
    removeLead: "這會刪除這台主機上該帳號的資料夾：它的登入。", removeLeadClaude: "這會刪除這台主機上該帳號的資料夾：它的登入，以及它自己的對話副本。",
    removeAfter: "之後 Agent 就不能使用它。", sep: "",
    inUse: "仍在使用中，請先把每一項移到其他帳號：", inUseAgent: "Agent {0}", inUseRoom: "ClassicBot 房間 {0}", inUseDefault: "{0} Agent 的 Fleet 預設帳號",
    move: "移動…", roomHow: "請在該房間的 ClassicBot 設定（credential_profile）中更改。",
    typeLabel: "輸入 {0} 以確認", removeGo: "移除", removing: "正在移除…", removed: "已移除帳號「{0}」。",
    err_confirm: "請正確輸入帳號名稱。", err_in_use: "仍有項目在使用這個帳號。", err_signing_in: "這個帳號正在登入。請等它結束，或取消它。",
    err_missing: "這個帳號的資料夾已經不在了。", err_unsafe: "這個帳號的資料夾不是 AgEnD 帳號資料夾裡、屬於這個使用者的一般資料夾，所以沒有刪除任何東西。",
    err_default_home: "那是 CLI 的預設登入，這裡永遠不會刪除它。",
    err_users_unknown: "AgEnD 無法讀取 ClassicBot 設定，所以無法確定是否有房間在使用這個帳號。請先修正 classicBot.yaml 再試一次。",
    signOut: "登出…", switchAccount: "切換帳號…", signOutTitle: "要登出 {0} 的{1}嗎？", switchTitle: "要切換 {0} 的預設登入嗎？",
    signOutLead: "AgEnD 會在主機上用 {0} 自己的登出指令登出這個帳號。它的對話會保留。",
    switchLead: "AgEnD 會用 {0} 自己的登出指令登出這個帳號，然後開啟「登入」讓你登入想用的帳號。登入後，使用它的 Agent 會以新帳號重新啟動。",
    stopUsers: "目前使用中——在重新登入前它們都無法運作：", nobody: "沒有 Agent、ClassicBot 房間或 Fleet 預設在使用它。",
    signOutGo: "登出", switchGo: "登出並登入", signingOut: "正在登出…", signedOut: "已登出。",
    keychainLeft: "已登出，但這台 Mac 上仍有這個帳號的鑰匙圈項目。請在「鑰匙圈存取」中刪除。",
    removedKeychainLeft: "已移除帳號「{0}」，但這台 Mac 上仍有它的鑰匙圈項目。請在「鑰匙圈存取」中刪除。",
    err_unsupported: "這個 CLI 無法在這裡登出。", err_signout_failed: "{0} 的登出沒有成功。請再試一次，或在主機上執行。",
    defName: "預設登入", acctName: "帳號「{0}」",
    // #3190 Part 3c：配對電腦上的帳號（由那台電腦的 Runtime 執行；需要電腦的擁有者在那裡允許）。
    addTitleMachine: "在 {1} 新增 {0} 帳號", addLeadMachine: "具名帳號是保存在 {0} 上的另一組登入。先取名，再在這裡登入。它的資料夾由那台電腦的 Runtime 建立。",
    removeLeadMachine: "這會刪除 {0} 上該帳號的資料夾：它的登入，以及它自己的對話副本。由那台電腦的 Runtime 執行並記錄。",
    inUseMachineDefault: "這台電腦給 Agent 用的預設帳號（請在那台電腦上更改：agend-runtime profile default NAME）",
    signOutLeadMachine: "AgEnD 會請 {0} 的 Runtime 用 {1} 自己的登出指令登出這個帳號。它的對話會保留。",
    err_machine_unknown: "那台電腦已不再配對。", err_machine_offline: "那台電腦離線了。請先啟動它的 Runtime，再試一次。",
    err_machine_unsupported: "那台電腦的 Runtime 太舊，無法這樣做。請先更新它的 Runtime，再試一次。",
    err_machine_accounts_off: "那台電腦的擁有者尚未允許這件事。請在那台電腦上執行：agend-runtime remote-setup accounts on",
    err_machine_unreachable: "那台電腦沒有回應。請檢查它的 Runtime 視窗，再試一次。",
    err_machine_profile_not_owned: "這個帳號不是 AgEnD 的 Runtime 建立的，只能在那台電腦上更改。",
    err_machine_default_login: "那是那台電腦上 Windows 使用者自己的登入，這裡永遠不會更改它。",
    err_machine_refused: "那台電腦沒有執行。",
  },
});
const tm = (k, ...v) => t(`accountsManage.${k}`, ...v);

/** The server's name rule (credential-profile.ts + #3190's Windows-safe checks), so the dialog says why before asking. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;
export const validAccountName = (s) => typeof s === "string" && NAME.test(s) && !s.endsWith(".") && !DEVICE.test(s);

async function send(method, path, body) {
  try {
    const r = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch { /* none */ }
    return r.ok ? { ok: true, ...(j || {}) } : { ok: false, error: (j && typeof j.error === "string" && j.error) || "failed", ...(j || {}) };
  } catch { return { ok: false, error: "failed" }; }
}
const errText = (r) => {
  // A computer's own refusal sentence (its Runtime's words, bounded; no path, URL, code or output) says more than ours does.
  if (r.error === "machine_refused" && typeof r.message === "string" && r.message) return r.message;
  const key = `err_${r.error}`, s = tm(key, r.clash || "");
  return s === `accountsManage.${key}` ? tm("err_failed") : s;
};

/** `cli`: the Accounts view's card; `label`: the CLI's name; `onAdded(name)`: after the server made it. */
/**
 * #3291 review (Prism P2-5): while its request runs a dialog can't be dismissed (Cancel disabled; Dialog's `busy` holds ×, Esc and the backdrop), and an answer that
 * comes after the dialog left the page (navigation) does nothing — it never closes or opens what replaced it.
 */
function useLive() {
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  return live;
}
export function AddAccountDialog({ cli, label, machine = null, onClose, onAdded }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const input = useRef(null);
  const live = useLive();
  useEffect(() => { input.current && input.current.focus(); }, []);
  const trimmed = name.trim();
  const shownErr = err || (trimmed && !validAccountName(trimmed) ? tm("err_name") : "");
  const go = async () => {
    if (busy || !validAccountName(trimmed)) return;
    setBusy(true); setErr("");
    const r = await send("POST", `/ui/accounts/${encodeURIComponent(cli.backend)}`, { name: trimmed, ...(machine ? { machine: machine.id } : {}) });
    if (!live.current) return;
    setBusy(false);
    if (!r.ok) { setErr(errText(r)); return; }
    onClose(); onAdded(trimmed);
  };
  return html`<${Dialog} title=${machine ? tm("addTitleMachine", label, machine.name) : tm("addTitle", label)} onClose=${onClose} busy=${busy} actions=${html`<button type="button" class="btn" disabled=${busy} onClick=${onClose}>${tm("cancel")}</button>
    <button type="button" class="btn btn-primary" disabled=${busy || !validAccountName(trimmed)} onClick=${go}>${busy ? tm("adding") : tm("addGo")}</button>`}>
    <p>${machine ? tm("addLeadMachine", machine.name) : tm("addLead")}</p>
    <div class="field"><label for="acctAddName">${tm("nameLabel")}</label>
      <input id="acctAddName" ref=${input} value=${name} maxlength="64" autocomplete="off" spellcheck=${false}
        onInput=${(e) => { setName(e.target.value); setErr(""); }} onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); void go(); } }} />
      <small class="note">${tm("nameHint")}</small>
      ${shownErr ? html`<p class="err" role="alert">${shownErr}</p>` : null}</div>
  </${Dialog}>`;
}

/**
 * `row`: the named account's row (its `usedBy` from the view); `onMove(user)`: open where that user's account is set
 * ({ kind: "agent", name } | { kind: "default" }); `onRemoved()`: after the server removed it.
 */
export function RemoveAccountDialog({ cli, row, label, onClose, onMove, onRemoved }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [users, setUsers] = useState(row.usedBy);    // the server's answer replaces it when it knows better
  const live = useLive();
  const machine = row.scope && row.scope.kind === "machine" ? row.scope : null;   // #3190 Part 3c: an account on a paired computer
  const inUse = users.agents.length > 0 || users.classic.length > 0 || users.fleetDefault;
  const go = async () => {
    if (busy || inUse || typed !== row.profile) return;
    setBusy(true); setErr("");
    const r = await send("DELETE", `/ui/accounts/${encodeURIComponent(cli.backend)}/${encodeURIComponent(row.profile)}`, { confirm: typed, ...(machine ? { machine: machine.id } : {}) });
    if (!live.current) return;
    setBusy(false);
    if (r.ok) { toast(r.keychainLeft ? tm("removedKeychainLeft", row.profile) : tm("removed", row.profile), !r.keychainLeft); onClose(); onRemoved(); return; }
    if (r.error === "in_use" && r.users) setUsers(r.users);
    setErr(errText(r));
  };
  const moveBtn = (user) => html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => { onClose(); onMove(user); }}>${tm("move")}</button>`;
  return html`<${Dialog} title=${tm("removeTitle", label, row.profile)} onClose=${onClose} busy=${busy} actions=${html`<button type="button" class="btn" disabled=${busy} onClick=${onClose}>${tm("cancel")}</button>
    <button type="button" class="btn btn-danger" disabled=${busy || inUse || typed !== row.profile} onClick=${go}>${busy ? tm("removing") : tm("removeGo")}</button>`}>
    <p>${machine ? tm("removeLeadMachine", machine.name) : cli.backend === "claude-code" ? tm("removeLeadClaude") : tm("removeLead")}${tm("sep")}${tm("removeAfter")}</p>
    ${inUse ? html`<div class="s-account-inuse" role="status"><p><strong>${tm("inUse")}</strong></p><ul>
      ${users.agents.map((name) => html`<li><span>${tm("inUseAgent", name)}</span>${moveBtn({ kind: "agent", name })}</li>`)}
      ${users.fleetDefault ? html`<li><span>${machine ? tm("inUseMachineDefault") : tm("inUseDefault", label)}</span>${machine ? null : moveBtn({ kind: "default" })}</li>` : null}
      ${users.classic.map((key) => html`<li><span>${tm("inUseRoom", key)}</span><small class="note">${tm("roomHow")}</small></li>`)}
    </ul></div>` : html`<div class="field"><label for="acctRemoveName">${tm("typeLabel", row.profile)}</label>
      <input id="acctRemoveName" value=${typed} autocomplete="off" spellcheck=${false} onInput=${(e) => { setTyped(e.target.value); setErr(""); }}
        onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); void go(); } }} /></div>`}
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
  </${Dialog}>`;
}

/**
 * #3212 PR 3: Sign out (`mode` "signout") or Switch account (`mode` "switch", the default sign-in): names the account
 * and who stops using it until it is signed in again (an agent and the fleet default with Move…); the CLI's own logout
 * runs on the host. `onDone(result)`: after the server signed it out.
 */
export function SignOutDialog({ cli, row, label, mode = "signout", onClose, onMove, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const live = useLive();
  const users = row.usedBy;
  const any = users.agents.length > 0 || users.classic.length > 0 || users.fleetDefault;
  const which = row.profile ? tm("acctName", row.profile) : tm("defName");
  const machine = row.scope && row.scope.kind === "machine" ? row.scope : null;   // #3190 Part 3c: an account on a paired computer
  const go = async () => {
    if (busy) return;
    setBusy(true); setErr("");
    const r = await send("POST", `/ui/accounts/${encodeURIComponent(cli.backend)}/signout`, { profile: row.profile || null, confirm: true, ...(machine ? { machine: machine.id } : {}) });
    if (!live.current) return;
    setBusy(false);
    if (!r.ok) { setErr(r.error === "failed" ? tm("err_signout_failed", label) : errText(r)); return; }
    toast(r.keychainLeft ? tm("keychainLeft") : tm("signedOut"), !r.keychainLeft);
    onClose(); onDone(r);
  };
  const moveBtn = (user) => html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => { onClose(); onMove(user); }}>${tm("move")}</button>`;
  return html`<${Dialog} title=${mode === "switch" ? tm("switchTitle", label) : tm("signOutTitle", label, which)} onClose=${onClose} busy=${busy}
    actions=${html`<button type="button" class="btn" disabled=${busy} onClick=${onClose}>${tm("cancel")}</button>
    <button type="button" class=${mode === "switch" ? "btn btn-primary" : "btn btn-danger"} disabled=${busy} onClick=${go}>${busy ? tm("signingOut") : mode === "switch" ? tm("switchGo") : tm("signOutGo")}</button>`}>
    <p>${mode === "switch" ? tm("switchLead", label) : machine ? tm("signOutLeadMachine", machine.name, label) : tm("signOutLead", label)}</p>
    ${any ? html`<div class="s-account-inuse" role="status"><p><strong>${tm("stopUsers")}</strong></p><ul>
      ${users.agents.map((name) => html`<li><span>${tm("inUseAgent", name)}</span>${mode === "switch" ? null : moveBtn({ kind: "agent", name })}</li>`)}
      ${users.fleetDefault && row.profile ? html`<li><span>${machine ? tm("inUseMachineDefault") : tm("inUseDefault", label)}</span>${machine ? null : moveBtn({ kind: "default" })}</li>` : null}
      ${users.classic.map((key) => html`<li><span>${tm("inUseRoom", key)}</span></li>`)}
    </ul></div>` : html`<p class="note">${tm("nobody")}</p>`}
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
  </${Dialog}>`;
}

/** The CLIs the dashboard can sign out (their own logout; accounts-signout.ts SIGN_OUT). */
export const SIGN_OUT_CLIS = new Set(["claude-code", "codex", "kiro-cli"]);

/** The button labels the view draws (from this module, so an older view never shows them). */
export const manageWords = { add: () => tm("add"), remove: () => tm("remove"), added: (n) => tm("added", n), addedHost: (n) => tm("addedHostSignIn", n),
  signOut: () => tm("signOut"), switchAccount: () => tm("switchAccount") };
