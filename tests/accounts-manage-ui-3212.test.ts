/**
 * #3212 PR 2: Settings → Accounts — + Add account and Remove (src/ui/accounts-manage.js through accounts-view.js, over a
 * faked /ui/accounts). + Add account only on a CLI with named accounts; a name is checked as the server checks it before
 * anything is sent; Add posts it, reads the view again and opens Sign in where the dashboard can sign it in (else says
 * to use the host command); a server refusal is said in words. Remove… on named host rows only: an account in use lists
 * who uses it (an agent with Move…, which opens its dialog; the fleet default with Move…; a ClassicBot room with where
 * to change it) and offers no Remove; an unused one needs its name typed exactly; DELETE carries the typed name; a
 * refusal that says it is in use now turns the dialog into that list. Both languages. Fixtures only (example.com).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const VIEW = () => ({ clis: [
  { backend: "claude-code", profiles: true, installed: true, fleetDefault: "work", agents: [{ name: "dev", profile: "work" }],
    rows: [
      { scope: { kind: "host" }, backend: "claude-code", profile: null, state: "usable", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } },
      { scope: { kind: "host" }, backend: "claude-code", profile: "personal", state: "not_signed_in", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } },
      { scope: { kind: "host" }, backend: "claude-code", profile: "work", state: "usable", signIn: true, identity: { maskedEmail: "cd***@corp.example", plan: "team" },
        usedBy: { agents: ["dev"], classic: ["room1"], fleetDefault: true } },
      { scope: { kind: "machine", id: "m1", name: "Desk PC", online: true }, backend: "claude-code", profile: "home", state: "usable", signIn: false, usedBy: { agents: [], classic: [], fleetDefault: false } },
    ] },
  { backend: "codex", profiles: true, installed: true, fleetDefault: null, agents: [],
    rows: [{ scope: { kind: "host" }, backend: "codex", profile: null, state: "usable", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } }] },
  { backend: "grok", profiles: false, installed: true, fleetDefault: null, agents: [],
    rows: [{ scope: { kind: "host" }, backend: "grok", profile: null, state: "usable", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } }] },
] });
let view: any = VIEW();
const calls: Array<{ method: string; url: string; body: any }> = [];
let answer: (method: string, url: string, body: any) => { status: number; body: any } | Promise<{ status: number; body: any }> = () => ({ status: 200, body: {} });
/** A GET of the accounts held until released, answered with the view as it was when it began. */
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
  await p.unmount(); i18n.setLang("en", { store: false }); view = VIEW(); calls.length = 0; answer = () => ({ status: 200, body: {} }); holdGet = null;
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); shell.shellStore.set({ dialog: null });
});
const opened: string[] = [];
async function mount() {
  opened.length = 0;
  await p.mount(h(A.AccountsView, { instances: { dev: {} }, stageAgent: () => {}, stageDefault: () => {}, openAgent: (n: string) => opened.push(n) }));
  await settle(8);
}
const card = (backend: string) => p.root.querySelector(`.s-account-card[data-backend="${backend}"]`);
const rowOf = (backend: string, acct: string) => card(backend).querySelector(`.s-account-row[data-account="${acct}"]`);
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const dialog = () => p.document.querySelector("dialog") ?? p.root.querySelector("dialog");
const type = async (el: any, value: string) => { el.value = value; fire(el, "input"); await settle(4); };
const btn = (root: any, label: string) => [...root.querySelectorAll("button")].find((b: any) => text(b) === label);

