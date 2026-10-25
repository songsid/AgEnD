// #2233: signing a backend in from the dashboard — the dialog, the line every admin page shows while a sign-in runs,
// and the list Settings → Agents shows. Behind the session gate (/ui/js/); a guest's page never loads it.
//
// What the page is told comes from GET /ui/backend-login, as this session may see it (web-backend-login.ts): the
// session that started a sign-in gets its terminal link, access code and device code; every other admin page only that
// one runs, on which device, and may cancel it. The stream's `backend_login` event carries nothing — it only says to
// read again. Starting is two steps, as in chat: check (the server keeps what it found) and start (with its id).
import { html, useEffect, useState, useRef } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore, createStore, useStore } from "/assets/app-store.js";
import { closeDialog, shellStore, showDialog } from "/assets/app-shell.js";
import { Dialog } from "/assets/ui-dialog.js";
import { toast } from "/assets/ui-toast.js";
import { mountStructuredSignIns } from "./structured-signin.js";

register("signin", {
  en: {
    title: "Sign in to {0}",
    checking: "Checking whether {0} is signed in…",
    confirmDevice: "AgEnD runs {0}'s own sign-in on this machine. You get a link and a one-time code here, to finish in your browser.",
    confirmTerminal: "AgEnD runs {0}'s own sign-in on this machine and opens it as a terminal in your browser (only that sign-in, no shell). You get the link and a one-time access code here.",
    stillSignedIn: "It is still signed in: signing in again replaces that login.",
    logoutFirst: "It signs out first ({0}), then in.",
    publicNote: "Not at this machine? A temporary public link opens the terminal from anywhere, for this sign-in only.",
    go: "Sign in",
    goPublic: "Use a temporary public link",
    cancel: "Cancel",
    close: "Close",
    starting: "Starting…",
    deviceStep: "Open this page and enter the code:",
    linkStep: "Open this page to sign in; if it gives you a code, paste it into the sign-in terminal:",
    terminalStep: "Open the sign-in terminal and enter this access code there. It works once, for {0} minutes.",
    openTerminal: "Open the sign-in terminal",
    accessCode: "Access code",
    code: "Code",
    copy: "Copy",
    copied: "Copied",
    publicLink: "Public link: anyone with the link and the code could use it — keep both to yourself.",
    loopback: "This terminal listens on the machine's own address only. Open it on that machine, or set web_terminal.bind for your network.",
    waitingHint: "Waiting for the sign-in to show its link…",
    signedIn: "{0} is signed in.",
    ended: "The sign-in ended.",
    cancelSignIn: "Cancel sign-in",
    cancelled: "Sign-in cancelled.",
    running: "Signing in to {0} (started on {1}).",
    open: "Open",
    expired: "That took too long — start again.",
    notHere: "Signing in is not available over the public link. Open the dashboard on the machine running AgEnD, or use /login in your chat.",
    notAdmin: "Only a fleet admin signed in on this machine or its network can sign a backend in.",
    notOffered: "A public link is not offered for this sign-in.",
    failed: "That did not work.",
    listTitle: "Sign-ins",
    browserRunning: "Signing in to {0} on this machine",
    consoleFallback: "Use console fallback",
    listHint: "Each backend's login on this machine, and each credential profile an agent uses.",
    stUsable: "signed in",
    stNotSignedIn: "not signed in",
    stNotInstalled: "not installed",
    stTooOld: "too old",
    stUnknown: "not checked",
    signIn: "Sign in",
    signInAgain: "Sign in again",
    onHost: "Sign in on the machine: {0}",
    install: "Install on the machine: {0}",
    update: "Update on the machine: {0}",
    profile: "{0} · profile {1}",
  },
  "zh-TW": {
    title: "登入 {0}",
    checking: "正在確認 {0} 是否已登入…",
    confirmDevice: "AgEnD 會在這台機器上執行 {0} 自己的登入。這裡會給你一個連結和一次性代碼，在瀏覽器完成登入。",
    confirmTerminal: "AgEnD 會在這台機器上執行 {0} 自己的登入，並在瀏覽器以終端機開啟（只有這個登入，沒有 shell）。這裡會給你連結和一次性存取碼。",
    stillSignedIn: "它目前仍是登入狀態：重新登入會取代原本的登入。",
    logoutFirst: "會先登出（{0}），再登入。",
    publicNote: "不在這台機器前？臨時公開連結可以從任何地方開啟終端機，只用於這次登入。",
    go: "登入",
    goPublic: "使用臨時公開連結",
    cancel: "取消",
    close: "關閉",
    starting: "啟動中…",
    deviceStep: "開啟這個頁面並輸入代碼：",
    linkStep: "開啟這個頁面登入；如果它給你一組代碼，請貼到登入終端機：",
    terminalStep: "開啟登入終端機，在那裡輸入這個存取碼。只能用一次，{0} 分鐘內有效。",
    openTerminal: "開啟登入終端機",
    accessCode: "存取碼",
    code: "代碼",
    copy: "複製",
    copied: "已複製",
    publicLink: "公開連結：拿到連結和代碼的人都能使用——兩者都只留給自己。",
    loopback: "這個終端機只在本機位址上接聽。請在那台機器上開啟，或為你的網路設定 web_terminal.bind。",
    waitingHint: "等待登入顯示連結…",
    signedIn: "{0} 已登入。",
    ended: "登入已結束。",
    cancelSignIn: "取消登入",
    cancelled: "已取消登入。",
    running: "正在登入 {0}（從 {1} 啟動）。",
    open: "開啟",
    expired: "等太久了——請重新開始。",
    notHere: "公開連結上不能登入。請在執行 AgEnD 的機器上開啟儀表板，或在聊天裡用 /login。",
    notAdmin: "只有在這台機器或它的網路上登入的 fleet 管理員，才能讓後端登入。",
    notOffered: "這次登入不提供公開連結。",
    failed: "沒有成功。",
    listTitle: "登入",
    browserRunning: "正在這台機器登入 {0}",
    consoleFallback: "改用主控台備援",
    listHint: "這台機器上每個 backend 的登入，以及代理使用的每個憑證設定檔。",
    stUsable: "已登入",
    stNotSignedIn: "未登入",
    stNotInstalled: "未安裝",
    stTooOld: "版本太舊",
    stUnknown: "未檢查",
    signIn: "登入",
    signInAgain: "重新登入",
    onHost: "在機器上登入：{0}",
    install: "在機器上安裝：{0}",
    update: "在機器上更新：{0}",
    profile: "{0} · 設定檔 {1}",
  },
});
const tn = (k, ...v) => t(`signin.${k}`, ...v);
const shownOf = (backend, profile) => (profile ? tn("profile", backend, profile) : backend);

