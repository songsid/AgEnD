// #3190 Part 3c: signing a credential profile in on a paired computer, from Settings → Accounts. It is the same sign-in controls as the host's
// (structured-signin.js: the link, the code box, the outcome), pointed at ONE computer and ONE profile — the same /ui/browser-backend-signins with
// `?machine=&profile=` — so there is no second sign-in screen to learn. Only a Claude subscription account is signed in from here: a Console account is kept
// outside the profile's folder, so the person runs `agend-runtime login claude-code NAME` on that computer (said in the dialog).
// AGEND-113: a CLI whose registry spec says `runtime.signIn.profile === "none"` (cli-caps.js: `runtimeDefaultLogin`; Antigravity) has no profile: its login on Windows is one entry in the Credential
// Manager, so this signs the computer's OWN login in (`?machine=&backend=<cli>`), after the person has confirmed that it changes that login (a computer can only have one).
// A module of its own, its words registered here: a tab that loaded an older accounts-view.js keeps working, and this never meets an older cached strings file.
import { html, useEffect, useRef } from "/assets/app-html.js";
import { register, t, lang, onLang } from "/assets/app-i18n.js";
import { createStore } from "/assets/app-store.js";
import { closeDialog, showDialog } from "/assets/app-shell.js";
import { Dialog } from "/assets/ui-dialog.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { mountStructuredSignIns } from "./structured-signin.js";
import { cliLabel } from "./cli-picker.js";
import { capsOf } from "./cli-caps.js";

register("machineSignin", {
  en: {
    title: "Connect {0} account “{1}” on {2}",
    lead: "AgEnD asks {0}'s Runtime to connect this account. You get a link here, open it in your browser, finish on the provider's official website, and paste back the authorization code it shows. The connection is kept on that computer, and anyone who can sign in to that Windows user can use it.",
    console: "Using an Anthropic Console account instead? Run this on that computer: {0}",
    close: "Close",
    titleDefault: "Connect {0} on {1}",
    leadDefault: "AgEnD asks {1}'s Runtime to connect {0}. You get a link here, open it in your browser, finish with the account, and paste back the code it shows. This replaces the {0} connection of the Windows user on that computer (a computer has only one), and anyone who can sign in to that Windows user can use it.",
    confirmTitle: "Change {1}'s connection on {0}?",
    confirm: "This changes the {1} connection on {0}. One computer can only have one {1} account, so the account that is connected there now is replaced.",
    confirmLabel: "Continue",
  },
  "zh-TW": {
    title: "在 {2} 連接 {0} 帳號「{1}」",
    lead: "AgEnD 會請 {0} 的 Runtime 連接這個帳號。這裡會給你一個連結，在瀏覽器開啟、前往官方網站完成授權後，把它顯示的授權碼貼回來。連接資料保存在那台電腦上，能登入該 Windows 使用者的人都能使用它。",
    console: "要改用 Anthropic Console 帳號嗎？請在那台電腦上執行：{0}",
    close: "關閉",
    titleDefault: "在 {1} 連接 {0}",
    leadDefault: "AgEnD 會請 {1} 的 Runtime 連接 {0}。這裡會給你一個連結，在瀏覽器開啟後用帳號完成連接，再把它顯示的授權碼貼回來。這會取代那台電腦上 Windows 使用者目前的 {0} 連接（一台電腦只能有一個），能登入該 Windows 使用者的人都能使用它。",
    confirmTitle: "要更改 {0} 上的 {1} 連接嗎？",
    confirm: "這會更改 {0} 上的 {1} 連接。一台電腦只能有一個 {1} 帳號，所以目前連接在那裡的帳號會被取代。",
    confirmLabel: "繼續",
  },
});
const tm = (k, ...v) => t(`machineSignin.${k}`, ...v);
/** The CLI's login on a computer is the computer's own, with no profile (cli-caps.js: `runtimeDefaultLogin`). */
const ownLogin = (backend) => !!(capsOf(backend) && capsOf(backend).runtimeDefaultLogin);