describe("+ Add account (#3212 PR 2)", () => {
  it("only on a CLI with named accounts", async () => {
    await mount();
    expect(["claude-code", "codex", "grok"].map((b) => !!card(b).querySelector(".s-account-add"))).toEqual([true, true, false]);
  });
  it("a name is checked before anything is sent; Add posts it, reads again and opens Sign in for it", async () => {
    await mount();
    card("claude-code").querySelector(".s-account-add").click(); await settle(6);
    const d = dialog(), input = d.querySelector("#acctAddName"), add = btn(d, "Add");
    expect(add.disabled).toBe(true);
    for (const bad of ["CON", "a.", "../x", "-x"]) {
      await type(input, bad);
      expect([add.disabled, text(d.querySelector(".err")).startsWith("Use 1–64 letters")], bad).toEqual([true, true]);
    }
    await type(input, "newacct");
    expect([add.disabled, d.querySelector(".err")]).toEqual([false, null]);
    view.clis[0].rows.push({ scope: { kind: "host" }, backend: "claude-code", profile: "newacct", state: "not_signed_in", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } });
    add.click(); await settle(12);
    expect(calls).toEqual([{ method: "POST", url: "/ui/accounts/claude-code", body: { name: "newacct" } }]);
    expect(shell.shellStore.get().dialog?.props).toEqual({ backend: "claude-code", profile: "newacct" });
    expect(dialog()?.querySelector("#acctAddName") ?? null).toBe(null);
  });
  it("where the dashboard can't sign it in, no dialog opens (the row shows the host command); a refusal is said in words", async () => {
    await mount();
    card("codex").querySelector(".s-account-add").click(); await settle(6);
    answer = () => ({ status: 409, body: { error: "case_clash", clash: "Team" } });
    await type(dialog().querySelector("#acctAddName"), "team");
    btn(dialog(), "Add").click(); await settle(10);
    expect(text(dialog().querySelector(".err"))).toBe("“Team” already exists; names that differ only in letter case would be the same folder.");
    answer = () => ({ status: 200, body: { added: "team" } });
    view.clis[1].rows.push({ scope: { kind: "host" }, backend: "codex", profile: "team", state: "not_signed_in", signIn: false, hostCommand: "CODEX_HOME=/x codex login", usedBy: { agents: [], classic: [], fleetDefault: false } });
    btn(dialog(), "Add").click(); await settle(12);
    expect(shell.shellStore.get().dialog).toBe(null);
  });
});

