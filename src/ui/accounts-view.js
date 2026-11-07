// #3212 PR 1: Settings → Agents → Accounts — one card per CLI: its default sign-in and its named credential profiles
// (the ones agents use, and the ones only on this host), which account each is (masked, #3190), who uses it and its
// weekly usage. From GET /ui/accounts (the local admin session only; nothing about a credential reaches this page).
// - Sign in / Sign in again: the existing dialogs (backend-signin.js: one implementation, the same login flows).
// - Move agents here: stages each chosen agent's `backend_options.<cli>.credential_profile`, through Settings' own
//   staging and Save (a change of account waits for the same confirmation as any credential setting, and restarts).
// - Fleet default: the same, for `defaults.backend_options.<cli>.credential_profile`.
// - AccountSelect: the Agent dialog's Account field (settings-dialogs.js), from the same view.
// Rows carry a `scope`: `host`, and (#3190 Part 3c) a paired computer's `machine` rows under its name — Claude Code first. A computer's account is signed in, signed
// out and removed here only where its Runtime allows it (its owner turned `accounts` on there, and the profile is one that Runtime created); every other row is
// read-only with the reason (a code from the server, worded here) and the command to run on that computer.
// Words are registered here (a new module: an older cached strings file never leaves a raw key).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { appStore, createStore, useStore } from "/assets/app-store.js";
import { Dialog } from "/assets/ui-dialog.js";
import { ErrorState, Skeleton } from "/assets/ui-states.js";
import { CliProductMark, cliLabel } from "./cli-picker.js";
import { identityText } from "./account-identity.js";
import { openSignIn, refreshSignIn, signInStore } from "./backend-signin.js";
import { toast } from "/assets/ui-toast.js";
import { shellStore } from "/assets/app-shell.js";
import { AddAccountDialog, RemoveAccountDialog, SignOutDialog, SIGN_OUT_CLIS, manageWords } from "./accounts-manage.js";   // #3212 PR 2, PR 3
import { machineSignInStore, openMachineSignIn } from "./machine-signin.js";   // #3190 Part 3c
import { KeepAliveControl } from "./accounts-keepalive.js";   // #3292

