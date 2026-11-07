/**
 * #3212 PR 3: Settings → Accounts → Sign out… and Switch account… (accounts-manage.js through accounts-view.js, over a
 * faked /ui/accounts and its sign-out route).
 * - Offered only on a signed-in host account of a CLI whose own logout the dashboard runs (Claude Code, Codex, Kiro);
 *   Switch account only on a default sign-in the dashboard can sign in.
 * - The dialog names the account and who stops using it (an agent and, for a named account, the fleet default with
 *   Move…; a ClassicBot room); Sign out posts { profile, confirm: true }; the outcome is said (a Keychain item left on a
 *   Mac in words); a failed logout is said; while it runs the dialog can't be dismissed.
 * - Switch account opens Sign in for that default sign-in after the sign-out — unless the person has moved on meanwhile.
 * Both languages. Fixtures only (example.com).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const used = (agents: string[] = [], classic: string[] = [], fleetDefault = false) => ({ agents, classic, fleetDefault });
const VIEW = () => ({ clis: [
  { backend: "claude-code", profiles: true, installed: true, fleetDefault: "work", agents: [{ name: "dev", profile: "work" }],
    rows: [
      { scope: { kind: "host" }, backend: "claude-code", profile: null, state: "usable", signIn: true, usedBy: used(["ops"]) },
      { scope: { kind: "host" }, backend: "claude-code", profile: "personal", state: "not_signed_in", signIn: true, usedBy: used() },
      { scope: { kind: "host" }, backend: "claude-code", profile: "work", state: "usable", signIn: true, usedBy: used(["dev"], ["room1"], true) },
      { scope: { kind: "machine", id: "m1", name: "Desk PC", online: true }, backend: "claude-code", profile: "home", state: "usable", signIn: false, usedBy: used() },
    ] },
  { backend: "grok", profiles: false, installed: true, fleetDefault: null, agents: [],
    rows: [{ scope: { kind: "host" }, backend: "grok", profile: null, state: "usable", signIn: true, usedBy: used() }] },
] });
let view: any = VIEW();
const calls: Array<{ method: string; url: string; body: any }> = [];
let answer: (method: string, url: string, body: any) => { status: number; body: any } | Promise<{ status: number; body: any }> = () => ({ status: 200, body: {} });
let holdGet: Promise<void> | null = null;
const fetchFake = async (url: string, init: any = {}) => {
  const method = (init.method || "GET").toUpperCase(), body = init.body ? JSON.parse(init.body) : undefined;
  if (method !== "GET") calls.push({ method, url: String(url), body });
  if (method === "GET") {
    const snapshot = JSON.parse(JSON.stringify(view)), held = String(url).startsWith("/ui/accounts") ? holdGet : null;
    if (held) { holdGet = null; await held; }
    return { ok: true, status: 200, json: async () => (String(url).startsWith("/ui/accounts") ? snapshot : { login: null, targets: [] }) };
  }
  const a = await answer(method, String(url), body);
  return { ok: a.status < 300, status: a.status, json: async () => a.body };
};
let p: AppPage, A: any, S: any, T: any, i18n: any, shell: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js"); i18n = await import("/assets/app-i18n.js"); T = await import("/assets/ui-toast.js");
  S = await import("/ui/js/backend-signin.js");
  A = await import("/ui/js/accounts-view.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount(); i18n.setLang("en", { store: false }); view = VIEW(); calls.length = 0; answer = () => ({ status: 200, body: {} }); holdGet = null;
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); shell.shellStore.set({ dialog: null });
});
const opened: string[] = [];
async function mount() {
  opened.length = 0;
  await p.mount(h("div", {}, h(A.AccountsView, { instances: { dev: {}, ops: {} }, stageAgent: () => {}, stageDefault: () => {}, openAgent: (n: string) => opened.push(n) }), h(T.Toasts, {})));
  await settle(8);
}
const card = (backend: string) => p.root.querySelector(`.s-account-card[data-backend="${backend}"]`);
const rowOf = (backend: string, acct: string) => card(backend).querySelector(`.s-account-row[data-account="${acct}"]`);
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const dialog = () => p.document.querySelector("dialog") ?? p.root.querySelector("dialog");
const btn = (root: any, label: string) => [...root.querySelectorAll("button")].find((b: any) => text(b) === label);
const deferred = () => { let release!: () => void; const pr = new Promise<void>((r) => { release = r; }); return { p: pr, release }; };
const toastText = () => text(p.root.querySelector(".toasts, [popover]") ?? p.root);

describe("Sign out… and Switch account… (#3212 PR 3)", () => {
  it("offered on signed-in host accounts of Claude Code, Codex and Kiro only; Switch on the default sign-in", async () => {
    await mount();
    const has = (b: string, a: string, cls: string) => !!rowOf(b, a)?.querySelector(cls);
    expect([has("claude-code", "default", ".s-account-signout"), has("claude-code", "default", ".s-account-switch"),
      has("claude-code", "work", ".s-account-signout"), has("claude-code", "work", ".s-account-switch"),
      has("claude-code", "personal", ".s-account-signout"), has("grok", "default", ".s-account-signout")]).toEqual([true, true, true, false, false, false]);
    expect(card("claude-code").querySelector(".s-account-machine .s-account-signout")).toBe(null);
  });
  it("a named account: who stops using it, each with where to move it; Sign out posts { profile, confirm: true } and says so", async () => {
    await mount();
    rowOf("claude-code", "work").querySelector(".s-account-signout").click(); await settle(6);
    const d = dialog();
    expect(text(d)).toContain("Sign out of Claude Code's account “work”?");
    expect([...d.querySelectorAll(".s-account-inuse li span")].map(text)).toEqual(["Agent dev", "The fleet default for Claude Code agents", "ClassicBot room room1"]);
    d.querySelector(".s-account-inuse li button").click(); await settle(6);
    expect(opened).toEqual(["dev"]);
    rowOf("claude-code", "work").querySelector(".s-account-signout").click(); await settle(6);
    btn(dialog(), "Sign out").click(); await settle(12);
    expect(calls).toEqual([{ method: "POST", url: "/ui/accounts/claude-code/signout", body: { profile: "work", confirm: true } }]);
    expect(dialog()?.querySelector(".s-account-inuse") ?? null).toBe(null);
    expect(toastText()).toContain("Signed out.");
  });
  it("a Keychain item left on a Mac is said; a failed logout is said and the dialog stays", async () => {
    await mount();
    answer = () => ({ status: 500, body: { error: "failed" } });
    rowOf("claude-code", "work").querySelector(".s-account-signout").click(); await settle(6);
    btn(dialog(), "Sign out").click(); await settle(10);
    expect(text(dialog().querySelector(".err"))).toBe("Claude Code's logout didn't succeed. Try again, or run it on the host.");
    answer = () => ({ status: 200, body: { signedOut: "work", keychainLeft: true } });
    btn(dialog(), "Sign out").click(); await settle(12);
    expect(toastText()).toContain("a Keychain item for this account is still on this Mac");
  });
  it("while it runs the dialog can't be dismissed", async () => {
    await mount();
    const post = deferred();
    answer = async () => { await post.p; return { status: 200, body: { signedOut: null } }; };
    rowOf("claude-code", "default").querySelector(".s-account-signout").click(); await settle(6);
    btn(dialog(), "Sign out").click(); await settle(4);
    expect(btn(dialog(), "Cancel").disabled).toBe(true);
    fire(dialog(), "cancel"); dialog().querySelector(".dlg-x").click(); await settle(4);
    expect(dialog()?.querySelector(".s-account-inuse")).toBeTruthy();
    post.release(); await settle(12);
    expect(dialog()?.querySelector(".s-account-inuse") ?? null).toBe(null);
  });
  it("Switch account: signs the default out, then opens Sign in for it", async () => {
    await mount();
    rowOf("claude-code", "default").querySelector(".s-account-switch").click(); await settle(6);
    expect(text(dialog())).toContain("Switch Claude Code's default sign-in?");
    btn(dialog(), "Sign out and sign in").click(); await settle(14);
    expect(calls).toEqual([{ method: "POST", url: "/ui/accounts/claude-code/signout", body: { profile: null, confirm: true } }]);
    expect(shell.shellStore.get().dialog?.props).toEqual({ backend: "claude-code" });
  });
  it("Switch account: the person moved on while it read the view again — no Sign in", async () => {
    await mount();
    rowOf("claude-code", "default").querySelector(".s-account-switch").click(); await settle(6);
    const read = deferred(); holdGet = read.p;
    btn(dialog(), "Sign out and sign in").click(); await settle(8);
    card("claude-code").querySelector(".s-account-add").click(); await settle(6);   // another dialog
    read.release(); await settle(14);
    expect(shell.shellStore.get().dialog).toBe(null);
    expect(dialog()?.querySelector("#acctAddName")).toBeTruthy();
  });
  it("zh-TW", async () => {
    i18n.setLang("zh-TW", { store: false });
    await mount();
    expect([text(rowOf("claude-code", "default").querySelector(".s-account-switch")), text(rowOf("claude-code", "work").querySelector(".s-account-signout"))]).toEqual(["切換帳號…", "登出…"]);
    rowOf("claude-code", "work").querySelector(".s-account-signout").click(); await settle(6);
    expect(text(dialog())).toContain("要登出 Claude Code 的帳號「work」嗎？");
  });
});