/** What this page knows: the current sign-in as this session may see it, and Settings' list. */
export const signInStore = createStore({ loaded: false, login: null, targets: [], structured: null });

let reading = null, again = false;
/**
 * Read GET /ui/backend-login (one read at a time). Asked again while one is on its way (an event that came after it was
 * sent): one more read follows it, so the last change is never missed (#2262 review).
 */
export function refreshSignIn() {
  if (reading) { again = true; return reading; }
  reading = Promise.all([
    fetch("/ui/backend-login", { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch("/ui/browser-backend-signins", { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null),
  ]).then(([b, structured]) => {
    if (b) signInStore.set({ loaded: true, login: b.login || null, targets: Array.isArray(b.targets) ? b.targets : [] });
    signInStore.set({ structured: structured && Array.isArray(structured.selected) && Array.isArray(structured.pending) ? structured : null }); return b;
  })
    .catch(() => null)
    .finally(() => { reading = null; if (again) { again = false; void refreshSignIn(); } });
  return reading;
}

let installed = false;
/** Once per admin page: listen for `backend_login`, read once, and show the line while a sign-in runs. */
export function installSignIn() {
  if (installed || !signInOffered()) return;
  installed = true;
  const on = appStore.get().streamOn;
  if (typeof on === "function") on("backend_login", () => { void refreshSignIn(); });
  void refreshSignIn();
  shellStore.set({ banner: SignInLine });
}

/** Open the dialog for one login (a backend's default one, or a credential profile). */
export function openSignIn({ backend, profile }) {
  if (!profile && ["kiro-cli", "claude-code", "codex"].includes(backend)) showDialog(BrowserSignInDialog, { backend });
  else showDialog(SignInDialog, { backend, ...(profile ? { profile } : {}) });
}

/** Open the dialog on the running sign-in (its starter's view, or the cancel-only one). */
function openRunning(login) { showDialog(SignInDialog, { backend: login.backend, ...(login.profile ? { profile: login.profile } : {}), resume: true }); }

async function post(path, body) {
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch { /* none */ }
    return { ok: res.ok, status: res.status, body: json };
  } catch { return { ok: false, status: 0, body: null }; }
}

const errorText = (code) => (code === "confirm_expired" ? tn("expired") : code === "tunnel_not_offered" ? tn("notOffered")
  : code === "sign_in_not_over_public_link" ? tn("notHere") : code === "sign_in_needs_a_local_admin" ? tn("notAdmin") : tn("failed"));
/** The public link's page (#2233: Sign in is refused there — never offered). */
export const signInOffered = () => !(typeof document !== "undefined" && document.body && document.body.dataset.publicLink === "1");
const loopbackHost = (h) => h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(h);

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(value); setCopied(true); } catch { toast(value); } };
  return html`<div class="signin-field"><span class="signin-label">${label}</span><code class="signin-value">${value}</code>
    <button type="button" class="btn btn-sm" onClick=${copy}>${copied ? tn("copied") : tn("copy")}</button></div>`;
}