register("accounts", {
  en: {
    title: "Accounts", hint: "Each CLI's sign-ins on this AgEnD host and on paired computers: the default one and named accounts (credential profiles), who uses them and their weekly usage.",
    loading: "Reading accounts…", failed: "Could not read the accounts.", empty: "No CLI is installed or used by an agent on this host.",
    def: "Default sign-in", profile: "Account “{0}”", state_usable: "signed in", state_not_signed_in: "not signed in", state_unknown: "not checked",
    state_not_installed: "not installed", state_too_old: "too old",
    usedBy: "used by {0}", usedByNone: "used by no agent", agents: "{0} agents", agent: "1 agent", channels: "{0} ClassicBot rooms", channel: "1 ClassicBot room",
    fleetDefaultTag: "fleet default", weekly: "{0}% of the week", resets: "resets {0}", stale: "last known",
    signIn: "Sign in", signInAgain: "Sign in again", hostCommand: "Sign in from chat", hostCommandHint: "This row cannot sign in from the dashboard. Send /login in chat, or ask General.",
    moveHere: "Move agents here", moveTitle: "Move agents to {0}", moveLead: "Choose the {0} agents that should use {1}. Each restarts on it when you Save:",
    carry_claude: "Claude Code carries its conversation over.", carry_codex: "Codex keeps its conversation.", carry_kiro: "Kiro starts a new conversation, with a handover.",
    moveNone: "Every {0} agent already uses this account.", moveStage: "Stage", cancel: "Cancel", current: "now: {0}",
    fleetDefault: "Fleet default for {0} agents", fleetDefaultHint: "Agents that don't choose an account use this one.",
    machine: "On {0}", machineReadOnly: "Read-only here", machineOnline: "online", machineOffline: "offline", machineDefaultTag: "this computer's default",
    machineNoUsage: "—", machineNoUsageHint: "That computer does not report usage.",
    machineCommand: "Sign in on that computer", machineCommandHint: "Run this in a terminal on {0}.",
    why_offline: "{0} is offline. Start its Runtime to manage its accounts.",
    why_runtime_old: "{0}'s Runtime is too old to manage accounts from here. Update the Runtime on that computer.",
    why_accounts_off: "The owner of {0} has not allowed account changes from AgEnD. On that computer run: agend-runtime remote-setup accounts on",
    why_switch_unreadable: "{0} did not say whether account changes are allowed. Check its Runtime window.",
    why_not_installed: "Claude Code is not installed on {0}. Install it from Settings → Runtime.",
    why_not_created: "This account was not created by AgEnD's Runtime, so it can only be handled on {0}.",
    why_default_login: "This is the Windows user's own sign-in on {0}. It is never changed from here: add an account instead.",
    acctLabel: "Account", acctInherit: "Fleet default ({0})", acctInheritDefault: "Fleet default (default sign-in)", acctNotSignedIn: "{0} — not signed in",
    acctHint: "Changing the account restarts the agent. A signed-out account can't be chosen: sign it in under Accounts first.",
    acctDefaultBlocked: "This fleet's default for {0} is “{1}”, so an agent follows it unless it names another account.",
    usedPopTitle: "Agents using this account", usedGo: "Open settings →", usedGoFor: "Open the settings of {0}",
  },
  "zh-TW": {
    title: "帳號", hint: "這台 AgEnD 主機與已配對電腦上各 CLI 的登入：預設登入與具名帳號（憑證設定檔）、誰在使用，以及每週用量。",
    loading: "正在讀取帳號…", failed: "無法讀取帳號。", empty: "這台主機上沒有安裝或被 Agent 使用的 CLI。",
    def: "預設登入", profile: "帳號「{0}」", state_usable: "已登入", state_not_signed_in: "尚未登入", state_unknown: "未確認",
    state_not_installed: "未安裝", state_too_old: "版本太舊",
    usedBy: "使用者：{0}", usedByNone: "沒有 Agent 使用", agents: "{0} 個 Agent", agent: "1 個 Agent", channels: "{0} 個 ClassicBot 房間", channel: "1 個 ClassicBot 房間",
    fleetDefaultTag: "Fleet 預設", weekly: "本週已用 {0}%", resets: "{0} 重置", stale: "最後已知",
    signIn: "登入", signInAgain: "重新登入", hostCommand: "從聊天登入", hostCommandHint: "這一列無法從儀表板登入。請在聊天傳 /login，或請 General。",
    moveHere: "移入 Agent", moveTitle: "把 Agent 移到 {0}", moveLead: "選擇要改用 {1} 的 {0} Agent。按「儲存」後，各自會以它重新啟動：",
    carry_claude: "Claude Code 會帶著對話過去。", carry_codex: "Codex 保留原本的對話。", carry_kiro: "Kiro 會開新對話並附上交接。",
    moveNone: "所有 {0} Agent 都已經使用這個帳號。", moveStage: "加入待儲存", cancel: "取消", current: "目前：{0}",
    fleetDefault: "{0} Agent 的 Fleet 預設帳號", fleetDefaultHint: "沒有指定帳號的 Agent 會使用這個。",
    machine: "在 {0}", machineReadOnly: "這裡只能檢視", machineOnline: "在線", machineOffline: "離線", machineDefaultTag: "這台電腦的預設",
    machineNoUsage: "—", machineNoUsageHint: "那台電腦不回報用量。",
    machineCommand: "在那台電腦上登入", machineCommandHint: "請在 {0} 的終端機執行。",
    why_offline: "{0} 離線了。請先啟動它的 Runtime，才能管理它的帳號。",
    why_runtime_old: "{0} 的 Runtime 太舊，無法從這裡管理帳號。請更新那台電腦上的 Runtime。",
    why_accounts_off: "{0} 的擁有者尚未允許從 AgEnD 變更帳號。請在那台電腦上執行：agend-runtime remote-setup accounts on",
    why_switch_unreadable: "{0} 沒有回報是否允許變更帳號。請檢查它的 Runtime 視窗。",
    why_not_installed: "{0} 上沒有安裝 Claude Code。請從「設定 → Runtime」安裝。",
    why_not_created: "這個帳號不是 AgEnD 的 Runtime 建立的，只能在 {0} 上處理。",
    why_default_login: "這是 {0} 上 Windows 使用者自己的登入，永遠不會從這裡更改：請改用新增帳號。",
    acctLabel: "帳號", acctInherit: "Fleet 預設（{0}）", acctInheritDefault: "Fleet 預設（預設登入）", acctNotSignedIn: "{0}——尚未登入",
    acctHint: "更換帳號會重新啟動 Agent。尚未登入的帳號不能選，請先在「帳號」登入。",
    acctDefaultBlocked: "這個 Fleet 的 {0} 預設帳號是「{1}」，Agent 除非指定其他帳號，否則會使用它。",
    usedPopTitle: "使用此帳號的 Agent（點擊跳轉設定）", usedGo: "前往設定 →", usedGoFor: "前往 {0} 的設定",
  },
});
const tx = (k, ...v) => t(`accounts.${k}`, ...v);
/** The reasons that apply to a whole computer (the heading says them once); the others belong to one row. A code a newer server sends that this page does not know is shown as it is. */
const MACHINE_LEVEL = new Set(["offline", "runtime_old", "accounts_off", "switch_unreadable", "not_installed"]);
const reasonText = (code, name) => { const key = `why_${code}`, text = tx(key, name); return text === `accounts.${key}` ? String(code) : text; };
/** This view's stylesheet, linked once (a tab opened before an upgrade has an app.css without these rules). */
function linkAccountsCss(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector('link[data-accounts-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/accounts.css"); link.setAttribute("data-accounts-css", "1");
    doc.head.appendChild(link);
  } catch { /* the view still works without it */ }
}
const CARRY = { "claude-code": "carry_claude", codex: "carry_codex", "kiro-cli": "carry_kiro" };

