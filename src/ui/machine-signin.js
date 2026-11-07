// #3190 Part 3c: signing a credential profile in on a paired computer, from Settings → Accounts. It is the same sign-in controls as the host's
// (structured-signin.js: the link, the code box, the outcome), pointed at ONE computer and ONE profile — the same /ui/browser-backend-signins with
// `?machine=&profile=` — so there is no second sign-in screen to learn. Only a Claude subscription account is signed in from here: a Console account is kept
// outside the profile's folder, so the person runs `agend-runtime login claude-code NAME` on that computer (said in the dialog).
// A module of its own, its words registered here: a tab that loaded an older accounts-view.js keeps working, and this never meets an older cached strings file.
import { html, useEffect, useRef } from "/assets/app-html.js";
import { register, t, lang, onLang } from "/assets/app-i18n.js";
import { createStore } from "/assets/app-store.js";
import { closeDialog, showDialog } from "/assets/app-shell.js";
import { Dialog } from "/assets/ui-dialog.js";
import { mountStructuredSignIns } from "./structured-signin.js";
import { cliLabel } from "./cli-picker.js";

register("machineSignin", {
  en: {
    title: "Sign in {0} account “{1}” on {2}",
    lead: "AgEnD asks {0}'s Runtime to sign this account in. You get a link here, open it in your browser, and paste back the code it shows. The sign-in is kept on that computer, and anyone who can sign in to that Windows user can use it.",
    console: "Using an Anthropic Console account instead? Run this on that computer: {0}",
    close: "Close",
  },
  "zh-TW": {
    title: "在 {2} 登入 {0} 帳號「{1}」",
    lead: "AgEnD 會請 {0} 的 Runtime 登入這個帳號。這裡會給你一個連結，在瀏覽器開啟後，把它顯示的代碼貼回來。登入資料保存在那台電腦上，能登入該 Windows 使用者的人都能使用它。",
    console: "要改用 Anthropic Console 帳號嗎？請在那台電腦上執行：{0}",
    close: "關閉",
  },
});
const tm = (k, ...v) => t(`machineSignin.${k}`, ...v);

/** What the Accounts view reads to refresh itself and to keep a second sign-in from starting: the open dialog's current phase for the computer's profile. */
export const machineSignInStore = createStore({ phase: "", reason: "" });

/** The endpoint of one profile's sign-in on one computer. */
export const machineSignInEndpoint = (machineId, profile) => `/ui/browser-backend-signins?machine=${encodeURIComponent(machineId)}&profile=${encodeURIComponent(profile)}`;

/** `machine`: `{ id, name }`; `profile`: the credential profile's name on that computer. */
export function MachineSignInDialog({ machine, profile, onClose }) {
  const root = useRef(null), close = onClose || closeDialog;
  useEffect(() => {
    const cards = mountStructuredSignIns(root.current, { endpoint: machineSignInEndpoint(machine.id, profile), lang, machine: true, changed: (next) => {
      const login = next && next.login;
      machineSignInStore.set({ phase: login ? login.phase : "", reason: (login && login.reason) || "" });
    } });
    const unlisten = onLang(() => cards.relabel());
    return () => { unlisten(); cards.dispose(); machineSignInStore.set({ phase: "", reason: "" }); };
  }, [machine.id, profile]);
  return html`<${Dialog} title=${tm("title", cliLabel("claude-code"), profile, machine.name)} onClose=${close}
    actions=${html`<button type="button" class="btn" onClick=${close}>${tm("close")}</button>`}>
    <p>${tm("lead", machine.name)}</p>
    <p class="note">${tm("console", `agend-runtime login claude-code ${profile}`)}</p>
    <div class="signin-browser" ref=${root}></div>
  </${Dialog}>`;
}

/** Open the dialog for one profile on one computer. */
export function openMachineSignIn({ machine, profile }) { showDialog(MachineSignInDialog, { machine: { id: machine.id, name: machine.name }, profile }); }