/** The starter's view of a running sign-in: the device link and code, or the terminal and its access code. */
function Running({ login }) {
  const { hint, terminal, accessCode } = login;
  const away = terminal && terminal.loopback && typeof location !== "undefined" && !loopbackHost(location.hostname);
  return html`<div class="signin-run">
    ${hint ? html`<p>${hint.code ? tn("deviceStep") : tn("linkStep")}</p>
      ${hint.linkable ? html`<p><a data-trust="navigation" class="btn btn-primary" href=${hint.url} target="_blank" rel="noopener noreferrer">${tn("open")}</a> <span class="signin-url">${hint.url}</span></p>`
        : html`<${CopyField} label="URL" value=${hint.url} />`}
      ${hint.code ? html`<${CopyField} label=${tn("code")} value=${hint.code} />` : null}` : null}
    ${terminal ? html`<p>${tn("terminalStep", terminal.ttlMinutes)}</p>
      <p><a data-trust="navigation" class="btn btn-primary" href=${terminal.url} target="_blank" rel="noopener noreferrer">${tn("openTerminal")}</a></p>
      ${accessCode ? html`<${CopyField} label=${tn("accessCode")} value=${accessCode} />` : null}
      ${terminal.public ? html`<p class="signin-note">${tn("publicLink")}</p>` : null}
      ${away ? html`<p class="signin-note">${tn("loopback")}</p>` : null}` : null}
    ${!hint && !terminal ? html`<p class="signin-note">${tn("waitingHint")}</p>` : null}
  </div>`;
}

/** The same closed controls as first setup. Profile-specific logins retain their existing flow. */
export function BrowserSignInDialog({ backend, onClose }) {
  const root = useRef(null), close = onClose || closeDialog;
  useEffect(() => {
    let cards, last = "";
    cards = mountStructuredSignIns(root.current, { endpoint: "/ui/browser-backend-signins", changed: next => {
      if (!next.selected.includes(backend)) void cards.addBackend(backend);
      const signature = JSON.stringify([next.login, next.pending]);
      if (signature !== last) { last = signature; void refreshSignIn(); }
    } });
    return () => cards.dispose();
  }, [backend]);
  const fallback = async () => {
    const result = await post("/ui/browser-backend-signins", { operation: "cancel" });
    if (!result.ok) { toast(tn("failed")); return; }
    showDialog(SignInDialog, { backend });
  };
  return html`<${Dialog} title=${tn("title", backend)} onClose=${close}>
    <div ref=${root}></div>
    <div class="s-actions"><button type="button" class="btn" onClick=${fallback}>${tn("consoleFallback")}</button>
    <button type="button" class="btn" onClick=${close}>${tn("close")}</button></div>
  </${Dialog}>`;
}