export const accountsStore = createStore({ loaded: false, failed: false, view: null });
/**
 * #3313 review P2-7: the server says sign-ins changed (`backend_login`: a sign-in moved, an account was learned, a Keep
 * sign-in alive check finished): a page showing the accounts reads them again, fresh. Listened to once per page. The
 * existing event, so a tab whose cached shell (app-stream.js) predates this still delivers it.
 */
let accountsEventOff = null;
export function listenAccountsEvent() {
  if (accountsEventOff) return;
  const on = appStore.get().streamOn;
  if (typeof on !== "function") return;
  accountsEventOff = on("backend_login", () => { if (accountsStore.get().loaded) void refreshAccounts({ fresh: true }); }) || (() => {});
}
let reading = null, started = 0, applied = 0;
/**
 * Read GET /ui/accounts. A read already running is joined — unless `fresh` (#3291 review, Prism P2-4: after a write, the
 * view must come from a read that began after it): then a new read starts, and an older one that answers later never
 * replaces a newer answer. Resolves true only when THIS read's view was applied (#3313 review r2: what a write's follow-up
 * read needs to know).
 */
export function refreshAccounts({ fresh = false } = {}) {
  if (reading && !fresh) return reading;
  const mine = ++started;
  const apply = (next) => { if (mine > applied) { applied = mine; accountsStore.set(next); return true; } return false; };
  const p = fetch("/ui/accounts", { credentials: "same-origin", cache: "no-store" })
    .then(async (r) => { const v = r.ok ? await r.json() : null; return apply({ loaded: true, failed: !v, view: v }) && !!v; })
    .catch(() => { apply({ loaded: true, failed: true, view: accountsStore.get().view }); return false; })
    .finally(() => { if (reading === p) reading = null; });
  reading = p;
  return p;
}
const rowName = (row) => (row.profile ? tx("profile", row.profile) : tx("def"));
const usedText = (row) => {
  const parts = [];
  const n = row.usedBy.agents.length, c = row.usedBy.classic.length;
  if (n) parts.push(n === 1 ? tx("agent") : tx("agents", n));
  if (c) parts.push(c === 1 ? tx("channel") : tx("channels", c));
  return parts.length ? tx("usedBy", parts.join(" · ")) : tx("usedByNone");
};
const when = (iso) => { try { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : ""; } catch { return ""; } };

/**
 * The fleet default's `backend_options` after choosing `profile` (null: none) for `backend`: the whole map, because the
 * defaults write replaces a nested map whole (the Advanced editor relies on that to remove a key). Built on what is
 * already staged, so two CLIs' choices add up in one change; null when it comes back to what is saved.
 */
export function defaultsBackendOptions(saved, staged, backend, profile) {
  const copy = (m) => Object.fromEntries(Object.entries(m && typeof m === "object" ? m : {}).filter(([, o]) => o && typeof o === "object" && !Array.isArray(o)).map(([b, o]) => [b, { ...o }]));
  const out = copy(staged || saved);
  const next = { ...(out[backend] || {}) };
  if (profile) next.credential_profile = profile; else delete next.credential_profile;
  if (Object.keys(next).length) out[backend] = next; else delete out[backend];
  const same = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, Object.keys(a[k]).sort().map((j) => [j, a[k][j]])]))
    === JSON.stringify(Object.keys(b).sort().map((k) => [k, Object.keys(b[k]).sort().map((j) => [j, b[k][j]])]));
  return same(out, copy(saved)) ? null : out;
}

