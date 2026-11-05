// #3008 ② (alpha.3; decision 28c2d3a3 rule 3, the user's simplified form hmsg-33c3d609): Settings → Access & security →
// "Connections from outside", on a fleet with no chat connection. This computer's admin, here, sets up an authenticator
// app (a QR code and the key, then its first code), and turns on "Allow connections from outside": the public link
// opens, and signing in through it asks for the app's code. Turning it off closes the link and signs everyone out there.
// Every change applies at once (an action, not a staged setting) and is this computer's only: elsewhere the card shows
// the state, read-only. The server decides who may (GET /ui/outside's `here`) and refuses everything else regardless.
// The words are the leader's (cid-alpha3-design, strings 1–13 and 17).
// Refs #3061: "Set up authenticator app" / "Set up again" open the reference page's dialog (the app's own Dialog: the
// browser traps focus and closes it on Esc; focus goes back to the button that opened it) — the QR code and the key (step 1),
// the code field (step 2), Cancel and "Verify and turn on". A wrong code is answered inside the dialog.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { Dialog } from "/assets/ui-dialog.js";
import { api } from "./settings-confirm.js";

register("outside", {
  en: {
    title: "Owner verification", lead: "Use your authenticator app's 6-digit code to prove, from outside, that you own this fleet.",
    stateOn: "Authenticator set up", stateOff: "Not set up", switch: "Allow connections from outside",
    needApp: "Set up an authenticator app first. Signing in from outside will ask for its code.",
    setUp: "Set up authenticator app",
    scan: "Scan this with Authy, Google Authenticator or Microsoft Authenticator, or type the key. Then enter the 6-digit code it shows.",
    setUpOn: "Authenticator app set up on {0}.", again: "Set up again",
    againConfirm: "Codes from the old app stop working, and everyone signed in from outside is signed out.",
    remove: "Remove", removeConfirm: "Connections from outside are turned off, and everyone signed in from outside is signed out.",
    openAt: "Open at {0}.", quick: "A quick link gets a new address each time it opens.",
    hereOnly: "Only on the AgEnD computer. Go back to that computer to set up, set up again or remove the app.",
    lostPhone: "Lost your phone? On the AgEnD computer, choose “Set up again”. There is no email or backup-code recovery.",
    noRecovery: "If you lose the authenticator, set it up again on the AgEnD computer. There is no email or backup-code recovery.",
    appsLabel: "Works with these authenticator apps", appOther: "Other TOTP authenticators",
    step1: "1. Add AgEnD to your authenticator", step2: "2. Enter the authenticator code to finish",
    activate: "Verify and turn on", removeTitle: "Remove the authenticator app?",
    wrong: "That code didn't work. Check that your phone's clock is right and try the newest code.",
    paused: "Too many wrong codes. Try again in {0}.", code: "Authenticator code", key: "Key",
    minutes: "{0} minutes", minute: "1 minute", hours: "{0} hours", hour: "1 hour",
  },
  "zh-TW": {
    title: "擁有者驗證", lead: "使用驗證器 App 的 6 位數代碼，從外面證明你是這個 fleet 的擁有者。",
    stateOn: "驗證器已設定", stateOff: "尚未設定", switch: "允許從外面連線",
    needApp: "請先設定驗證器 App。從外面登入時會要求輸入它的代碼。",
    setUp: "設定驗證器",
    scan: "用 Authy、Google Authenticator 或 Microsoft Authenticator 掃描，或手動輸入金鑰，再輸入 App 顯示的 6 位數代碼。",
    setUpOn: "驗證器 App 已於 {0} 設定。", again: "重新綁定驗證器",
    againConfirm: "舊 App 的代碼會失效，所有從外面登入的人都會被登出。",
    remove: "停用", removeConfirm: "從外面連線會關閉，所有從外面登入的人都會被登出。",
    openAt: "已開啟：{0}。", quick: "快速連結每次開啟網址都不同。",
    hereOnly: "只能在 AgEnD 電腦上變更。設定、重新綁定或停用驗證器，請回到那台電腦操作。",
    lostPhone: "手機遺失？請在 AgEnD 電腦上選「重新綁定驗證器」。沒有電子郵件或備援碼復原。",
    noRecovery: "遺失驗證器時，請回 AgEnD 主機重新綁定。沒有電子郵件或備援碼復原。",
    appsLabel: "可使用的驗證器 App", appOther: "其他 TOTP 驗證器",
    step1: "1. 在驗證器中新增 AgEnD", step2: "2. 輸入驗證器代碼以完成綁定",
    activate: "驗證並啟用", removeTitle: "停用驗證器？",
    wrong: "代碼不對。請確認手機時間正確，並輸入最新的代碼。",
    paused: "錯誤次數太多，請 {0} 後再試。", code: "驗證器代碼", key: "金鑰",
    minutes: "{0} 分鐘", minute: "1 分鐘", hours: "{0} 小時", hour: "1 小時",
  },
});
const to = (k, ...v) => t(`outside.${k}`, ...v);

