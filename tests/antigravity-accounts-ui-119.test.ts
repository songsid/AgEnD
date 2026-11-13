/**
 * AGEND-119: what Settings → Accounts shows for Antigravity now that it has named accounts on the host, a sign-out and Keep connection alive (accounts-view.js, accounts-manage.js,
 * accounts-keepalive.js, usage-pool.js over a faked /ui/accounts):
 *  - + Add account is on the card, and not under a paired computer's name (a computer keeps the one row for its own login);
 *  - Sign out and Switch account are offered, and say that agy has no logout command (AgEnD deletes the account's sign-in file, then checks), in both languages; a sign-out that did not take effect
 *    (the sign-in is kept in the system's keyring) is said as that, and an unconfirmed one as unconfirmed;
 *  - Remove says the account's conversations go with its sign-in;
 *  - the Keep connection alive line is there with Antigravity's own words;
 *  - the usage block of an account whose numbers are old says why and since when.
 * Fixtures only (example.com).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const used = (agents: string[] = [], classic: string[] = [], fleetDefault = false) => ({ agents, classic, fleetDefault });
const HOUR = 3_600_000;
const VIEW = () => ({ clis: [
  { backend: "antigravity", profiles: true, machineProfiles: false, installed: true, fleetDefault: null, agents: [{ name: "dev", profile: "work" }],
    rows: [
      { scope: { kind: "host" }, backend: "antigravity", profile: null, state: "usable", signIn: true, usedBy: used(),
        identity: { maskedEmail: "pe***@example.com" },
        usageGroups: [{ pool: { label: "Gemini" }, windows: [{ kind: "session", percent: 11, windowMs: 5 * HOUR }, { kind: "weekly", percent: 16, windowMs: 168 * HOUR }] },
          { pool: { label: "Claude & others", labelI18n: { key: "usage.metric.agy_claude_others" } }, windows: [{ kind: "session", percent: 0, windowMs: 5 * HOUR }, { kind: "weekly", percent: 39, windowMs: 168 * HOUR }] }],
        usageStale: true, usageStaleInfo: { cause: "expired", cachedAt: "2026-11-09T06:55:00", hint: "Access token expired.", hintI18n: { key: "usage.error.agy_token_expired" } },
        keepAlive: { enabled: true, expiresAt: "2026-11-09T07:55:00.000Z", lastAt: "2026-11-09T06:55:00.000Z", lastOutcome: "refreshed" } },
      { scope: { kind: "host" }, backend: "antigravity", profile: "work", state: "usable", signIn: true, usedBy: used(["dev"]), identity: { maskedEmail: "wo***@example.com" },
        keepAlive: { enabled: false } },
      { scope: { kind: "host" }, backend: "antigravity", profile: "spare", state: "not_signed_in", signIn: true, usedBy: used(), keepAlive: { enabled: false } },
      { scope: { kind: "machine", id: "m1", name: "Desk PC", online: true }, backend: "antigravity", profile: null, state: "usable", signIn: true, usedBy: used() },
    ] },
] });
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
  await p.unmount(); i18n.setLang("en", { store: false }); view = VIEW(); calls.length = 0; answer = () => ({ status: 200, body: {} });
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); shell.shellStore.set({ dialog: null });
});
async function mount() {
  await p.mount(h("div", {}, h(A.AccountsView, { instances: { dev: {} }, stageAgent: () => {}, stageDefault: () => {}, openAgent: () => {} }), h(T.Toasts, {})));
  await settle(8);
}
const card = () => p.root.querySelector('.s-account-card[data-backend="antigravity"]');
const rowOf = (acct: string) => card().querySelector(`.s-account-row[data-account="${acct}"]`);
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const dialog = () => p.document.querySelector("dialog") ?? p.root.querySelector("dialog");
const btn = (root: any, label: string) => [...root.querySelectorAll("button")].find((b: any) => text(b) === label);
const toastText = () => text(p.root.querySelector(".toasts, [popover]") ?? p.root);

describe("Antigravity's card", () => {
  it("has + Add account on the host, none under the computer's name, and Sign out on each signed-in host account", async () => {
    await mount();
    expect(card().querySelectorAll(".s-account-head .s-account-add").length).toBe(1);
    expect(card().querySelector(".s-account-machine .s-account-add")).toBe(null);
    expect(card().querySelector(".s-account-machine .s-account-signout")).toBe(null);          // the computer's own login is never signed out from here
    expect([!!rowOf("default").querySelector(".s-account-signout"), !!rowOf("work").querySelector(".s-account-signout"), !!rowOf("spare").querySelector(".s-account-signout")]).toEqual([true, true, false]);
    expect(!!rowOf("default").querySelector(".s-account-switch")).toBe(true);
    expect(!!rowOf("work").querySelector(".s-account-remove")).toBe(true);
    expect(!!rowOf("default").querySelector(".s-account-remove")).toBe(false);
  });
  it("an account's row names its account and says why its numbers are old: the cause, when they were read, and what the read said", async () => {
    await mount();
    expect(text(rowOf("default").querySelector(".s-account-identity"))).toContain("pe***@example.com");
    const stale = text(rowOf("default").querySelector(".s-usage-stale"));
    expect(stale).toMatch(/^\(stale\) expired · cached at (\d{1,2}\/\d{1,2} )?\d{1,2}:\d\d/);
    expect(stale).toContain("Keep connection alive");
    expect([...rowOf("default").querySelectorAll(".s-usage-pool")].map(text)).toEqual(["Gemini", "Claude & others"]);
  });
  it("Keep connection alive is there for each host account, with Antigravity's own words", async () => {
    await mount();
    for (const acct of ["default", "work", "spare"]) expect(text(rowOf(acct)), acct).toContain("Keep connection alive");
    expect(rowOf("work").querySelector('[data-tip], .info-tip, button[aria-label]')).toBeTruthy();
  });
});

describe("Sign out: agy has no logout command", () => {
  it("says AgEnD deletes the account's sign-in file and checks, and posts { profile, confirm: true }", async () => {
    await mount();
    rowOf("work").querySelector(".s-account-signout").click(); await settle(6);
    expect(text(dialog())).toContain("has no logout command");
    expect(text(dialog())).not.toContain("own logout");
    btn(dialog(), "Disconnect").click(); await settle(12);
    expect(calls).toEqual([{ method: "POST", url: "/ui/accounts/antigravity/signout", body: { profile: "work", confirm: true } }]);
    expect(toastText()).toContain("Disconnected.");
  });
  it("a sign-out that did not take effect (kept in the system's keyring) is said as that, and the dialog stays", async () => {
    await mount();
    answer = () => ({ status: 409, body: { error: "still_signed_in" } });
    rowOf("default").querySelector(".s-account-signout").click(); await settle(6);
    btn(dialog(), "Disconnect").click(); await settle(10);
    expect(text(dialog().querySelector(".err"))).toContain("still says it is connected");
    expect(text(dialog().querySelector(".err"))).toContain("keyring");
  });
  it("one agy could not confirm is said as unconfirmed", async () => {
    await mount();
    answer = () => ({ status: 200, body: { signedOut: "work", unverified: true } });
    rowOf("work").querySelector(".s-account-signout").click(); await settle(6);
    btn(dialog(), "Disconnect").click(); await settle(12);
    expect(toastText()).toContain("not confirmed");
  });
  it("Switch account says the same, then opens Sign in", async () => {
    await mount();
    rowOf("default").querySelector(".s-account-switch").click(); await settle(6);
    expect(text(dialog())).toContain("has no logout command");
    btn(dialog(), "Disconnect and reconnect").click(); await settle(14);
    expect(calls[0]).toEqual({ method: "POST", url: "/ui/accounts/antigravity/signout", body: { profile: null, confirm: true } });
    expect(shell.shellStore.get().dialog?.props).toEqual({ backend: "antigravity" });
  });
  it("繁體中文", async () => {
    i18n.setLang("zh-TW", { store: false });
    await mount();
    rowOf("work").querySelector(".s-account-signout").click(); await settle(6);
    expect(text(dialog())).toContain("沒有登出指令");
    answer = () => ({ status: 409, body: { error: "still_signed_in" } });
    btn(dialog(), "撤銷連接").click(); await settle(10);
    expect(text(dialog().querySelector(".err"))).toContain("仍顯示已連接");
  });
});

describe("Remove", () => {
  it("says the account's conversations go with its sign-in (its whole folder), in both languages", async () => {
    await mount();
    rowOf("work").querySelector(".s-account-remove").click(); await settle(6);
    expect(text(dialog())).toContain("its connection and its own conversations");
    await p.unmount(); i18n.setLang("zh-TW", { store: false }); A.accountsStore.set({ loaded: false, failed: false, view: null }); await mount();
    rowOf("work").querySelector(".s-account-remove").click(); await settle(6);
    expect(text(dialog())).toContain("它的連接，以及它自己的對話");
  });
});
