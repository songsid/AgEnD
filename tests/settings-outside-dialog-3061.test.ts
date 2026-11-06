/**
 * Refs #3061: setting up (and setting up again) the authenticator is a dialog, as on the reference page — not a block that
 * opens inside the card (src/ui/settings-outside.js, on the app's own Dialog: the native <dialog>, showModal()):
 *  - the title says which (Set up authenticator app / Set up again), then step 1 (the QR code, the key), step 2 (the code
 *    field), the no-recovery line, Cancel and "Verify and turn on"; "Set up again" says what it does to the old app;
 *  - Cancel, Esc and the × close it, change nothing (no confirm request) and give focus back to the button that opened it —
 *    even in a browser that did not focus that button on the click;
 *  - a wrong code is answered inside the dialog and it stays open; a right one closes it and focus lands on the button that
 *    replaced the one that opened it ("Set up again");
 *  - Enter in the code field verifies (once the code is 6 digits); nothing closes it while the code is being checked;
 *  - no second question before "Set up again" opens it; an enrolment the server answers after the dialog closed, or will
 *    not give at all, opens nothing;
 *  - both languages. Only on this computer: from elsewhere there is no button, so no dialog (settings-outside-3008).
 * Review of #3165 (P2 2), the last describe: closing and opening the dialog again while a request for a secret is still out must not
 * leave the screen showing a secret the server no longer holds. The server here is the REAL pending-secret store
 * (WebRemoteAccess), and a request can be held on its way to it, so the order the requests REACH it in is the test's to choose.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { WebRemoteAccess, base32Decode, hotp, totpStep } from "../src/web-remote-access.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const schema = buildSettingsImpactSchema();
let p: AppPage, status: any;
let sent: Array<{ method: string; path: string; body: any }> = [];
let answers: Record<string, { status: number; body: any }> = {};
let holds: Record<string, Promise<void>> = {};
/** One hold per request, in the order they are made (a request that finds none runs at once) — unlike `holds`, which stops every request of its kind. */
let holdEach: Record<string, Array<Promise<void>>> = {};
/** When set, the enrolment routes are answered by this real store (as the fleet does for this computer's admin) instead of by fixed answers. */
let store: WebRemoteAccess | null = null;
const OWNER = "owner-session-handle";
const realFetch = (globalThis as any).fetch;
const ENROLL = { secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", uri: "otpauth://totp/AgEnD%3Apc?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=AgEnD&algorithm=SHA1&digits=6&period=30", expiresInMs: 600000 };
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  const queued = holdEach[`${method} ${path}`];
  if (queued && queued.length) await queued.shift();                 // on its way to the server: the server has not seen it yet
  const hold = holds[`${method} ${path}`];
  if (hold) await hold;
  if (store && method === "POST" && path === "/ui/outside/enroll") { const r = store.beginEnrollment(OWNER, "pc"); return { ok: true, status: 200, json: async () => r }; }
  if (store && method === "POST" && path === "/ui/outside/enroll/confirm") {
    const r = store.confirmEnrollment(OWNER, JSON.parse(init.body ?? "{}").code);
    return { ok: r === "ok", status: r === "ok" ? 200 : 400, json: async () => (r === "ok" ? { ok: true } : { error: r }) };
  }
  const preset = answers[`${method} ${path}`];
  if (preset) return { ok: preset.status < 300, status: preset.status, json: async () => preset.body };
  const body = (() => {
    if (method === "POST" && path === "/ui/outside/enroll") return ENROLL;
    if (method !== "GET") return { ok: true };
    if (path === "/ui/outside") return status;
    if (path === "/api/settings/web-authority") return { state: { enabled: true, loopbackOnly: false, epoch: 1 }, configured: {}, hours: { min: 1, max: 48, default: 48 }, lanHosts: [], authorized: [], webOnly: true };
    if (path === "/api/settings/guests") return { enabled: false, chat: true, instances: [], connections: [], guests: [] };
    if (path === "/api/settings/schema") return schema;
    if (path === "/api/settings/fleet/raw") return { defaults: { locale: "en" }, instances: {}, web: {} };
    if (path === "/api/settings/classic") return { channels: {}, defaults: {} };
    if (path === "/api/settings/connections") return [];
    if (path === "/api/fleet") return { version: "2.3.5", instances: [] };
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};
beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/settings/access" }); (globalThis as any).fetch = fakeFetch; });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => { sent = []; answers = {}; holds = {}; holdEach = {}; store = null; });
afterEach(async () => { await p.unmount(); });

const base = { webOnly: true, here: true, enrolled: false, enrolledAt: null, outside: false, pausedForMs: 0, link: null };
const ENROLLED = { ...base, enrolled: true, enrolledAt: Date.UTC(2026, 10, 4) };
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
async function open(over: Record<string, unknown> = {}) {
  status = { ...base, ...over };
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.unmount();
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "access" }, navKey: "settings:access" }));
  await settle(14);
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const active = () => (p.window.document as any).activeElement;
  /** A click as a browser does it: the button takes focus (unless `focus` is false — Safari's buttons), then the click. */
  const click = async (el: any, focus = true) => { if (focus) el.focus(); fire(el, "click"); await settle(8); };
  const type = async (el: any, v: string) => { el.value = v; fire(el, "input"); await settle(); };
  const posts = () => sent.filter(s => s.method === "POST" && s.path.startsWith("/ui/outside")).map(s => [s.path, s.body]);
  const dialog = () => $("dialog");
  const esc = async () => { fire(dialog(), "cancel"); await settle(6); };
  return { $, click, type, posts, active, dialog, esc };
}