/** A wait as words: "15 minutes" / 「15 分鐘」, "2 hours" / 「2 小時」 (rounded up). */
export function waitWords(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return minutes === 1 ? to("minute") : to("minutes", minutes);
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? to("hour") : to("hours", hours);
}

/** The key as an app shows it: groups of four. */
export function keyGroups(secret) {
  return String(secret || "").replace(/(.{4})(?=.)/g, "$1 ");
}

/**
 * The QR code of an otpauth:// URI as one SVG path (dark modules), drawn by the page — no inline style, no innerHTML
 * (the CSP). `qrcode` is the vendored encoder's factory (qrcode.module.js).
 */
export function qrPath(qrcode, uri) {
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  return { size: n + 8, d };
}

function Qr({ uri }) {
  const [shape, setShape] = useState(null);
  useEffect(() => {
    let live = true;
    import("/assets/qrcode.module.js").then((m) => { if (live) setShape(qrPath(m.default || m.qrcode, uri)); }).catch(() => { if (live) setShape(null); });
    return () => { live = false; };
  }, [uri]);
  if (!shape) return null;
  return html`<svg class="s-out-qr" id="outQr" viewBox=${`0 0 ${shape.size} ${shape.size}`} width="200" height="200" role="img" aria-label=${to("setUp")}>
    <rect width=${shape.size} height=${shape.size} fill="#fff" /><path d=${shape.d} fill="#000" /></svg>`;
}

/**
 * #3035 review: how often the card reads the state again while it is shown — quickly while the link is opening (the
 * switch answers before the link is up), slowly otherwise (its lifetime ending, a wait starting or ending elsewhere).
 */
export const outsidePoll = { quickMs: 2000, slowMs: 15000 };