/** The choices for an agent's Account field: its CLI's named, host profiles (signed-out ones listed, not choosable). */
export function accountChoices(view, backend) {
  const cli = view && Array.isArray(view.clis) ? view.clis.find((c) => c.backend === backend) : null;
  if (!cli || !cli.profiles) return null;
  return { fleetDefault: cli.fleetDefault, rows: cli.rows.filter((r) => r.scope && r.scope.kind === "host" && r.profile) };
}

/**
 * Settings → Agents → Accounts. `stageAgent(name, inst, patch)` and `stageDefault(backend, profile | null)` stage changes;
 * `openAgent(name)` (#3212 PR 2) opens an agent's own dialog, where its Account is chosen (Remove's Move…).
 */
// Ridge #3321 S08: the host's own group head, beside paired computers' "On <computer>".
register("accounts", {
  en: { onHost: "On this AgEnD host" },
  "zh-TW": { onHost: "在這台 AgEnD 主機上" },
});

export function AccountsView({ instances, stageAgent, stageDefault, openAgent }) {
  const { loaded, failed, view } = useStore(accountsStore);
  // Settings read its data again (after a Save): so does this view.
  useEffect(() => { if (loaded) void refreshAccounts(); }, [instances]);
  const { structured, login } = useStore(signInStore);
  const machineLogin = useStore(machineSignInStore);   // #3190 Part 3c: the open sign-in dialog of a computer's account
  const [move, setMove] = useState(null);           // { cli, row }
  const [adding, setAdding] = useState(null);       // #3212 PR 2: the card whose + Add account is open; #3190 Part 3c: { cli, machine } for a computer's
  const [removing, setRemoving] = useState(null);   // { cli, row }
  const [signingOut, setSigningOut] = useState(null);   // #3212 PR 3: { cli, row, mode: "signout" | "switch" }
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  // #3291 review (Prism P2-5 remainder): each dialog this view opens is a new interaction. Add's follow-up (the read,
  // then Sign in) belongs to the interaction it came from: any later one — another Add, a Remove, Move agents — makes it
  // do nothing.
  const interaction = useRef(0);
  const begin = (fn) => (...a) => { interaction.current++; fn(...a); };
  // The sign-in controllers' state too (a sign-in already running disables Sign in, as the old list did).
  useEffect(() => { linkAccountsCss(); listenAccountsEvent(); void refreshAccounts(); void refreshSignIn(); }, []);
  // A sign-in that ends may be another account now: read again.
  const phase = `${(login && login.phase) || ""}:${(structured && structured.login && structured.login.phase) || ""}:${machineLogin.phase || ""}`;
  useEffect(() => { if (loaded) void refreshAccounts(); }, [phase]);
  const active = structured && structured.login;
  const machineActive = !!machineLogin.phase && machineLogin.phase !== "done" && !(machineLogin.phase === "failed" && machineLogin.reason);
  const running = !!((login && login.phase === "running") || (active && active.phase !== "done" && !(active.phase === "failed" && active.reason)) || machineActive);
  if (!loaded) return html`<section class="s-group s-accounts" aria-label=${tx("title")}>
    <header class="s-auth-section-head"><div><h3>${tx("title")}</h3><p>${tx("hint")}</p></div></header>
    <${Skeleton} variant="cards" lines=${2} label=${tx("loading")} /></section>`;
  // Ridge #3321 S07: a first read that fails keeps the section's heading and says so with Retry (the shared ErrorState).
  if (failed && !view) return html`<section class="s-group s-accounts" aria-label=${tx("title")}>
    <header class="s-auth-section-head"><div><h3>${tx("title")}</h3><p>${tx("hint")}</p></div></header>
    <${ErrorState} message=${tx("failed")} onRetry=${() => void refreshAccounts({ fresh: true })} /></section>`;
  const clis = (view && view.clis) || [];
  return html`<section class="s-group s-accounts" aria-label=${tx("title")}>
    <header class="s-auth-section-head"><div><h3>${tx("title")}</h3><p>${tx("hint")}</p></div></header>
    ${!clis.length ? html`<p class="note">${tx("empty")}</p>` : clis.map((cli) => html`<${Card} key=${cli.backend} cli=${cli} running=${running} openAgent=${openAgent} onMove=${begin((row) => setMove({ cli, row }))} stageDefault=${stageDefault}
      onAdd=${begin((machine) => setAdding(machine ? { cli, machine } : cli))} onRemove=${begin((row) => setRemoving({ cli, row }))} onSignIn=${begin((target) => (target.machine ? openMachineSignIn(target) : openSignIn(target)))}
      onSignOut=${begin((row, mode) => setSigningOut({ cli, row, mode }))} />`)}
    ${move ? html`<${MoveDialog} cli=${move.cli} row=${move.row} instances=${instances} stageAgent=${stageAgent} onClose=${() => setMove(null)} />` : null}
    ${adding ? html`<${AddAccountDialog} cli=${adding.machine ? adding.cli : adding} machine=${adding.machine || null} label=${cliLabel((adding.machine ? adding.cli : adding).backend)} onClose=${() => setAdding(null)}
      onAdded=${(name) => { const mine = ++interaction.current, a = adding; void (a.machine ? machineAdded(a.machine, name, () => mounted.current && interaction.current === mine) : accountAdded(a.backend, name, () => mounted.current && interaction.current === mine)); }} />` : null}
    ${signingOut ? html`<${SignOutDialog} cli=${signingOut.cli} row=${signingOut.row} mode=${signingOut.mode} label=${cliLabel(signingOut.cli.backend)}
      onClose=${() => setSigningOut(null)} onMove=${(user) => moveUser(signingOut.cli.backend, user, openAgent)}
      onDone=${() => { const s = signingOut, mine = ++interaction.current; void signedOut(s, () => mounted.current && interaction.current === mine); }} />` : null}
    ${removing ? html`<${RemoveAccountDialog} cli=${removing.cli} row=${removing.row} label=${cliLabel(removing.cli.backend)} onClose=${() => setRemoving(null)}
      onRemoved=${() => void refreshAccounts({ fresh: true })} onMove=${(user) => moveUser(removing.cli.backend, user, openAgent)} />` : null}
  </section>`;
}