describe("#3291 review (Prism): writes and the reads and dialogs around them", () => {
  const deferred = () => { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); return { p, release }; };
  it("P2-4: the read after Add begins after it; an older read answering later never brings the old view back", async () => {
    await mount();
    const old = deferred(); holdGet = old.p;
    void A.refreshAccounts();                                            // an older read, still out
    card("claude-code").querySelector(".s-account-add").click(); await settle(6);
    await type(dialog().querySelector("#acctAddName"), "newacct");
    view.clis[0].rows.push({ scope: { kind: "host" }, backend: "claude-code", profile: "newacct", state: "not_signed_in", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } });
    btn(dialog(), "Add").click(); await settle(12);
    expect(shell.shellStore.get().dialog?.props).toEqual({ backend: "claude-code", profile: "newacct" });
    old.release(); await settle(12);                                     // the old snapshot (without newacct) answers last
    expect(!!rowOf("claude-code", "newacct")).toBe(true);
  });
  it("P2-5: while Add runs its dialog can't be dismissed; an answer after the view left opens nothing", async () => {
    await mount();
    const post = deferred();
    answer = async () => { await post.p; return { status: 200, body: { added: "late" } }; };
    card("claude-code").querySelector(".s-account-add").click(); await settle(6);
    await type(dialog().querySelector("#acctAddName"), "late");
    btn(dialog(), "Add").click(); await settle(4);
    expect(btn(dialog(), "Cancel").disabled).toBe(true);
    fire(dialog(), "cancel"); dialog().querySelector(".dlg-x").click(); await settle(4);   // Esc and × while it runs
    expect(dialog()?.querySelector("#acctAddName")).toBeTruthy();         // still here, still running
    await p.unmount();                                                   // the person navigated away
    view.clis[0].rows.push({ scope: { kind: "host" }, backend: "claude-code", profile: "late", state: "not_signed_in", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } });
    post.release(); await settle(12);
    expect(shell.shellStore.get().dialog).toBe(null);                    // no sign-in opened for a page that left
  });
  it("P2-5: an Add whose view left while the read after it ran opens nothing", async () => {
    await mount();
    card("claude-code").querySelector(".s-account-add").click(); await settle(6);
    await type(dialog().querySelector("#acctAddName"), "late2");
    view.clis[0].rows.push({ scope: { kind: "host" }, backend: "claude-code", profile: "late2", state: "not_signed_in", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } });
    const read = deferred(); holdGet = read.p;                           // the read after the write is held
    btn(dialog(), "Add").click(); await settle(8);
    await p.unmount();                                                   // the person navigated away meanwhile
    read.release(); await settle(12);
    expect(shell.shellStore.get().dialog).toBe(null);
  });
  it("P2-5: a newer dialog wins — the read after one Add answering late opens no Sign in over the next Add", async () => {
    await mount();
    card("claude-code").querySelector(".s-account-add").click(); await settle(6);
    await type(dialog().querySelector("#acctAddName"), "oldacct");
    view.clis[0].rows.push({ scope: { kind: "host" }, backend: "claude-code", profile: "oldacct", state: "not_signed_in", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } });
    const read = deferred(); holdGet = read.p;                           // the read after the write is held
    btn(dialog(), "Add").click(); await settle(8);
    card("codex").querySelector(".s-account-add").click(); await settle(6);   // the person moves on: another Add
    await type(dialog().querySelector("#acctAddName"), "draft2");
    read.release(); await settle(12);
    expect(shell.shellStore.get().dialog).toBe(null);                    // no Sign in for oldacct
    expect(dialog()?.querySelector("#acctAddName")?.value).toBe("draft2"); // the new dialog and its draft are untouched
  });
  it("P2-5: a Sign in the person opened meanwhile is not replaced by the late one", async () => {
    await mount();
    card("claude-code").querySelector(".s-account-add").click(); await settle(6);
    await type(dialog().querySelector("#acctAddName"), "oldacct2");
    view.clis[0].rows.push({ scope: { kind: "host" }, backend: "claude-code", profile: "oldacct2", state: "not_signed_in", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } });
    const read = deferred(); holdGet = read.p;
    btn(dialog(), "Add").click(); await settle(8);
    rowOf("claude-code", "personal").querySelector(".s-actions button").click(); await settle(6);   // Sign in on another row
    expect(shell.shellStore.get().dialog?.props).toEqual({ backend: "claude-code", profile: "personal" });
    read.release(); await settle(12);
    expect(shell.shellStore.get().dialog?.props).toEqual({ backend: "claude-code", profile: "personal" });
  });
  it("P2-5: a row's Sign in opened and closed meanwhile still ends the late follow-up", async () => {
    await mount();
    card("claude-code").querySelector(".s-account-add").click(); await settle(6);
    await type(dialog().querySelector("#acctAddName"), "oldacct3");
    view.clis[0].rows.push({ scope: { kind: "host" }, backend: "claude-code", profile: "oldacct3", state: "not_signed_in", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } });
    const read = deferred(); holdGet = read.p;
    btn(dialog(), "Add").click(); await settle(8);
    rowOf("claude-code", "personal").querySelector(".s-actions button").click(); await settle(6);
    shell.shellStore.set({ dialog: null }); await settle(4);           // the person closed that Sign in
    read.release(); await settle(12);
    expect(shell.shellStore.get().dialog).toBe(null);
  });
  it("P2-5: while Remove runs its dialog can't be dismissed, and Move… waits too", async () => {
    await mount();
    const del = deferred();
    answer = async () => { await del.p; return { status: 200, body: { removed: "personal" } }; };
    rowOf("claude-code", "personal").querySelector(".s-account-remove").click(); await settle(6);
    await type(dialog().querySelector("#acctRemoveName"), "personal");
    btn(dialog(), "Remove").click(); await settle(4);
    expect(btn(dialog(), "Cancel").disabled).toBe(true);
    fire(dialog(), "cancel"); dialog().querySelector(".dlg-x").click(); await settle(4);   // Esc and × while it runs
    expect(dialog()?.querySelector("#acctRemoveName")).toBeTruthy();
    del.release(); await settle(12);
    expect(dialog()?.querySelector("#acctRemoveName") ?? null).toBe(null);
  });
});