export function OutsideCard() {
  // `dlg`: the set-up dialog while it is open — { kind: "setup" | "again", enroll: null (asking the server) | { secret, uri } }.
  const [s, setS] = useState(null), [dlg, setDlg] = useState(null), [code, setCode] = useState(""), [msg, setMsg] = useState(""), [busy, setBusy] = useState(false);
  // Fences: an answer that arrives after the card is gone, or after a newer read began, is dropped; nor does a read
  // land while an action is under way (the box shows the click until the action's own read). `dlg`: the same for the
  // dialog's enrolment (closed meanwhile: its answer is dropped); `refocus`: the dialog just closed, focus goes back.
  const live = useRef({ mounted: true, seq: 0, busy: false, dlg: 0, dlgOpen: false, refocus: false }), card = useRef(null);
  // Every read that ends (answered or not) moves `rev`: the next one is scheduled from there, so a failed read (the
  // network, a 5xx, an unreadable answer) never stops the card reading again (#3035 review r2) — and keeps what it
  // showed meanwhile.
  const [rev, setRev] = useState(0), failed = useRef(false);
  const load = async () => {
    const seq = ++live.current.seq;
    let r = null;
    try { r = await api("/ui/outside"); } catch { r = null; }
    if (!live.current.mounted || seq !== live.current.seq) return;
    const ok = !!(r && r.ok && r.body && typeof r.body === "object");
    failed.current = !ok;
    if (ok) setS(r.body);
    setRev((n) => n + 1);
  };
  useEffect(() => { live.current.mounted = true; load(); return () => { live.current.mounted = false; }; }, []);
  useEffect(() => {
    if (rev === 0) return undefined;                                              // the first read is still out
    if (s && !s.webOnly && !failed.current) return undefined;                    // a chat fleet: nothing to follow
    const opening = !!s && s.outside && (!s.link || s.link.state !== "open");
    const delay = !s || opening ? outsidePoll.quickMs : outsidePoll.slowMs;      // none read yet, or opening: soon
    const timer = setTimeout(() => { if (!live.current.busy) load(); else setRev((n) => n + 1); }, delay);
    return () => clearTimeout(timer);
  }, [rev]);
  // The dialog closed (Cancel, Esc, ×, or done): focus goes back to the button that opened it — or to the one that took its
  // place when the set-up finished ("Set up authenticator app" turned into "Set up again"). The Dialog itself returns focus to
  // whatever was focused when it opened; a browser that does not focus a button on click leaves that as the page, so the card says it.
  useEffect(() => {
    if (dlg || busy || !live.current.refocus) return;
    live.current.refocus = false;
    const el = card.current && card.current.querySelector(s && s.enrolled ? "#outAgain" : "#outSetUp");
    if (el && !el.disabled && typeof el.focus === "function") el.focus();
  }, [dlg, busy]);
  if (!s || !s.webOnly) return null;
  const here = s.here === true;
  const act = async (fn) => {
    setBusy(true); setMsg(""); live.current.busy = true; live.current.seq++;      // a read under way is outdated now
    try { await fn(); } finally { live.current.busy = false; if (live.current.mounted) { setBusy(false); load(); } }
  };
  // Open the dialog at once (the button that opened it still has focus) and ask the server for the secret meanwhile; if it
  // will not give one, the dialog closes with the page's usual "failed". Nothing is changed until the right code is confirmed.
  const begin = async (kind) => {
    if (!here || live.current.dlgOpen) return;                                    // not here, or one is open already
    const id = ++live.current.dlg;
    live.current.dlgOpen = true;
    setDlg({ kind, enroll: null }); setCode(""); setMsg("");
    let r = null;
    try { r = await api("/ui/outside/enroll", { method: "POST", body: "{}" }); } catch { r = null; }
    if (!live.current.mounted || id !== live.current.dlg) return;                 // closed (or gone) while it was asked
    if (r && r.ok && r.body && r.body.secret) setDlg({ kind, enroll: r.body });
    else { closeDlg(); toast(t("app.failed"), false); }
  };
  function closeDlg() {
    live.current.dlg++;                                                           // a late answer to the enrolment is dropped
    live.current.dlgOpen = false;
    live.current.refocus = true;
    setDlg(null); setCode(""); setMsg("");
  }
  const confirm = () => act(async () => {
    let r;
    try { r = await api("/ui/outside/enroll/confirm", { method: "POST", body: JSON.stringify({ code }) }); } catch { r = null; }
    if (r && r.ok) { await load(); closeDlg(); return; }                          // read first: the card behind is the new state when it closes
    const why = r && r.body && r.body.error;
    if (why === "expired") { closeDlg(); return; }
    setMsg(why === "wrong" ? to("wrong") : t("app.failed"));
  });
  const canConfirm = !!(dlg && dlg.enroll) && /^\s*\d{3}\s?\d{3}\s*$/.test(code);
  const remove = async () => {
    if (!(await confirmDialog({ title: to("removeTitle"), message: to("removeConfirm"), confirmLabel: to("remove"), danger: true }))) return;
    act(async () => { const r = await api("/ui/outside/remove", { method: "POST", body: "{}" }); if (!r.ok) toast(t("app.failed"), false); });
  };
  // The box follows the click at once (smoke-web-outside-3008: a controlled box that waits for the server reads as a
  // click that did nothing); the server's state, read again after, is what stays.
  const flip = (on) => { setS((x) => ({ ...x, outside: on })); act(async () => {
    const r = await api("/ui/outside/switch", { method: "POST", body: JSON.stringify({ on }) });
    if (!r.ok) toast(t("app.failed"), false);
  }); };
  const link = s.link, open = link && link.state === "open";
  return html`<section class="card s-outside" id="outsideCard" ref=${card}><header class="s-auth-section-head"><div><h3>${to("title")}</h3><p id="outLead">${to("lead")}</p></div><span class=${`s-auth-state${s.enrolled ? " is-usable" : ""}`} id="outState">${to(s.enrolled ? "stateOn" : "stateOff")}</span></header>
    <div class="chips s-out-apps" id="outApps" role="list" aria-label=${to("appsLabel")}><span class="tag" role="listitem">Google Authenticator</span><span class="tag" role="listitem">Microsoft Authenticator</span><span class="tag" role="listitem">${to("appOther")}</span></div>
    ${!here ? html`<p class="note" id="outHereOnly">${to("hereOnly")}</p>` : null}
    <label class="check"><input id="outSwitch" type="checkbox" checked=${s.outside} disabled=${!here || busy || (!s.enrolled && !s.outside)}
      onChange=${(e) => flip(e.target.checked)} /><span>${to("switch")}</span></label>
    ${!s.enrolled ? html`<p class="note" id="outNeedApp">${to("needApp")}</p>` : null}
    ${s.outside && open && link.url ? html`<p class="note" id="outOpenAt">${to("openAt", link.url)}${link.quick ? ` ${to("quick")}` : ""}</p>` : null}
    ${s.outside && link && !open ? html`<p class="note" id="outStarting">${t("app.loading")}</p>` : null}
    ${s.pausedForMs > 0 ? html`<p class="note s-va-warn" role="status" id="outPaused">${to("paused", waitWords(s.pausedForMs))}</p>` : null}
    ${s.enrolled ? html`<p class="note" id="outSetUpOn">${to("setUpOn", new Date(s.enrolledAt).toLocaleDateString())}</p>
        <p class="note">${to("lostPhone")}</p>
        ${here ? html`<div class="save-row"><button type="button" class="btn" id="outAgain" disabled=${busy} onClick=${() => begin("again")}>${to("again")}</button>
          <button type="button" class="btn btn-danger" id="outRemove" disabled=${busy} onClick=${remove}>${to("remove")}</button></div>` : null}`
      : html`<p class="note" id="outNoRecovery">${to("noRecovery")}</p>${here ? html`<div class="save-row"><button type="button" class="btn btn-primary" id="outSetUp" disabled=${busy} onClick=${() => begin("setup")}>${to("setUp")}</button></div>` : null}`}
    ${dlg ? html`<${Dialog} title=${to(dlg.kind === "again" ? "again" : "setUp")} onClose=${closeDlg} busy=${busy} actions=${html`
        <button type="button" class="btn" id="outCancel" disabled=${busy} onClick=${closeDlg}>${t("app.cancel")}</button>
        <button type="button" class="btn btn-primary" id="outConfirm" disabled=${busy || !canConfirm} onClick=${confirm}>${to("activate")}</button>`}>
      <div class="s-out-enroll" id="outEnroll">${dlg.enroll ? html`
        <p class="s-out-step" id="outStep1"><strong>${to("step1")}</strong></p>
        <p class="note">${to("scan")}</p>
        <${Qr} uri=${dlg.enroll.uri} />
        <p class="note">${to("key")}: <code id="outKey">${keyGroups(dlg.enroll.secret)}</code></p>
        <p class="s-out-step" id="outStep2"><strong>${to("step2")}</strong></p>
        <div class="field"><label for="outCode">${to("code")}</label>
          <input id="outCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" value=${code}
            onInput=${(e) => setCode(e.target.value)}
            onKeyDown=${(e) => { if (e.key === "Enter" && canConfirm && !busy) { e.preventDefault(); confirm(); } }} /></div>
        ${dlg.kind === "again" ? html`<p class="note" id="outAgainNote">${to("againConfirm")}</p>` : null}
        <p class="note" id="outEnrollNoRecovery">${to("noRecovery")}</p>
        ${msg ? html`<p class="feedback error" role="alert" id="outMsg">${msg}</p>` : null}`
        : html`<p class="note" id="outEnrollLoading">${t("app.loading")}</p>`}</div>
    </${Dialog}>` : null}
  </section>`;
}