export function SignInDialog({ backend, profile, resume = false, onClose }) {
  const s = useStore(signInStore);
  const [step, setStep] = useState(resume ? { kind: "login" } : { kind: "checking" });
  const [busy, setBusy] = useState(false);
  const shown = shownOf(backend, profile);
  const close = onClose || closeDialog;
  useEffect(() => {
    if (resume) return undefined;
    let gone = false;
    post("/ui/backend-login/check", { backend, ...(profile ? { profile } : {}) }).then((r) => {
      if (gone) return;
      if (r.body && r.body.confirm) setStep({ kind: "confirm", confirm: r.body.confirm });
      else setStep({ kind: "message", text: (r.body && (r.body.message || (r.body.error && errorText(r.body.error)))) || tn("failed") });
    });
    return () => { gone = true; };
  }, []);
  const login = s.login;
  const live = step.kind === "login" && login && login.phase === "running";
  // While a running sign-in is on screen, read it every 2 s too (a page without the stream still sees it move).
  useEffect(() => {
    if (!live) return undefined;
    const h = setInterval(() => { void refreshSignIn(); }, 2000);
    return () => clearInterval(h);
  }, [live]);
  const start = async (tunnel) => {
    setBusy(true); setStep({ kind: "starting" });
    const r = await post("/ui/backend-login/start", { confirm: step.confirm.id, ...(tunnel ? { tunnel: true } : {}) });
    setBusy(false);
    if (r.body && r.body.login) { signInStore.set({ login: r.body.login }); setStep({ kind: "login" }); return; }
    setStep({ kind: "message", text: (r.body && (r.body.message || (r.body.error && errorText(r.body.error)))) || tn("failed") });
  };
  const cancelRun = async () => {
    setBusy(true);
    const r = await post("/ui/backend-login/cancel", {});
    setBusy(false);
    toast((r.body && r.body.message) || tn("cancelled"));
    void refreshSignIn();
  };
  let body, actions;
  if (step.kind === "checking" || step.kind === "starting") {
    body = html`<p role="status">${step.kind === "checking" ? tn("checking", shown) : tn("starting")}</p>`;
    actions = html`<button type="button" class="btn" disabled=${busy} onClick=${close}>${tn("cancel")}</button>`;
  } else if (step.kind === "confirm") {
    const c = step.confirm;
    body = html`<p>${c.deviceAuth ? tn("confirmDevice", shown) : tn("confirmTerminal", shown)}</p>
      ${c.tokenPresent ? html`<p>${tn("stillSignedIn")}</p>` : null}
      ${c.logoutFirst ? html`<p>${tn("logoutFirst", c.logoutFirst)}</p>` : null}
      ${c.publicLink ? html`<p class="signin-note">${tn("publicNote")}</p>` : null}`;
    actions = html`<button type="button" class="btn" onClick=${close}>${tn("cancel")}</button>
      ${c.publicLink ? html`<button type="button" class="btn" onClick=${() => start(true)}>${tn("goPublic")}</button>` : null}
      <button type="button" class="btn btn-primary" onClick=${() => start(false)}>${tn("go")}</button>`;
  } else if (step.kind === "message") {
    body = html`<p class="signin-message">${step.text}</p>`;
    actions = html`<button type="button" class="btn btn-primary" onClick=${close}>${tn("close")}</button>`;
  } else if (!login) {
    body = html`<p class="signin-note">${tn("ended")}</p>`;
    actions = html`<button type="button" class="btn btn-primary" onClick=${close}>${tn("close")}</button>`;
  } else if (!login.mine) {
    body = html`<p>${login.phase === "running" ? tn("running", shownOf(login.backend, login.profile), login.startedOn) : tn("ended")}</p>`;
    actions = html`<button type="button" class="btn" onClick=${close}>${tn("close")}</button>
      ${login.phase === "running" ? html`<button type="button" class="btn btn-danger" disabled=${busy} onClick=${cancelRun}>${tn("cancelSignIn")}</button>` : null}`;
  } else {
    const lines = Array.isArray(login.lines) ? login.lines : [];
    body = html`${login.phase === "running" ? html`<${Running} login=${login} />`
        : html`<p role="status" class=${login.ok ? "signin-ok" : "signin-message"}>${login.ok ? tn("signedIn", shownOf(login.backend, login.profile)) : tn("ended")}</p>`}
      ${lines.length ? html`<ul class="signin-lines">${lines.map((l, i) => html`<li key=${i}>${l}</li>`)}</ul>` : null}`;
    actions = html`<button type="button" class="btn" onClick=${close}>${tn("close")}</button>
      ${login.phase === "running" ? html`<button type="button" class="btn btn-danger" disabled=${busy} onClick=${cancelRun}>${tn("cancelSignIn")}</button>` : null}`;
  }
  return html`<${Dialog} title=${tn("title", shown)} onClose=${close} busy=${busy} actions=${actions}>${body}</${Dialog}>`;
}

