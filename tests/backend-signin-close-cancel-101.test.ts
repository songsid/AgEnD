/**
 * AGEND-101: closing the Sign in dialog (src/ui/backend-signin.js) before the sign-in terminal has been opened.
 * Adding a named account opens this dialog and starts a background sign-in (a terminal session that lives 10 minutes). Closing the dialog only
 * hid it: the sign-in kept running, and for those minutes the server refused to remove the account ("a sign-in for this account is running").
 * Now closing it (Close, ×, Esc) ends the sign-in — but ONLY when it is yours, running, and its one-time access code has not been used yet
 * (the server sends `accessCode` only until the terminal has been opened); otherwise closing just closes. "Cancel sign-in" ends it and closes.
 * The real modules on the mini DOM with a recording fetch; nothing reaches a server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

type Req = { method: string; url: string; body: any };
let reqs: Req[] = [];
let answer: (r: Req) => unknown = () => ({});
const fetchFake = async (url: string, init: any = {}) => {
  const r: Req = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  const body = await answer(r);
  return { ok: true, status: 200, json: async () => body };
};

const CODE = "ABCDEFGHJKMNPQRSTVWX";
const RUNNING = { id: "r1", backend: "claude-code", profile: "CHY", phase: "running", ok: null, startedOn: "Firefox on Linux", startedAt: 1, endedAt: null, mine: true, lines: [],
  hint: null, terminal: { url: "http://localhost:40001/t/abab/", ttlMinutes: 10, command: "claude auth login", loopback: true, public: false }, accessCode: CODE };
const CANCEL = "/ui/backend-login/cancel";

let p: AppPage;
let S: any, shell: any, i18n: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  (globalThis as any).navigator.clipboard = { writeText: async () => {} };
  shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js");
  S = await import("/ui/js/backend-signin.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  reqs = []; answer = () => ({ login: null, targets: [] });
  i18n.setLang("en", { store: false });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null });
  shell.shellStore.set({ dialog: null });
});
const btn = (label: string) => p.root.querySelectorAll("button").find((b: any) => b.textContent.trim() === label);
const cancels = () => reqs.filter((r) => r.url === CANCEL);
/** The dialog resumed on a running sign-in (the state the Accounts view's Add account leaves it in), with `login` as the server describes it. */
async function resumed(login: Record<string, unknown> | null) {
  const closed: number[] = [];
  S.signInStore.set({ login });
  await p.mount(h(S.SignInDialog, { backend: "claude-code", profile: "CHY", resume: true, onClose: () => closed.push(1) }));
  await settle(6);
  reqs = [];                                                                       // the dialog's own reads on opening are not the point
  return closed;
}

describe("closing the Sign in dialog before the terminal is opened ends the background sign-in (AGEND-101)", () => {
  it("yours, running, its access code not used yet: Close posts the cancel and closes", async () => {
    const closed = await resumed(RUNNING);
    fire(btn("Close"), "click"); await settle(6);
    expect(cancels()).toEqual([{ method: "POST", url: CANCEL, body: {} }]);
    expect(closed).toEqual([1]);
  });
  it("× and Esc (the Dialog's own close) do the same", async () => {
    const closed = await resumed(RUNNING);
    const x = p.root.querySelector('[aria-label="Close"], .dlg-close, button.icon-btn');
    if (x) fire(x, "click"); else fire(p.document, "keydown", { key: "Escape" });
    await settle(6);
    expect(cancels()).toHaveLength(1);
    expect(closed).toEqual([1]);
  });
  it.each([
    ["the terminal has been opened (no access code any more)", { ...RUNNING, accessCode: null }],
    ["it is another admin's sign-in", { ...RUNNING, mine: false, accessCode: undefined }],
    ["it has ended", { ...RUNNING, phase: "done", ok: true, accessCode: null, terminal: null }],
    ["there is no terminal (a device-code sign-in)", { ...RUNNING, terminal: null, accessCode: null }],
  ])("%s: Close only closes — nothing is cancelled", async (_why, login) => {
    const closed = await resumed(login as Record<string, unknown>);
    fire(btn("Close"), "click"); await settle(6);
    expect(cancels()).toEqual([]);
    expect(closed).toEqual([1]);
  });
  it("before a sign-in has started (checking, or asking to confirm) there is nothing to cancel", async () => {
    answer = (r) => r.url === "/ui/backend-login/check" ? { confirm: { id: "c".repeat(32), backend: "claude-code", tokenPresent: false, logoutFirst: null, publicLink: false, deviceAuth: false, expiresAt: 0 } } : { login: null, targets: [] };
    S.signInStore.set({ login: RUNNING });                                         // a running one exists, but this dialog has not started anything
    const closed: number[] = [];
    await p.mount(h(S.SignInDialog, { backend: "claude-code", profile: "CHY", onClose: () => closed.push(1) })); await settle(8);
    reqs = [];
    fire(btn("Cancel"), "click"); await settle(6);
    expect(cancels()).toEqual([]);
    expect(closed).toEqual([1]);
  });
});

describe("“Cancel sign-in” ends it and closes the dialog (AGEND-101)", () => {
  it("posts the cancel, says so, and closes", async () => {
    const closed = await resumed(RUNNING);
    fire(btn("Cancel sign-in"), "click"); await settle(8);
    expect(cancels()).toHaveLength(1);                                             // once: the close that follows must not cancel a second time
    expect(closed).toEqual([1]);
  });
  it("in zh-TW: 關閉 ends it too", async () => {
    i18n.setLang("zh-TW", { store: false });
    const closed = await resumed(RUNNING);
    fire(btn("關閉"), "click"); await settle(6);
    expect(cancels()).toHaveLength(1);
    expect(closed).toEqual([1]);
  });
});