describe("Remove (#3212 PR 2)", () => {
  it("on named host rows only (not the default sign-in, not a paired computer's)", async () => {
    await mount();
    expect(["default", "personal", "work"].map((a) => !!rowOf("claude-code", a).querySelector(".s-account-remove"))).toEqual([false, true, true]);
    expect(card("claude-code").querySelector('.s-account-machine .s-account-remove')).toBe(null);
  });
  it("in use: who uses it, each with where to move it; no Remove and no name to type", async () => {
    await mount();
    rowOf("claude-code", "work").querySelector(".s-account-remove").click(); await settle(6);
    const d = dialog();
    expect(text(d.querySelector("h2, .dlg-title, header"))).toContain("Remove the Claude Code account “work”?");
    expect(text(d)).toContain("its sign-in and its own copies of conversations");
    expect([...d.querySelectorAll(".s-account-inuse li")].map((li: any) => text(li.querySelector("span")))).toEqual(["Agent dev", "The fleet default for Claude Code agents", "ClassicBot room room1"]);
    expect([d.querySelector("#acctRemoveName"), btn(d, "Remove").disabled]).toEqual([null, true]);
    expect(text(d.querySelector(".s-account-inuse li:last-child small"))).toContain("ClassicBot settings");
    d.querySelector(".s-account-inuse li button").click(); await settle(6);
    expect(opened).toEqual(["dev"]);
    expect(calls).toEqual([]);
  });
  it("unused: Remove only once its name is typed exactly; DELETE carries the typed name; the view is read again", async () => {
    await mount();
    rowOf("claude-code", "personal").querySelector(".s-account-remove").click(); await settle(6);
    const d = dialog(), input = d.querySelector("#acctRemoveName"), go = btn(d, "Remove");
    expect(text(d.querySelector("label"))).toBe("Type personal to confirm");
    for (const v of ["", "Personal", "persona", "personal "]) {
      await type(input, v); expect(go.disabled, v).toBe(true);
      fire(input, "keydown", { key: "Enter" }); await settle(4);           // Enter in the field is no way around it
    }
    expect(calls).toEqual([]);
    await type(input, "personal");
    expect(go.disabled).toBe(false);
    view.clis[0].rows = view.clis[0].rows.filter((r: any) => r.profile !== "personal");
    go.click(); await settle(12);
    expect(calls).toEqual([{ method: "DELETE", url: "/ui/accounts/claude-code/personal", body: { confirm: "personal" } }]);
    expect(rowOf("claude-code", "personal")).toBe(null);
  });
  it("a refusal: in use now turns the dialog into the list; a sign-in running is said in words", async () => {
    await mount();
    rowOf("claude-code", "personal").querySelector(".s-account-remove").click(); await settle(6);
    answer = () => ({ status: 409, body: { error: "signing_in" } });
    await type(dialog().querySelector("#acctRemoveName"), "personal");
    btn(dialog(), "Remove").click(); await settle(10);
    expect(text(dialog().querySelector(".err"))).toBe("A sign-in for this account is running. Wait for it to end, or cancel it.");
    answer = () => ({ status: 409, body: { error: "in_use", users: { agents: ["late"], classic: [], fleetDefault: false } } });
    btn(dialog(), "Remove").click(); await settle(10);
    expect([...dialog().querySelectorAll(".s-account-inuse li span")].map(text)).toEqual(["Agent late"]);
    expect(btn(dialog(), "Remove").disabled).toBe(true);
  });
  it("zh-TW", async () => {
    i18n.setLang("zh-TW", { store: false });
    await mount();
    expect(text(card("codex").querySelector(".s-account-add"))).toBe("＋ 新增帳號");
    rowOf("claude-code", "personal").querySelector(".s-account-remove").click(); await settle(6);
    expect(text(dialog().querySelector("label"))).toBe("輸入 personal 以確認");
    expect(text(dialog())).toContain("這會刪除這台主機上該帳號的資料夾：它的登入，以及它自己的對話副本。之後 Agent 就不能使用它");
  });
});
