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
  const key = `err_${r.error}`, s = tm(key, r.clash || "");
  return s === `accountsManage.${key}` ? tm("err_failed") : s;
};

/** `cli`: the Accounts view's card; `label`: the CLI's name; `onAdded(name)`: after the server made it. */
export function AddAccountDialog({ cli, label, onClose, onAdded }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const input = useRef(null);
  useEffect(() => { input.current && input.current.focus(); }, []);
  const trimmed = name.trim();
  const shownErr = err || (trimmed && !validAccountName(trimmed) ? tm("err_name") : "");
  const go = async () => {
    if (busy || !validAccountName(trimmed)) return;
    setBusy(true); setErr("");
    const r = await send("POST", `/ui/accounts/${encodeURIComponent(cli.backend)}`, { name: trimmed });
    setBusy(false);
    if (!r.ok) { setErr(errText(r)); return; }
    onClose(); onAdded(trimmed);
  };
  return html`<${Dialog} title=${tm("addTitle", label)} onClose=${onClose} actions=${html`<button type="button" class="btn" onClick=${onClose}>${tm("cancel")}</button>
    <button type="button" class="btn btn-primary" disabled=${busy || !validAccountName(trimmed)} onClick=${go}>${busy ? tm("adding") : tm("addGo")}</button>`}>
    <p>${tm("addLead")}</p>
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
  const inUse = users.agents.length > 0 || users.classic.length > 0 || users.fleetDefault;
  const go = async () => {
    if (busy || inUse || typed !== row.profile) return;
    setBusy(true); setErr("");
    const r = await send("DELETE", `/ui/accounts/${encodeURIComponent(cli.backend)}/${encodeURIComponent(row.profile)}`, { confirm: typed });
    setBusy(false);
    if (r.ok) { toast(tm("removed", row.profile), true); onClose(); onRemoved(); return; }
    if (r.error === "in_use" && r.users) setUsers(r.users);
    setErr(errText(r));
  };
  const moveBtn = (user) => html`<button type="button" class="btn btn-sm" onClick=${() => { onClose(); onMove(user); }}>${tm("move")}</button>`;
  return html`<${Dialog} title=${tm("removeTitle", label, row.profile)} onClose=${onClose} actions=${html`<button type="button" class="btn" onClick=${onClose}>${tm("cancel")}</button>
    <button type="button" class="btn btn-danger" disabled=${busy || inUse || typed !== row.profile} onClick=${go}>${busy ? tm("removing") : tm("removeGo")}</button>`}>
    <p>${cli.backend === "claude-code" ? tm("removeLeadClaude") : tm("removeLead")}${tm("sep")}${tm("removeAfter")}</p>
    ${inUse ? html`<div class="s-account-inuse" role="status"><p><strong>${tm("inUse")}</strong></p><ul>
      ${users.agents.map((name) => html`<li><span>${tm("inUseAgent", name)}</span>${moveBtn({ kind: "agent", name })}</li>`)}
      ${users.fleetDefault ? html`<li><span>${tm("inUseDefault", label)}</span>${moveBtn({ kind: "default" })}</li>` : null}
      ${users.classic.map((key) => html`<li><span>${tm("inUseRoom", key)}</span><small class="note">${tm("roomHow")}</small></li>`)}
    </ul></div>` : html`<div class="field"><label for="acctRemoveName">${tm("typeLabel", row.profile)}</label>
      <input id="acctRemoveName" value=${typed} autocomplete="off" spellcheck=${false} onInput=${(e) => { setTyped(e.target.value); setErr(""); }}
        onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); void go(); } }} /></div>`}
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
  </${Dialog}>`;
}

/** The button labels the view draws (from this module, so an older view never shows them). */
export const manageWords = { add: () => tm("add"), remove: () => tm("remove"), added: (n) => tm("added", n), addedHost: (n) => tm("addedHostSignIn", n) };