/**
 * After + Add account: the view read again (a read begun after the write), then Sign in at once where the dashboard can
 * sign it in (else its row shows the host command) — only while this is still the person's current interaction
 * (`current()`: the view on screen, no dialog opened since) and no other dialog is open on the page.
 */
async function accountAdded(backend, name, current) {
  await refreshAccounts({ fresh: true });
  if (!current() || shellStore.get().dialog) return;
  const v = accountsStore.get().view, cli = v && Array.isArray(v.clis) ? v.clis.find((c) => c.backend === backend) : null;
  const row = cli ? cli.rows.find((r) => r.scope && r.scope.kind === "host" && r.profile === name) : null;
  if (row && row.signIn) { toast(manageWords.added(name), true); openSignIn({ backend, profile: name }); }
  else toast(manageWords.addedHost(name), true);
}
/**
 * #3190 Part 3c: after + Add account on a computer: the server only checked the name (the folder is made by that computer's Runtime when the first sign-in starts), so
 * Sign in opens at once for the new name — while this is still the person's current interaction and no other dialog is open.
 */
async function machineAdded(machine, name, current) {
  await refreshAccounts({ fresh: true });
  if (!current() || shellStore.get().dialog) return;
  openMachineSignIn({ machine, profile: name });
}
/**
 * #3212 PR 3: after Sign out — the view and the sign-ins read again (reads begun after it); Switch account then opens
 * Sign in for the same CLI's default sign-in, while that is still the person's current interaction and no other dialog
 * is open.
 */
async function signedOut({ cli, row, mode }, current) {
  await Promise.all([refreshAccounts({ fresh: true }), refreshSignIn()]);
  if (mode !== "switch" || !current() || shellStore.get().dialog) return;
  openSignIn({ backend: cli.backend, ...(row.profile ? { profile: row.profile } : {}) });
}
/** Remove's Move…: an agent's own dialog (its Account field), or the card's fleet-default selector. */
function moveUser(backend, user, openAgent) {
  if (user.kind === "agent" && typeof openAgent === "function") { openAgent(user.name); return; }
  if (user.kind === "default" && typeof document !== "undefined") {
    const sel = document.querySelector(`.s-account-card[data-backend="${backend}"] .s-account-default select`);
    if (sel) { sel.scrollIntoView?.({ block: "center" }); sel.focus(); }
  }
}

