/**
 * #3212: Remove… on an account whose sign-in is still running (src/ui/accounts-manage.js through accounts-view.js, over a faked /ui/accounts).
 * The server refuses ("signing_in": a sign-in for this account is running). The dialog now offers “Cancel sign-in and remove” beside Remove — only after that
 * refusal, only for an account on this host (a paired computer's sign-in is cancelled from that computer's side), and only while the name is still the one
 * typed. It cancels the running sign-in, then removes the account (the same DELETE, the same typed name). Both languages. Fixtures only (example.com).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const none = { agents: [], classic: [], fleetDefault: false };
const VIEW = () => ({ clis: [{ backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [],
  rows: [
    { scope: { kind: "host" }, backend: "claude-code", profile: null, state: "usable", signIn: true, usedBy: none },
    { scope: { kind: "host" }, backend: "claude-code", profile: "CHY", state: "not_signed_in", signIn: true, usedBy: none },
    { scope: { kind: "machine", id: "m1", name: "Desk PC", online: true }, backend: "claude-code", profile: "win", state: "usable", signIn: true, usedBy: none },
  ] }] });
let view: any = VIEW();
const calls: Array<{ method: string; url: string; body: any }> = [];
let answer: (method: string, url: string, body: any) => { status: number; body: any } = () => ({ status: 200, body: {} });
const fetchFake = async (url: string, init: any = {}) => {
  const method = (init.method || "GET").toUpperCase(), body = init.body ? JSON.parse(init.body) : undefined;
  if (method !== "GET") calls.push({ method, url: String(url), body });
  if (method === "GET") return { ok: true, status: 200, json: async () => (String(url).startsWith("/ui/accounts") ? JSON.parse(JSON.stringify(view)) : { login: null, targets: [] }) };
  const a = answer(method, String(url), body);
  return { ok: a.status < 300, status: a.status, json: async () => a.body };
};
let p: AppPage, A: any, S: any, i18n: any, shell: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js"); i18n = await import("/assets/app-i18n.js");
  S = await import("/ui/js/backend-signin.js");
  A = await import("/ui/js/accounts-view.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount(); i18n.setLang("en", { store: false }); view = VIEW(); calls.length = 0; answer = () => ({ status: 200, body: {} });
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); shell.shellStore.set({ dialog: null });
});
async function mount() {
  await p.mount(h(A.AccountsView, { instances: {}, stageAgent: () => {}, stageDefault: () => {}, openAgent: () => {} }));
  await settle(8);
}
const card = () => p.root.querySelector('.s-account-card[data-backend="claude-code"]');
const rowOf = (acct: string, machine = false) => (machine ? card().querySelector(".s-account-machine") : card().querySelector(".s-account-rows")).querySelector(`.s-account-row[data-account="${acct}"]`);
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const dialog = () => p.document.querySelector("dialog") ?? p.root.querySelector("dialog");
const type = async (el: any, value: string) => { el.value = value; fire(el, "input"); await settle(4); };
const btn = (root: any, label: string) => [...root.querySelectorAll("button")].find((b: any) => text(b) === label);
const CANCEL = "/ui/backend-login/cancel", DELETE_CHY = "/ui/accounts/claude-code/CHY";
const SIGNING_IN = { status: 409, body: { error: "signing_in" } };
/** Open Remove for CHY, type its name and press Remove once. */
async function removeChy(reply: typeof answer) {
  await mount();
  rowOf("CHY").querySelector(".s-account-remove").click(); await settle(6);
  await type(dialog().querySelector("#acctRemoveName"), "CHY");
  answer = reply;
  btn(dialog(), "Remove").click(); await settle(10);
}

describe("Remove on an account whose sign-in is running (#3212)", () => {
  it("not offered at first; after the “signing in” refusal it is, beside Remove", async () => {
    await mount();
    rowOf("CHY").querySelector(".s-account-remove").click(); await settle(6);
    await type(dialog().querySelector("#acctRemoveName"), "CHY");
    expect(btn(dialog(), "Cancel sign-in and remove")).toBeUndefined();
    answer = () => SIGNING_IN;
    btn(dialog(), "Remove").click(); await settle(10);
    expect(text(dialog().querySelector(".err"))).toBe("A sign-in for this account is running. Wait for it to end, or cancel it.");
    const cr = btn(dialog(), "Cancel sign-in and remove");
    expect(cr).toBeTruthy();
    expect([cr.disabled, btn(dialog(), "Remove").disabled, btn(dialog(), "Cancel").disabled]).toEqual([false, false, false]);
  });

  it("it cancels the sign-in, then removes the account with the typed name, and closes", async () => {
    await removeChy(() => SIGNING_IN);
    calls.length = 0;
    answer = (method, url) => (method === "POST" && url === CANCEL ? { status: 200, body: {} } : method === "DELETE" ? { status: 200, body: {} } : { status: 200, body: {} });
    btn(dialog(), "Cancel sign-in and remove").click(); await settle(14);
    expect(calls).toEqual([{ method: "POST", url: CANCEL, body: {} }, { method: "DELETE", url: DELETE_CHY, body: { confirm: "CHY" } }]);   // in this order
    expect(dialog()?.querySelector("#acctRemoveName") ?? null).toBe(null);                                                                // closed
  });

  it("if the account is still refused after the cancel, the refusal is said and nothing loops", async () => {
    await removeChy(() => SIGNING_IN);
    calls.length = 0;
    btn(dialog(), "Cancel sign-in and remove").click(); await settle(14);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${CANCEL}`, `DELETE ${DELETE_CHY}`]);
    expect(text(dialog().querySelector(".err"))).toContain("A sign-in for this account is running");
    expect(btn(dialog(), "Cancel sign-in and remove")).toBeTruthy();                                                                       // still there to try again
  });

  it("editing the name takes it away (the refusal was about that name); a different refusal never offers it", async () => {
    await removeChy(() => SIGNING_IN);
    await type(dialog().querySelector("#acctRemoveName"), "CH");
    expect(btn(dialog(), "Cancel sign-in and remove")).toBeUndefined();
    await p.unmount(); view = VIEW(); A.accountsStore.set({ loaded: false, failed: false, view: null });
    await removeChy(() => ({ status: 500, body: { error: "failed" } }));
    expect(btn(dialog(), "Cancel sign-in and remove")).toBeUndefined();
    expect(text(dialog().querySelector(".err"))).toBe("That didn't work. Try again.");
  });

  it("not for a paired computer's account: its sign-in is cancelled on that computer's side", async () => {
    await mount();
    rowOf("win", true).querySelector(".s-account-remove").click(); await settle(6);
    await type(dialog().querySelector("#acctRemoveName"), "win");
    answer = () => SIGNING_IN;
    btn(dialog(), "Remove").click(); await settle(10);
    expect(text(dialog().querySelector(".err"))).toContain("A sign-in for this account is running");
    expect(btn(dialog(), "Cancel sign-in and remove")).toBeUndefined();
    expect(calls.every((c) => c.url !== CANCEL)).toBe(true);
  });

  it("in zh-TW", async () => {
    i18n.setLang("zh-TW", { store: false });
    await mount();
    rowOf("CHY").querySelector(".s-account-remove").click(); await settle(6);
    await type(dialog().querySelector("#acctRemoveName"), "CHY");
    answer = () => SIGNING_IN;
    btn(dialog(), "移除").click(); await settle(10);
    expect(text(dialog().querySelector(".err"))).toBe("這個帳號正在登入。請等它結束，或取消它。");
    expect(btn(dialog(), "取消登入並移除")).toBeTruthy();
  });
});
