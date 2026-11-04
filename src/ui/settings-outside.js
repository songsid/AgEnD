// #3008 ② (alpha.3; decision 28c2d3a3 rule 3, the user's simplified form hmsg-33c3d609): Settings → Access & security →
// "Connections from outside", on a fleet with no chat connection. This computer's admin, here, sets up an authenticator
// app (a QR code and the key, then its first code), and turns on "Allow connections from outside": the public link
// opens, and signing in through it asks for the app's code. Turning it off closes the link and signs everyone out there.
// Every change applies at once (an action, not a staged setting) and is this computer's only: elsewhere the card shows
// the state, read-only. The server decides who may (GET /ui/outside's `here`) and refuses everything else regardless.
// The words are the leader's (cid-alpha3-design, strings 1–13 and 17).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { api } from "./settings-confirm.js";

register("outside", {
  en: {
    title: "Connections from outside", switch: "Allow connections from outside",
    needApp: "Set up an authenticator app first. Signing in from outside will ask for its code.",
    setUp: "Set up authenticator app",
    scan: "Scan this with Authy, Google Authenticator or Microsoft Authenticator, or type the key. Then enter the 6-digit code it shows.",
    setUpOn: "Authenticator app set up on {0}.", again: "Set up again",
    againConfirm: "Codes from the old app stop working, and everyone signed in from outside is signed out.",
    remove: "Remove", removeConfirm: "Connections from outside are turned off, and everyone signed in from outside is signed out.",
    openAt: "Open at {0}.", quick: "A quick link gets a new address each time it opens.",
    hereOnly: "Only on the AgEnD computer.", lostPhone: "Lost your phone? On the AgEnD computer, choose “Set up again”.",
    wrong: "That code didn't work. Check that your phone's clock is right and try the newest code.",
    paused: "Too many wrong codes. Try again in {0}.", code: "Authenticator code", key: "Key",
    minutes: "{0} minutes", minute: "1 minute", hours: "{0} hours", hour: "1 hour",
  },
  "zh-TW": {
    title: "從外面連線", switch: "允許從外面連線",
    needApp: "請先設定驗證器 App。從外面登入時會要求輸入它的代碼。",
    setUp: "設定驗證器 App",
    scan: "用 Authy、Google Authenticator 或 Microsoft Authenticator 掃描，或手動輸入金鑰，再輸入 App 顯示的 6 位數代碼。",
    setUpOn: "驗證器 App 已於 {0} 設定。", again: "重新設定",
    againConfirm: "舊 App 的代碼會失效，所有從外面登入的人都會被登出。",
    remove: "移除", removeConfirm: "從外面連線會關閉，所有從外面登入的人都會被登出。",
    openAt: "已開啟：{0}。", quick: "快速連結每次開啟網址都不同。",
    hereOnly: "只能在 AgEnD 電腦上變更。", lostPhone: "手機遺失？請在 AgEnD 電腦上選「重新設定」。",
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
  const [s, setS] = useState(null), [enroll, setEnroll] = useState(null), [code, setCode] = useState(""), [msg, setMsg] = useState(""), [busy, setBusy] = useState(false);
  // Fences: an answer that arrives after the card is gone, or after a newer read began, is dropped; nor does a read
  // land while an action is under way (the box shows the click until the action's own read).
  const live = useRef({ mounted: true, seq: 0, busy: false });
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
  if (!s || !s.webOnly) return null;
  const here = s.here === true;
  const act = async (fn) => {
    setBusy(true); setMsg(""); live.current.busy = true; live.current.seq++;      // a read under way is outdated now
    try { await fn(); } finally { live.current.busy = false; if (live.current.mounted) { setBusy(false); load(); } }
  };
  const begin = () => act(async () => {
    const r = await api("/ui/outside/enroll", { method: "POST", body: "{}" });
    if (r.ok && r.body && r.body.secret) { setEnroll(r.body); setCode(""); } else toast(t("app.failed"), false);
  });
  const confirm = () => act(async () => {
    const r = await api("/ui/outside/enroll/confirm", { method: "POST", body: JSON.stringify({ code }) });
    if (r.ok) { setEnroll(null); setCode(""); return; }
    const why = r.body && r.body.error;
    if (why === "expired") { setEnroll(null); return; }
    setMsg(why === "wrong" ? to("wrong") : t("app.failed"));
  });
  const again = async () => {
    if (!(await confirmDialog({ title: to("again"), message: to("againConfirm"), confirmLabel: to("again"), danger: true }))) return;
    begin();
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: to("remove"), message: to("removeConfirm"), confirmLabel: to("remove"), danger: true }))) return;
    act(async () => { const r = await api("/ui/outside/remove", { method: "POST", body: "{}" }); if (!r.ok) toast(t("app.failed"), false); });
  };
  // The box follows the click at once (smoke-web-outside-3008: a controlled box that waits for the server reads as a
  // click that did nothing); the server's state, read again after, is what stays.
  const flip = (on) => { setS((x) => ({ ...x, outside: on })); act(async () => {
    const r = await api("/ui/outside/switch", { method: "POST", body: JSON.stringify({ on }) });
    if (!r.ok) toast(t("app.failed"), false);
  }); };
  const link = s.link, open = link && link.state === "open";
  return html`<section class="card s-outside" id="outsideCard"><h3>${to("title")}</h3>
    ${!here ? html`<p class="note" id="outHereOnly">${to("hereOnly")}</p>` : null}
    <label class="check"><input id="outSwitch" type="checkbox" checked=${s.outside} disabled=${!here || busy || (!s.enrolled && !s.outside)}
      onChange=${(e) => flip(e.target.checked)} /><span>${to("switch")}</span></label>
    ${!s.enrolled ? html`<p class="note" id="outNeedApp">${to("needApp")}</p>` : null}
    ${s.outside && open && link.url ? html`<p class="note" id="outOpenAt">${to("openAt", link.url)}${link.quick ? ` ${to("quick")}` : ""}</p>` : null}
    ${s.outside && link && !open ? html`<p class="note" id="outStarting">${t("app.loading")}</p>` : null}
    ${s.pausedForMs > 0 ? html`<p class="note s-va-warn" role="status" id="outPaused">${to("paused", waitWords(s.pausedForMs))}</p>` : null}
    ${enroll ? html`<div class="s-out-enroll" id="outEnroll">
        <p class="note">${to("scan")}</p>
        <${Qr} uri=${enroll.uri} />
        <p class="note">${to("key")}: <code id="outKey">${keyGroups(enroll.secret)}</code></p>
        <div class="field"><label for="outCode">${to("code")}</label>
          <input id="outCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" value=${code}
            onInput=${(e) => setCode(e.target.value)} /></div>
        ${msg ? html`<p class="feedback error" role="alert" id="outMsg">${msg}</p>` : null}
        <div class="save-row"><button type="button" class="btn" id="outCancel" disabled=${busy} onClick=${() => { setEnroll(null); setMsg(""); }}>${t("app.cancel")}</button>
          <button type="button" class="btn btn-primary" id="outConfirm" disabled=${busy || !/^\s*\d{3}\s?\d{3}\s*$/.test(code)} onClick=${confirm}>${t("app.confirmOk")}</button></div>
      </div>`
      : s.enrolled ? html`<p class="note" id="outSetUpOn">${to("setUpOn", new Date(s.enrolledAt).toLocaleDateString())}</p>
        <p class="note">${to("lostPhone")}</p>
        ${here ? html`<div class="save-row"><button type="button" class="btn" id="outAgain" disabled=${busy} onClick=${again}>${to("again")}</button>
          <button type="button" class="btn btn-danger" id="outRemove" disabled=${busy} onClick=${remove}>${to("remove")}</button></div>` : null}`
      : here ? html`<div class="save-row"><button type="button" class="btn btn-primary" id="outSetUp" disabled=${busy} onClick=${begin}>${to("setUp")}</button></div>` : null}
  </section>`;
}