function Card({ cli, running, openAgent, onMove, stageDefault, onAdd, onRemove, onSignIn, onSignOut }) {
  const [picked, setPicked] = useState(undefined);   // a staged fleet default, shown until Save reads it back
  useEffect(() => setPicked(undefined), [cli.fleetDefault]);
  const host = cli.rows.filter((r) => r.scope && r.scope.kind === "host");
  const machines = new Map();
  for (const r of cli.rows) if (r.scope && r.scope.kind === "machine") { const k = r.scope.id; if (!machines.has(k)) machines.set(k, { scope: r.scope, rows: [] }); machines.get(k).rows.push(r); }
  const signedIn = host.filter((r) => r.profile && r.state !== "not_signed_in");
  return html`<div class="s-account-card" data-backend=${cli.backend}>
    <div class="s-account-head"><${CliProductMark} id=${cli.backend} size=${24} /><strong>${cliLabel(cli.backend)}</strong>
      ${cli.profiles && typeof onAdd === "function" ? html`<button type="button" class="btn btn-sm s-account-add" onClick=${() => onAdd()}>${manageWords.add()}</button>` : null}</div>
    ${/* Ridge #3321 S08: beside paired computers' "On <computer>" groups, the host's rows are named as the host's too. */ ""}
    ${machines.size && host.length ? html`<div class="s-account-machine-head s-account-host-head"><strong>${tx("onHost")}</strong></div>` : null}
    <div class="s-account-rows">${host.map((row) => html`<${Row} key=${row.profile || ""} cli=${cli} row=${row} running=${running} openAgent=${openAgent} onMove=${onMove} onRemove=${onRemove} onSignIn=${onSignIn} onSignOut=${onSignOut} />`)}</div>
    ${[...machines.values()].map((m) => html`<${MachineSection} key=${m.scope.id} cli=${cli} m=${m} running=${running} openAgent=${openAgent} onAdd=${onAdd} onSignIn=${onSignIn} onSignOut=${onSignOut} onRemove=${onRemove} />`)}
    ${cli.profiles && typeof stageDefault === "function" ? html`<label class="field s-account-default"><span>${tx("fleetDefault", cliLabel(cli.backend))}</span>
      <select value=${(picked !== undefined ? picked : cli.fleetDefault) || ""} onChange=${(e) => { setPicked(e.target.value || null); stageDefault(cli.backend, e.target.value || null); }}>
        <option value="">${tx("def")}</option>
        ${signedIn.map((r) => html`<option value=${r.profile}>${r.profile}</option>`)}
        ${cli.fleetDefault && !signedIn.some((r) => r.profile === cli.fleetDefault) ? html`<option value=${cli.fleetDefault}>${cli.fleetDefault}</option>` : null}
      </select><small class="note">${tx("fleetDefaultHint")}</small></label>` : null}
  </div>`;
}

/**
 * #3190 Part 3c: one paired computer's accounts under its name: online or not, why nothing can be changed there when that is so (said once, for the whole
 * computer), + Add account where its Runtime will take one, and its rows.
 */
function MachineSection({ cli, m, running, openAgent, onAdd, onSignIn, onSignOut, onRemove }) {
  const level = m.rows.map((r) => r.scope.readOnlyReason).find((code) => code && MACHINE_LEVEL.has(code));
  const online = !!m.scope.online;
  return html`<div class="s-account-machine" data-machine=${m.scope.id}>
    <div class="s-account-machine-head"><strong>${tx("machine", m.scope.name)}</strong>
      <span class=${`tag s-auth-state is-${online ? "usable" : "unknown"}`}>${online ? tx("machineOnline") : tx("machineOffline")}</span>
      ${cli.profiles && !level && typeof onAdd === "function" ? html`<button type="button" class="btn btn-sm s-account-add" disabled=${running} onClick=${() => onAdd(m.scope)}>${manageWords.add()}</button>` : null}</div>
    ${level ? html`<p class="note s-account-why" role="status">${reasonText(level, m.scope.name)}</p>` : null}
    ${m.rows.map((row) => html`<${Row} key=${`m:${m.scope.id}:${row.profile || ""}`} cli=${cli} row=${row} running=${running} openAgent=${openAgent} onSignIn=${onSignIn} onSignOut=${onSignOut} onRemove=${onRemove} />`)}
  </div>`;
}

/**
 * "used by …" (#3212 box layout): a pill. When agents use the account it is a button, and its list opens as a floating
 * layer (`.s-used-popover`, position: absolute: it covers what is below and never moves the card or the next one): each agent
 * with a jump to its own settings (`openAgent`). A click outside or Esc closes it. Closed, the list is not in the page at all.
 */