/** The line every admin page shows while a sign-in runs (the shell's banner slot). */
export function SignInLine() {
  const { login, structured } = useStore(signInStore);
  const active = structured?.login;
  if ((!login || login.phase !== "running") && active && active.phase !== "done" && !(active.phase === "failed" && active.reason)) {
    return html`<div data-trust="status" class="conn op-line signin-line" role="status"><span>${tn("browserRunning", active.backend)}</span>
      <button type="button" class="btn btn-sm" onClick=${() => openSignIn({ backend: active.backend })}>${tn("open")}</button></div>`;
  }
  if (!login || login.phase !== "running") return null;
  return html`<div data-trust="status" class="conn op-line signin-line" role="status">
    <span>${tn("running", shownOf(login.backend, login.profile), login.startedOn)}</span>
    <button type="button" class="btn btn-sm" onClick=${() => openRunning(login)}>${tn("open")}</button></div>`;
}

const STATE_KEY = { usable: "stUsable", not_signed_in: "stNotSignedIn", not_installed: "stNotInstalled", too_old: "stTooOld", unknown: "stUnknown" };

/** Settings → Agents: each login on this machine, with Sign in where the dashboard can do it. */
export function SignInList() {
  const { targets, loaded, login, structured } = useStore(signInStore);
  // Not over the temporary public link: only the dashboard reached directly signs a backend in, and the link does not
  // serve this read (it was a 404 in the console there, found by smoke-1939-authorize-defaults).
  const offered = signInOffered();
  useEffect(() => { if (offered) void refreshSignIn(); }, []);
  if (!offered || !loaded || !targets.length) return null;
  const active = structured?.login;
  const running = (login && login.phase === "running") || (active && active.phase !== "done" && !(active.phase === "failed" && active.reason));
  return html`<section class="s-group signin-list" aria-label=${tn("listTitle")}>
    <div class="list-head"><span>${tn("listTitle")}</span></div>
    <p class="sub">${tn("listHint")}</p>
    ${targets.map((x) => html`<div key=${`${x.backend}:${x.profile || ""}`} class="s-row">
      <span class="s-name">${shownOf(x.backend, x.profile)}</span>
      <span class="tag">${tn(STATE_KEY[x.state] || "stUnknown")}</span>
      <span class="s-br" aria-hidden="true"></span>
      ${x.install ? html`<span class="s-meta"><code>${tn("install", x.install)}</code></span>` : null}
      ${x.update ? html`<span class="s-meta"><code>${tn("update", x.update)}</code></span>` : null}
      ${x.hostCommand ? html`<span class="s-meta"><code>${tn("onHost", x.hostCommand)}</code></span>` : null}
      <span class="s-actions">${x.signIn ? html`<button type="button" class=${x.state === "not_signed_in" ? "btn btn-sm btn-primary" : "btn btn-sm"} disabled=${!!running}
        onClick=${() => openSignIn(x)}>${x.state === "usable" ? tn("signInAgain") : tn("signIn")}</button>` : null}</span>
    </div>`)}
  </section>`;
}