describe("Refs #3061: the authenticator set-up is a dialog", () => {
  it("Set up authenticator app opens a dialog — title, step 1 (QR, key), step 2 (code), no-recovery line, Cancel and Verify and turn on — not a block in the card", async () => {
    const w = await open();
    expect(w.dialog()).toBeNull();
    await w.click(w.$("#outSetUp"));
    for (let n = 0; n < 40 && !w.$("#outQr"); n++) await settle(4);
    const d = w.dialog();
    expect(d).not.toBeNull();
    expect([d.open, text(d.querySelector(".dlg-title"))]).toEqual([true, "Set up authenticator app"]);
    // Everything of the set-up is in the dialog, none in the card.
    expect($all(d, "#outEnroll")).toBe(1);
    expect(inCardOnly(w.$("#outsideCard"), "#outEnroll")).toBe(0);
    expect([text(d.querySelector("#outStep1")), text(d.querySelector("#outStep2"))]).toEqual(["1. Add AgEnD to your authenticator", "2. Enter the authenticator code to finish"]);
    expect(d.querySelector("#outQr")).not.toBeNull();
    expect(d.querySelector("#outQr path").getAttribute("d")).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
    expect(text(d.querySelector("#outKey"))).toBe("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
    expect(d.querySelector("#outCode").getAttribute("inputmode")).toBe("numeric");
    expect(text(d.querySelector("#outEnrollNoRecovery"))).toBe("If you lose the authenticator, set it up again on the AgEnD computer. There is no email or backup-code recovery.");
    expect([text(d.querySelector("#outCancel")), text(d.querySelector("#outConfirm")), d.querySelector("#outConfirm").disabled]).toEqual(["Cancel", "Verify and turn on", true]);
    expect(d.querySelector("#outAgainNote")).toBeNull();                                  // that line is for "Set up again"
    expect(w.posts()).toEqual([["/ui/outside/enroll", {}]]);
  });

  it("Set up again opens the same dialog at once, titled for it, saying what happens to the old app — with no question before it", async () => {
    const { confirmStore } = await import("/assets/ui-confirm.js");
    const savedConfirm = (globalThis as any).confirm;
    (globalThis as any).confirm = undefined;                                              // the harness would answer a question for us; none must be asked
    try {
      const w = await open(ENROLLED);
      await w.click(w.$("#outAgain"));
      expect(confirmStore.get().queue).toEqual([]);                                       // no second dialog first
      const d = w.dialog();
      expect(d).not.toBeNull();
      expect([text(d.querySelector(".dlg-title")), text(d.querySelector("#outAgainNote")), d.querySelector("#outCode") !== null])
        .toEqual(["Set up again", "Codes from the old app stop working, and everyone signed in from outside is signed out.", true]);
      expect(w.posts()).toEqual([["/ui/outside/enroll", {}]]);                            // nothing else: the old app is kept until a right code
    } finally { (globalThis as any).confirm = savedConfirm; }
  });

  it("Cancel closes it, asks nothing more of the server, and focus goes back to the button that opened it", async () => {
    const w = await open();
    await w.click(w.$("#outSetUp"));
    expect(w.dialog()).not.toBeNull();
    await w.click(w.$("#outCancel"));
    expect(w.dialog()).toBeNull();
    expect(w.active()).toBe(w.$("#outSetUp"));
    expect(w.posts()).toEqual([["/ui/outside/enroll", {}]]);                              // no confirm
    expect(w.$("#outState").textContent).toBe("Not set up");
  });

  it("Esc closes it (a second open works and starts empty), focus back on Set up again; the × does the same", async () => {
    const w = await open(ENROLLED);
    await w.click(w.$("#outAgain"));
    await w.type(w.$("#outCode"), "123");
    await w.esc();
    expect(w.dialog()).toBeNull();
    expect(w.active()).toBe(w.$("#outAgain"));
    await w.click(w.$("#outAgain"));
    expect(w.$("#outCode").value).toBe("");                                               // the half-typed code is gone
    fire(w.dialog().querySelector(".dlg-x"), "click"); await settle(6);
    expect(w.dialog()).toBeNull();
    expect(w.active()).toBe(w.$("#outAgain"));
    expect(w.posts().filter(([path]) => path === "/ui/outside/enroll/confirm")).toEqual([]);
  });

  it("a browser that does not focus a button on click (Safari) still gets focus back on the button", async () => {
    const w = await open();
    await w.click(w.$("#outSetUp"), false);
    expect(w.active()).not.toBe(w.$("#outSetUp"));
    await w.esc();
    expect(w.dialog()).toBeNull();
    expect(w.active()).toBe(w.$("#outSetUp"));
  });

  it("a wrong code is answered inside the dialog, which stays open with the code; a right one closes it and focus lands on Set up again", async () => {
    const w = await open();
    await w.click(w.$("#outSetUp"));
    await w.type(w.$("#outCode"), "123456");
    answers["POST /ui/outside/enroll/confirm"] = { status: 400, body: { error: "wrong" } };
    await w.click(w.$("#outConfirm"));
    expect(w.dialog()).not.toBeNull();
    expect(w.dialog().querySelector("#outMsg").textContent).toBe("That code didn't work. Check that your phone's clock is right and try the newest code.");
    expect(w.dialog().querySelector("#outMsg").getAttribute("role")).toBe("alert");
    expect([w.$("#outCode").value, w.$("#outConfirm").disabled, w.$("#outCancel").disabled]).toEqual(["123456", false, false]);
    expect(inCardOnly(w.$("#outsideCard"), "#outMsg")).toBe(0);                          // not in the card behind it
    answers["POST /ui/outside/enroll/confirm"] = { status: 200, body: { ok: true } };
    status = ENROLLED;
    await w.click(w.$("#outConfirm"));
    expect(w.dialog()).toBeNull();
    expect(w.$("#outState").textContent).toBe("Authenticator set up");
    expect(w.active()).toBe(w.$("#outAgain"));
    expect(w.posts()).toEqual([["/ui/outside/enroll", {}], ["/ui/outside/enroll/confirm", { code: "123456" }], ["/ui/outside/enroll/confirm", { code: "123456" }]]);
  });

  it("a right code closes the dialog only once the card behind it shows the new state", async () => {
    let release!: () => void;
    const w = await open();
    await w.click(w.$("#outSetUp"));
    await w.type(w.$("#outCode"), "123456");
    answers["POST /ui/outside/enroll/confirm"] = { status: 200, body: { ok: true } };
    status = ENROLLED;
    holds["GET /ui/outside"] = new Promise<void>(r => { release = r; });
    await w.click(w.$("#outConfirm"));
    expect(w.dialog()).not.toBeNull();                                                    // the state is still being read
    release(); await settle(14);
    expect([w.dialog(), w.$("#outState").textContent, w.$("#outAgain") !== null, w.$("#outSetUp")]).toEqual([null, "Authenticator set up", true, null]);
    expect(w.active()).toBe(w.$("#outAgain"));
  });

  it("any other answer (a pause, the server down) is a line in the dialog too; an enrolment that ran out closes it", async () => {
    const w = await open();
    await w.click(w.$("#outSetUp"));
    await w.type(w.$("#outCode"), "123 456");
    answers["POST /ui/outside/enroll/confirm"] = { status: 503, body: { error: "unsaved" } };
    await w.click(w.$("#outConfirm"));
    expect(w.dialog().querySelector("#outMsg").textContent).toBe("That did not work — try again.");
    answers["POST /ui/outside/enroll/confirm"] = { status: 400, body: { error: "expired" } };
    await w.click(w.$("#outConfirm"));
    expect(w.dialog()).toBeNull();
    expect(w.active()).toBe(w.$("#outSetUp"));
  });

  it("Enter in the code field verifies once there are 6 digits — and not before", async () => {
    const w = await open();
    await w.click(w.$("#outSetUp"));
    await w.type(w.$("#outCode"), "12345");
    fire(w.$("#outCode"), "keydown", { key: "Enter" }); await settle(6);
    expect(w.posts().filter(([path]) => path === "/ui/outside/enroll/confirm")).toEqual([]);
    await w.type(w.$("#outCode"), "123456");
    status = ENROLLED;
    fire(w.$("#outCode"), "keydown", { key: "Enter" }); await settle(10);
    expect(w.posts().filter(([path]) => path === "/ui/outside/enroll/confirm")).toEqual([["/ui/outside/enroll/confirm", { code: "123456" }]]);
    expect(w.dialog()).toBeNull();
  });

  it("while the code is being checked nothing closes it (Esc, ×, Cancel), and the card shows nothing of the old state in between", async () => {
    let release!: () => void;
    holds["POST /ui/outside/enroll/confirm"] = new Promise<void>(r => { release = r; });
    const w = await open();
    await w.click(w.$("#outSetUp"));
    await w.type(w.$("#outCode"), "123456");
    await w.click(w.$("#outConfirm"));
    expect([w.$("#outCancel").disabled, w.$("#outConfirm").disabled]).toEqual([true, true]);
    await w.esc();
    fire(w.dialog().querySelector(".dlg-x"), "click"); await settle(4);
    expect(w.dialog()).not.toBeNull();
    status = ENROLLED;
    release(); await settle(14);
    expect(w.dialog()).toBeNull();
    expect(w.active()).toBe(w.$("#outAgain"));
  });

  it("an enrolment the server answers after the dialog was closed opens nothing; one it refuses opens nothing, with the usual failure", async () => {
    let release!: () => void;
    holds["POST /ui/outside/enroll"] = new Promise<void>(r => { release = r; });
    const w = await open();
    await w.click(w.$("#outSetUp"));
    expect(w.$("#outEnrollLoading")).not.toBeNull();                                      // asking: the dialog is there already
    expect([w.$("#outConfirm").disabled, w.$("#outCancel").disabled]).toEqual([true, false]);
    await w.esc();
    expect(w.dialog()).toBeNull();
    release(); await settle(10);
    expect(w.dialog()).toBeNull();
    // The server will not give a secret: the dialog goes away again.
    delete holds["POST /ui/outside/enroll"];
    answers["POST /ui/outside/enroll"] = { status: 403, body: { error: "outside_not_here" } };
    await w.click(w.$("#outSetUp"));
    expect(w.dialog()).toBeNull();
    expect(w.active()).toBe(w.$("#outSetUp"));
  });

  it("a second click on the button while the dialog is open (a double click) asks the server for one enrolment, not two", async () => {
    const w = await open();
    const btn = w.$("#outSetUp");
    btn.focus(); fire(btn, "click"); fire(btn, "click"); await settle(10);
    expect(w.posts()).toEqual([["/ui/outside/enroll", {}]]);
    expect($all(p.root, "dialog")).toBe(1);
  });

  it("zh-TW: 設定驗證器 / 重新綁定驗證器, the steps, 取消 and 驗證並啟用", async () => {
    const i18n = await import("/assets/app-i18n.js");
    i18n.setLang("zh-TW");
    try {
      const w = await open();
      await w.click(w.$("#outSetUp"));
      let d = w.dialog();
      expect([text(d.querySelector(".dlg-title")), text(d.querySelector("#outStep1")), text(d.querySelector("#outStep2")), text(d.querySelector("#outCancel")), text(d.querySelector("#outConfirm"))])
        .toEqual(["設定驗證器", "1. 在驗證器中新增 AgEnD", "2. 輸入驗證器代碼以完成綁定", "取消", "驗證並啟用"]);
      expect(text(d.querySelector("#outEnrollNoRecovery"))).toBe("遺失驗證器時，請回 AgEnD 主機重新綁定。沒有電子郵件或備援碼復原。");
      await w.type(w.$("#outCode"), "123456");
      answers["POST /ui/outside/enroll/confirm"] = { status: 400, body: { error: "wrong" } };
      await w.click(w.$("#outConfirm"));
      expect(text(w.dialog().querySelector("#outMsg"))).toBe("代碼不對。請確認手機時間正確，並輸入最新的代碼。");
      const on = await open(ENROLLED);
      await on.click(on.$("#outAgain"));
      d = on.dialog();
      expect([text(d.querySelector(".dlg-title")), text(d.querySelector("#outAgainNote"))]).toEqual(["重新綁定驗證器", "舊 App 的代碼會失效，所有從外面登入的人都會被登出。"]);
    } finally { i18n.setLang("en"); }
  });
});

describe("Refs #3061 review (P2 2): closing and opening the dialog again while a secret is being asked for", () => {
  const dirs: string[] = [];
  afterEach(() => { store?.close(); store = null; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const realStore = () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-enroll-")); dirs.push(dir);
    return (store = new WebRemoteAccess(join(dir, "web-remote-access.json"), { warn() {} }));
  };
  const enrolls = () => sent.filter(s => s.method === "POST" && s.path === "/ui/outside/enroll").length;
  /** What the screen shows as the key, as the app takes it (no spaces). */
  const shownKey = (w: Awaited<ReturnType<typeof open>>) => text(w.$("#outKey")).replace(/\s/g, "");
  /** The code an authenticator holding that key shows now. */
  const codeFor = (secret: string) => hotp(base32Decode(secret)!, totpStep(Date.now()));
  const pendingSecret = (s: WebRemoteAccess): string => (s as any).pending.secret;

  it("control: set up, and set up again, with nothing delayed — the key on the screen is the one that confirms", async () => {
    const server = realStore();
    const w = await open();
    await w.click(w.$("#outSetUp"));
    for (let n = 0; n < 40 && !w.$("#outKey"); n++) await settle(4);
    expect(shownKey(w)).toBe(pendingSecret(server));
    const first = shownKey(w);
    await w.type(w.$("#outCode"), codeFor(first));
    status = ENROLLED;
    await w.click(w.$("#outConfirm"));
    expect([w.dialog(), server.enrolled]).toEqual([null, true]);
    // Set up again: a new key, which replaces the first only once its own code is given.
    await w.click(w.$("#outAgain"));
    for (let n = 0; n < 40 && !w.$("#outKey"); n++) await settle(4);
    expect(shownKey(w)).not.toBe(first);
    expect(shownKey(w)).toBe(pendingSecret(server));
    await w.type(w.$("#outCode"), codeFor(shownKey(w)));
    await w.click(w.$("#outConfirm"));
    expect([w.dialog(), server.enrolled]).toEqual([null, true]);
    expect(enrolls()).toBe(2);
  });

  it("A is held on its way to the server, the dialog is closed and opened again: the key shown is the one the server holds, and it confirms", async () => {
    const server = realStore();
    let releaseA!: () => void;
    holdEach["POST /ui/outside/enroll"] = [new Promise<void>(r => { releaseA = r; })];       // A: the server has not seen it
    const w = await open();
    await w.click(w.$("#outSetUp"));                                                        // A asked for
    await w.esc();                                                                          // Cancel while it is out
    await w.click(w.$("#outSetUp"));                                                        // …and again: B
    expect(w.$("#outEnrollLoading")).not.toBeNull();
    // B is not a second request: the dialog waits for the one that is out (a second one reaching the server first would be replaced by A).
    expect(enrolls()).toBe(1);
    releaseA(); await settle(14);
    for (let n = 0; n < 40 && !w.$("#outKey"); n++) await settle(4);
    expect(w.$("#outKey")).not.toBeNull();
    expect(shownKey(w)).toBe(pendingSecret(server));                                         // what the screen shows is what the server holds
    await w.type(w.$("#outCode"), codeFor(shownKey(w)));
    status = ENROLLED;
    await w.click(w.$("#outConfirm"));
    expect([w.dialog(), server.enrolled, w.$("#outState").textContent]).toEqual([null, true, "Authenticator set up"]);
    expect(enrolls()).toBe(1);
  });

  it("the card gone and back while A is out (another section and back): the next dialog meets the same request", async () => {
    const server = realStore();
    let releaseA!: () => void;
    holdEach["POST /ui/outside/enroll"] = [new Promise<void>(r => { releaseA = r; })];
    const first = await open();
    await first.click(first.$("#outSetUp"));
    const w = await open();                                                                  // unmounted and mounted again
    await w.click(w.$("#outSetUp"));
    expect(enrolls()).toBe(1);
    releaseA(); await settle(14);
    for (let n = 0; n < 40 && !w.$("#outKey"); n++) await settle(4);
    expect(shownKey(w)).toBe(pendingSecret(server));
    await w.type(w.$("#outCode"), codeFor(shownKey(w)));
    status = ENROLLED;
    await w.click(w.$("#outConfirm"));
    expect(server.enrolled).toBe(true);
  });

  it("once the first request has answered, opening the dialog again asks for a new key (no stale one is reused)", async () => {
    const server = realStore();
    const w = await open();
    await w.click(w.$("#outSetUp"));
    for (let n = 0; n < 40 && !w.$("#outKey"); n++) await settle(4);
    const first = shownKey(w);
    await w.esc();
    await w.click(w.$("#outSetUp"));
    for (let n = 0; n < 40 && !w.$("#outKey"); n++) await settle(4);
    expect(enrolls()).toBe(2);
    expect(shownKey(w)).not.toBe(first);
    expect(shownKey(w)).toBe(pendingSecret(server));
  });

  it("A that fails while the dialog is open again closes that dialog with the usual failure, and the next try asks anew", async () => {
    let releaseA!: () => void;
    holdEach["POST /ui/outside/enroll"] = [new Promise<void>(r => { releaseA = r; })];
    answers["POST /ui/outside/enroll"] = { status: 403, body: { error: "outside_not_here" } };
    const w = await open();
    await w.click(w.$("#outSetUp"));
    await w.esc();
    await w.click(w.$("#outSetUp"));
    releaseA(); await settle(14);
    expect(w.dialog()).toBeNull();
    delete answers["POST /ui/outside/enroll"];
    await w.click(w.$("#outSetUp"));
    for (let n = 0; n < 40 && !w.$("#outKey"); n++) await settle(4);
    expect([enrolls(), w.$("#outKey") !== null]).toEqual([2, true]);
  });
});

function $all(root: any, sel: string): number { return root.querySelectorAll(sel).length; }
/** How many matches sit in the card but outside any dialog. */
function inCardOnly(card: any, sel: string): number { return [...card.querySelectorAll(sel)].filter((el: any) => !el.closest("dialog")).length; }