function UsedBy({ row, label, openAgent }) {
  const agents = row.usedBy.agents;
  const [open, setOpen] = useState(false);
  const wrap = useRef(null), pill = useRef(null);
  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") { setOpen(false); if (pill.current && pill.current.focus) pill.current.focus(); } };
    document.addEventListener("click", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("click", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  useEffect(() => { if (open && !agents.length) setOpen(false); }, [agents.length]);   // read again: nobody uses it any more
  if (!agents.length) return html`<small class="s-account-used">${label}</small>`;
  return html`<span class="s-used-wrap" ref=${wrap}>
    <button type="button" class=${`s-account-used has-users${open ? " is-open" : ""}`} ref=${pill} aria-haspopup="true" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>${label}</button>
    ${open ? html`<div class="s-used-popover" role="group" aria-label=${tx("usedPopTitle")}>
      <p class="s-used-popover-title">${tx("usedPopTitle")}</p>
      <ul>${agents.map((name) => html`<li key=${name}><span class="s-used-agent">${name}</span>
        ${typeof openAgent === "function" ? html`<button type="button" class="btn btn-sm s-used-go" aria-label=${tx("usedGoFor", name)} onClick=${() => { setOpen(false); openAgent(name); }}>${tx("usedGo")}</button>` : null}</li>`)}</ul>
    </div>` : null}
  </span>`;
}

function Row({ cli, row, onMove, onRemove, onSignIn = openSignIn, onSignOut, openAgent, running = false, readOnly = false }) {
  // #3212 PR 3: a signed-in account of a CLI whose own logout the dashboard runs; Switch account on the default sign-in.
  // #3190 Part 3c: a computer's row is changed only where its Runtime allows it (`signIn`); never its default (the Windows user's own sign-in), never Move or Switch.
  const machine = row.scope && row.scope.kind === "machine" ? row.scope : null;
  const manageable = !machine || (row.signIn && !!row.profile);
  const canSignOut = manageable && typeof onSignOut === "function" && row.state === "usable" && SIGN_OUT_CLIS.has(row.backend);
  const who = identityText(row.identity);
  const u = row.usage;
  const why = machine && machine.readOnlyReason && !MACHINE_LEVEL.has(machine.readOnlyReason) ? reasonText(machine.readOnlyReason, machine.name) : "";
  // Three layers in one box: the title bar (name, state, default tag · the buttons), the meta bar (who, used by, week), and Keep sign-in alive as the box's foot.
  return html`<div class="s-row s-account-row" data-account=${row.profile || "default"}>
    <div class="s-account-title-bar">
      <div class="s-account-title-left"><strong>${rowName(row)}</strong>
        <span class=${`tag s-auth-state is-${row.state || "unknown"}`}>${tx(`state_${row.state || "unknown"}`)}</span>
        ${row.usedBy.fleetDefault && cli.profiles ? html`<span class="tag s-account-default-tag">${machine ? tx("machineDefaultTag") : tx("fleetDefaultTag")}</span>` : null}</div>
      ${readOnly ? null : html`<span class="s-actions">
        ${row.signIn && typeof onSignIn === "function" ? html`<button type="button" class=${row.state === "not_signed_in" ? "btn btn-sm btn-primary" : "btn btn-sm"} disabled=${running} onClick=${() => onSignIn({ backend: row.backend, ...(row.profile ? { profile: row.profile } : {}), ...(machine ? { machine } : {}) })}>${row.state === "usable" ? tx("signInAgain") : tx("signIn")}</button>` : null}
        ${!machine && cli.profiles && row.state !== "not_signed_in" && typeof onMove === "function" ? html`<button type="button" class="btn btn-sm" onClick=${() => onMove(row)}>${tx("moveHere")}</button>` : null}
        ${canSignOut && !machine && !row.profile && row.signIn ? html`<button type="button" class="btn btn-sm s-account-switch" disabled=${running} onClick=${() => onSignOut(row, "switch")}>${manageWords.switchAccount()}</button>` : null}
        ${canSignOut ? html`<button type="button" class="btn btn-sm btn-ghost s-account-signout" disabled=${running} onClick=${() => onSignOut(row, "signout")}>${manageWords.signOut()}</button>` : null}
        ${manageable && row.profile && typeof onRemove === "function" ? html`<button type="button" class="btn btn-sm btn-ghost s-account-remove" onClick=${() => onRemove(row)}>${manageWords.remove()}</button>` : null}
      </span>`}
    </div>
    <div class="s-account-meta-bar">
      ${who ? html`<small class="s-account-identity">${who}</small>` : null}
      <${UsedBy} row=${row} label=${usedText(row)} openAgent=${openAgent} />
      ${machine ? html`<small class="s-account-usage is-none" title=${tx("machineNoUsageHint")}>${tx("machineNoUsage")}</small>` : null}
      ${u ? html`<small class=${`s-account-usage${u.stale ? " is-stale" : ""}`}><progress class="s-usage-meter" max="100" value=${Math.max(0, Math.min(100, Number(u.percent) || 0))} aria-hidden="true"></progress>${tx("weekly", u.percent)}${u.resetsAt ? ` · ${tx("resets", when(u.resetsAt))}` : ""}${u.stale ? ` · ${tx("stale")}` : ""}</small>` : null}
    </div>
    ${why ? html`<p class="note s-account-why">${why}</p>` : null}
    ${!readOnly && !row.signIn && row.hostCommand ? html`<details class="s-host-cli-help"><summary>${machine ? tx("machineCommand") : tx("hostCommand")}</summary><p class="note">${machine ? tx("machineCommandHint", machine.name) : tx("hostCommandHint")}</p>${machine ? html`<p class="s-host-cli-command"><code>${row.hostCommand}</code></p>` : null}</details>` : null}
    ${!readOnly && row.keepAlive && (!row.scope || row.scope.kind === "host") ? html`<${KeepAliveControl} row=${row} onSaved=${() => refreshAccounts({ fresh: true })} />` : null}
  </div>`;
}

/** The CLI's agents not on this account; the chosen ones are staged onto it (Settings' Save applies them). */
function MoveDialog({ cli, row, instances, stageAgent, onClose }) {
  const others = cli.agents.filter((a) => a.profile !== row.profile && instances && Object.hasOwn(instances, a.name));
  const [chosen, setChosen] = useState(() => new Set());
  const label = rowName(row);
  const stage = () => {
    for (const name of chosen) {
      const inst = instances[name];
      const opts = { ...(inst.backend_options || {}) };
      opts[cli.backend] = { ...(opts[cli.backend] || {}), credential_profile: row.profile };
      stageAgent(name, inst, { backend_options: opts });
    }
    onClose();
  };
  return html`<${Dialog} title=${tx("moveTitle", label)} onClose=${onClose} actions=${html`<button type="button" class="btn" onClick=${onClose}>${tx("cancel")}</button>
    <button type="button" class="btn btn-primary" disabled=${!chosen.size} onClick=${stage}>${tx("moveStage")}</button>`}>
    ${!others.length ? html`<p class="note">${tx("moveNone", cliLabel(cli.backend))}</p>` : html`<p>${tx("moveLead", cliLabel(cli.backend), label)}</p>
      <p class="note">${tx(CARRY[cli.backend] || "carry_claude")}</p>
      <ul class="s-account-move">${others.map((a) => html`<li><label class="check"><input type="checkbox" checked=${chosen.has(a.name)}
        onChange=${(e) => setChosen((s) => { const n = new Set(s); if (e.target.checked) n.add(a.name); else n.delete(a.name); return n; })} />
        <span>${a.name}</span><small class="note">${tx("current", a.profile || tx("def"))}</small></label></li>`)}</ul>`}
  </${Dialog}>`;
}

/**
 * The Agent dialog's Account field (host agents of a CLI with credential profiles). `value`: the agent's own profile
 * ("" = it names none and follows the fleet default). A signed-out account is listed but disabled.
 */
export function AccountSelect({ id, backend, value, onChange }) {
  const { loaded, view } = useStore(accountsStore);
  useEffect(() => { if (!loaded) void refreshAccounts(); }, []);
  const choices = accountChoices(view, backend);
  if (!choices) return null;
  const inherit = choices.fleetDefault ? tx("acctInherit", choices.fleetDefault) : tx("acctInheritDefault");
  return html`<div class="field s-account-select"><label for=${id}>${tx("acctLabel")}</label>
    <select id=${id} value=${value || ""} onChange=${(e) => onChange(e.target.value)}>
      <option value="">${inherit}</option>
      ${choices.rows.map((r) => html`<option value=${r.profile} disabled=${r.state === "not_signed_in" && r.profile !== value}>${r.state === "not_signed_in" ? tx("acctNotSignedIn", r.profile) : r.profile}</option>`)}
    </select>
    <p class="note">${tx("acctHint")}${choices.fleetDefault ? ` ${tx("acctDefaultBlocked", cliLabel(backend), choices.fleetDefault)}` : ""}</p></div>`;
}