/** What the Accounts view reads to refresh itself and to keep a second sign-in from starting: the open dialog's current phase for the computer's profile. */
export const machineSignInStore = createStore({ phase: "", reason: "" });

/** The endpoint of one profile's sign-in on one computer; with a `backend` whose login is the computer's own (no profile), that login. */
export const machineSignInEndpoint = (machineId, profile, backend) => backend && !profile && ownLogin(backend)
  ? `/ui/browser-backend-signins?machine=${encodeURIComponent(machineId)}&backend=${encodeURIComponent(backend)}`
  // AGEND-124: a NAMED account of a CLI other than Claude Code (Antigravity) names its CLI too; Claude Code's address is the one it always had.
  : backend && backend !== "claude-code" && profile
    ? `/ui/browser-backend-signins?machine=${encodeURIComponent(machineId)}&backend=${encodeURIComponent(backend)}&profile=${encodeURIComponent(profile)}`
    : `/ui/browser-backend-signins?machine=${encodeURIComponent(machineId)}&profile=${encodeURIComponent(profile)}`;

/** `machine`: `{ id, name }`; `profile`: the credential profile's name on that computer (none for a CLI whose login is the computer's own: its `backend` says which). */
export function MachineSignInDialog({ machine, profile, backend, onClose }) {
  const root = useRef(null), close = onClose || closeDialog;
  const bare = !profile && ownLogin(backend);
  useEffect(() => {
    const cards = mountStructuredSignIns(root.current, { endpoint: machineSignInEndpoint(machine.id, profile, backend), lang, machine: true, codeHint: (b) => !!(capsOf(b) && capsOf(b).codeHint), changed: (next) => {
      const login = next && next.login;
      machineSignInStore.set({ phase: login ? login.phase : "", reason: (login && login.reason) || "" });
    } });
    const unlisten = onLang(() => cards.relabel());
    return () => { unlisten(); cards.dispose(); machineSignInStore.set({ phase: "", reason: "" }); };
  }, [machine.id, profile, backend]);
  const product = cliLabel(backend && backend !== "claude-code" ? backend : "claude-code"), claude = !backend || backend === "claude-code";
  return html`<${Dialog} title=${bare ? tm("titleDefault", cliLabel(backend), machine.name) : tm("title", product, profile, machine.name)} onClose=${close}
    actions=${html`<button type="button" class="btn" onClick=${close}>${tm("close")}</button>`}>
    <p>${bare ? tm("leadDefault", cliLabel(backend), machine.name) : tm("lead", machine.name)}</p>
    ${bare || !claude ? null : html`<p class="note">${tm("console", `agend-runtime login claude-code ${profile}`)}</p>`}
    <div class="signin-browser" ref=${root}></div>
  </${Dialog}>`;
}

/**
 * Open the dialog for one profile on one computer. For a computer's OWN login of a CLI (no profile; Antigravity) the person is asked first: it replaces the login of that computer's
 * Windows user, which is not an account AgEnD created, so it never changes without that answer.
 */
export function openMachineSignIn({ machine, profile, backend }) {
  const target = { machine: { id: machine.id, name: machine.name }, ...(profile ? { profile } : {}), ...(!profile && ownLogin(backend) ? { backend } : {}), ...(profile && backend && backend !== "claude-code" ? { backend } : {}) };
  // A NAMED account (with or without a CLI other than Claude Code) is one AgEnD's Runtime made: no question first. Only the computer's own login is confirmed.
  if (profile || !target.backend) { showDialog(MachineSignInDialog, target); return; }
  void confirmDialog({ title: tm("confirmTitle", machine.name, cliLabel(backend)), message: tm("confirm", machine.name, cliLabel(backend)), confirmLabel: tm("confirmLabel") })
    .then((yes) => { if (yes) showDialog(MachineSignInDialog, target); }, () => {});
}
