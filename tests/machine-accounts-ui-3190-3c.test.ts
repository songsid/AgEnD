/**
 * #3190 Part 3c: Settings → Accounts for a paired computer (src/ui/accounts-view.js, accounts-manage.js and machine-signin.js, over a faked GET /ui/accounts).
 * A computer's accounts are drawn under its name: its default (read-only), each profile its Runtime created with Sign in / Sign out / Remove, a profile it did
 * not create read-only with the reason and the command to run there, + Add account only where the computer will take one. The server's reason codes are worded
 * here, in both languages. There is no usage, no Move and no Switch on a computer's row. The sign-in dialog is the host's controls pointed at that computer's
 * profile (`?machine=&profile=`). Fixtures only (example.com).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const scope = (extra: Record<string, unknown> = {}) => ({ kind: "machine", id: "m1", name: "Desk PC", online: true, ...extra });
const row = (profile: string | null, extra: Record<string, unknown> = {}, sc: Record<string, unknown> = {}) => ({ scope: scope(sc), backend: "claude-code", profile, state: "usable", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false }, ...extra });
const VIEW = () => ({ clis: [{ backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [{ name: "dev", profile: null }],
  rows: [
    { scope: { kind: "host" }, backend: "claude-code", profile: null, state: "usable", signIn: true, usedBy: { agents: ["dev"], classic: [], fleetDefault: true } },
    row(null, { signIn: false, identity: { maskedEmail: "cd***@example.com", plan: "pro" }, usedBy: { agents: ["w2"], classic: [], fleetDefault: false } }, { readOnlyReason: "default_login" }),
    row("by-hand", { signIn: false, state: "not_signed_in", hostCommand: "agend-runtime login claude-code by-hand" }, { readOnlyReason: "not_created" }),
    row("work", { identity: { maskedEmail: "ab***@example.com", plan: "max" }, usedBy: { agents: ["w1"], classic: [], fleetDefault: true } }),
  ] }] });
let view: any = VIEW();
const calls: Array<{ method: string; url: string; body: any }> = [];
const gets: string[] = [];
const MACHINE_SNAPSHOT = { selected: ["claude-code"], pending: ["claude-code"], skipped: [], states: { "claude-code": "invalid" }, login: null, ready: true, target: { machine: "m1", profile: "work" } };
const ok = (_method: string, url: string) => ({ status: 200, body: url.startsWith("/ui/browser-backend-signins") ? MACHINE_SNAPSHOT : {} });
let answer: (method: string, url: string, body: any) => { status: number; body: any } = ok;
const fetchFake = async (url: string, init: any = {}) => {
  const method = (init.method || "GET").toUpperCase(), body = init.body ? JSON.parse(init.body) : undefined;
  if (method !== "GET") calls.push({ method, url: String(url), body }); else gets.push(String(url));
  if (method === "GET") return { ok: true, status: 200, json: async () => (String(url).startsWith("/ui/accounts") ? JSON.parse(JSON.stringify(view)) : String(url).startsWith("/ui/browser-backend-signins?machine=") ? MACHINE_SNAPSHOT : { login: null, targets: [] }) };
  const a = answer(method, String(url), body);
  return { ok: a.status < 300, status: a.status, json: async () => a.body };
};
let p: AppPage, A: any, S: any, M: any, i18n: any, shell: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js"); i18n = await import("/assets/app-i18n.js");
  S = await import("/ui/js/backend-signin.js"); M = await import("/ui/js/machine-signin.js");
  A = await import("/ui/js/accounts-view.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount(); i18n.setLang("en", { store: false }); view = VIEW(); calls.length = 0; gets.length = 0; answer = ok;
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); M.machineSignInStore.set({ phase: "", reason: "" }); shell.shellStore.set({ dialog: null });
});
const opened: string[] = [];
async function mount() {
  opened.length = 0;
  await p.mount(h(A.AccountsView, { instances: { dev: {}, w1: {} }, stageAgent: () => {}, stageDefault: () => {}, openAgent: (n: string) => opened.push(n) }));
  await settle(8);
}
const card = () => p.root.querySelector('.s-account-card[data-backend="claude-code"]');
const machineBox = () => card().querySelector(".s-account-machine");
const mrow = (acct: string) => machineBox().querySelector(`.s-account-row[data-account="${acct}"]`);
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const dialog = () => p.document.querySelector("dialog") ?? p.root.querySelector("dialog");
const type = async (el: any, value: string) => { el.value = value; fire(el, "input"); await settle(4); };
const btn = (root: any, label: string) => [...root.querySelectorAll("button")].find((b: any) => text(b) === label);
const labels = (root: any) => [...root.querySelectorAll("button")].map((b: any) => text(b));

describe("a computer's accounts under its name", () => {
  it("its name and whether it is online, its default read-only with the reason, and each profile as its Runtime reports it", async () => {
    await mount();
    expect(text(machineBox().querySelector(".s-account-machine-head strong"))).toBe("On Desk PC");
    expect(text(machineBox().querySelector(".s-account-machine-head .tag"))).toBe("online");
    const def = mrow("default"), by = mrow("by-hand"), work = mrow("work");
    // The default: the Windows user's own sign-in. No Sign in, Sign out, Switch or Remove; the reason in words.
    expect(labels(def)).toEqual([]);
    expect(text(def.querySelector(".s-account-why"))).toBe("This is the Windows user's own sign-in on Desk PC. It is never changed from here: add an account instead.");
    expect(text(def.querySelector(".s-account-identity"))).toBe("cd***@example.com · Pro");
    // A profile its Runtime did not create: read-only, why, and the command to run on that computer.
    expect(labels(by)).toEqual([]);
    expect(text(by.querySelector(".s-account-why"))).toBe("This account was not created by AgEnD's Runtime, so it can only be handled on Desk PC.");
    expect([text(by.querySelector("summary")), text(by.querySelector("code"))]).toEqual(["Sign in on that computer", "agend-runtime login claude-code by-hand"]);
    // One it did create: Sign in again, Sign out, Remove — never Move agents here or Switch account.
    expect(labels(work)).toEqual(["Sign in again", "Sign out…", "Remove…"]);
    expect(text(work.querySelector(".s-account-identity"))).toBe("ab***@example.com · Max");
    expect(text(work.querySelector(".s-account-used"))).toBe("used by 1 agent · this computer's default");
  });
  it("no usage on a computer's row: a dash that says why, never 0%", async () => {
    await mount();
    for (const acct of ["default", "by-hand", "work"]) {
      const usage = mrow(acct).querySelector(".s-account-usage");
      expect([text(usage), usage.getAttribute("title")], acct).toEqual(["—", "That computer does not report usage."]);
    }
  });
  it("the host's own rows and their buttons are as they were", async () => {
    await mount();
    const host = card().querySelector('.s-account-rows .s-account-row[data-account="default"]');
    expect(labels(host)).toEqual(expect.arrayContaining(["Sign in again", "Switch account…", "Sign out…"]));
    expect(card().querySelectorAll(".s-account-machine")).toHaveLength(1);
    // Ridge #3321 S08: beside "On Desk PC", the host's rows are named as the host's, before them.
    const head = card().querySelector(".s-account-host-head strong");
    expect([text(head), !!(head.compareDocumentPosition ? true : true)]).toEqual(["On this AgEnD host", true]);
    const kids = [...card().children] as any[];
    expect(kids.findIndex((k) => k.classList?.contains("s-account-host-head"))).toBeLessThan(kids.findIndex((k) => k.classList?.contains("s-account-rows")));
  });
  it.each([
    ["offline", "Desk PC is offline. Start its Runtime to manage its accounts."],
    ["runtime_old", "Desk PC's Runtime is too old to manage accounts from here. Update the Runtime on that computer."],
    ["accounts_off", "The owner of Desk PC has not allowed account changes from AgEnD. On that computer run: agend-runtime remote-setup accounts on"],
    ["switch_unreadable", "Desk PC did not say whether account changes are allowed. Check its Runtime window."],
    ["not_installed", "Claude Code is not installed on Desk PC. Install it from Settings → Runtime."],
  ])("a whole-computer reason (%s) is said once under its name, there is no + Add account, and no row can be changed", async (code, words) => {
    view.clis[0].rows = [view.clis[0].rows[0], ...[row(null, { signIn: false }), row("work", { signIn: false, hostCommand: "agend-runtime login claude-code work" })].map((r: any) => ({ ...r, scope: scope({ online: code !== "offline", readOnlyReason: code }) }))];
    await mount();
    expect(text(machineBox().querySelectorAll(".s-account-why")[0])).toBe(words);        // the first note under the name, before any row
    expect(machineBox().querySelector(".s-account-add")).toBe(null);
    expect(labels(mrow("work"))).toEqual([]);
    expect(text(mrow("work").querySelector("code"))).toBe("agend-runtime login claude-code work");
    expect(text(machineBox().querySelector(".s-account-machine-head .tag"))).toBe(code === "offline" ? "offline" : "online");
  });
  it("a reason code this page does not know (a newer server) is shown as it is, not hidden", async () => {
    view.clis[0].rows[2] = row("by-hand", { signIn: false }, { readOnlyReason: "something_new" });
    await mount();
    expect(text(mrow("by-hand").querySelector(".s-account-why"))).toBe("something_new");
  });
  it("both languages", async () => {
    i18n.setLang("zh-TW", { store: false }); await mount();
    expect(text(machineBox().querySelector(".s-account-machine-head strong"))).toBe("在 Desk PC");
    expect(text(mrow("by-hand").querySelector(".s-account-why"))).toBe("這個帳號不是 AgEnD 的 Runtime 建立的，只能在 Desk PC 上處理。");
    expect(labels(mrow("work"))).toEqual(["重新登入", "登出…", "移除…"]);
    expect(text(mrow("default").querySelector(".s-account-usage"))).toBe("—");
  });
});

describe("Sign in on a computer", () => {
  it("opens that computer's sign-in dialog for that profile (the host's own Sign in still opens the host's)", async () => {
    await mount();
    btn(mrow("work"), "Sign in again").click(); await settle(6);
    expect(shell.shellStore.get().dialog?.props).toEqual({ machine: { id: "m1", name: "Desk PC" }, profile: "work" });
    shell.shellStore.set({ dialog: null });
    btn(card().querySelector('.s-account-rows .s-account-row[data-account="default"]'), "Sign in again").click(); await settle(6);
    expect(shell.shellStore.get().dialog?.props).toEqual({ backend: "claude-code" });
  });
  // The dialog itself, mounted as the shell would show it (showDialog needs the whole shell; the dialog is a component of its own).
  const mountDialog = async () => { await p.unmount(); await p.mount(h(M.MachineSignInDialog, { machine: { id: "m1", name: "Desk PC" }, profile: "work", onClose: () => {} })); await settle(12); };
  it("the dialog is the host's sign-in controls on `?machine=&profile=`: no 'sign in later', no setup heading, the Console hint with the command", async () => {
    await mountDialog();
    const d = dialog() ?? p.root;
    expect(gets.some(url => url === "/ui/browser-backend-signins?machine=m1&profile=work")).toBe(true);
    expect(text(d)).toContain("Sign in Claude Code account “work” on Desk PC");
    expect(text(d)).toContain("Run this on that computer: agend-runtime login claude-code work");
    expect(text(d)).not.toContain("Sign in later"); expect(text(d)).not.toContain("Sign in your AI backends");
    expect(btn(d, "Sign in")).toBeTruthy();       // the state is "invalid" in the snapshot: Sign in (not 'again')
    i18n.setLang("zh-TW", { store: false }); await mountDialog();
    expect(text(dialog() ?? p.root)).toContain("在 Desk PC 登入 Claude Code 帳號「work」");
  });
  it("Sign in posts a start for Claude Code to that endpoint and nothing about a method, command or path", async () => {
    await mountDialog();
    await btn(dialog() ?? p.root, "Sign in").onclick(); await settle(8);      // the sign-in cards assign `onclick`, as the setup page's do
    const start = calls.find(c => c.method === "POST" && c.url.startsWith("/ui/browser-backend-signins"))!;
    expect(start.url).toBe("/ui/browser-backend-signins?machine=m1&profile=work");
    expect(start.body).toEqual({ operation: "start", backend: "claude-code", relogin: false });
  });
  it("a refusal from the server is said in words with the command to run on that computer", async () => {
    answer = (_m, url) => (url.startsWith("/ui/browser-backend-signins") ? { status: 409, body: { error: "machine_accounts_off" } } : { status: 200, body: {} });
    await mountDialog();
    await btn(dialog() ?? p.root, "Sign in").onclick(); await settle(10);
    expect(text((dialog() ?? p.root).querySelector("[role=alert]"))).toBe("The owner of that computer has not allowed this. On that computer run: agend-runtime remote-setup accounts on");
  });
  it("Sign in is disabled while a sign-in on a computer is running; the view reads again when it ends", async () => {
    await mount();
    M.machineSignInStore.set({ phase: "code", reason: "" }); await settle(6);
    expect(btn(mrow("work"), "Sign in again").disabled).toBe(true); expect(card().querySelector(".s-account-rows .btn[disabled]")).toBeTruthy();
    const before = gets.filter(u => u === "/ui/accounts").length;
    M.machineSignInStore.set({ phase: "done", reason: "" }); await settle(8);
    expect(gets.filter(u => u === "/ui/accounts").length).toBeGreaterThan(before);
    expect(btn(mrow("work"), "Sign in again").disabled).toBe(false);
  });
});

describe("+ Add account on a computer", () => {
  it("is on the computer's heading where it will take one: a name is checked here first, Add posts {name, machine}, and Sign in opens at once for that name on that computer", async () => {
    await mount();
    const add = machineBox().querySelector(".s-account-add"); expect(text(add)).toBe("+ Add account");
    add.click(); await settle(6);
    const d = dialog(), input = d.querySelector("#acctAddName");
    expect(text(d)).toContain("Add a Claude Code account on Desk PC"); expect(text(d)).toContain("kept on Desk PC");
    await type(input, "CON"); expect(btn(d, "Add").disabled).toBe(true);
    await type(input, "personal");
    btn(d, "Add").click(); await settle(12);
    expect(calls).toEqual([{ method: "POST", url: "/ui/accounts/claude-code", body: { name: "personal", machine: "m1" } }]);
    expect(shell.shellStore.get().dialog?.props).toEqual({ machine: { id: "m1", name: "Desk PC" }, profile: "personal" });
  });
  it("the host's + Add account is unchanged (no machine in the body)", async () => {
    await mount();
    card().querySelector(".s-account-head .s-account-add").click(); await settle(6);
    const d = dialog(); await type(d.querySelector("#acctAddName"), "newacct"); btn(d, "Add").click(); await settle(12);
    expect(calls[0]).toEqual({ method: "POST", url: "/ui/accounts/claude-code", body: { name: "newacct" } });
  });
  it("a refusal is said in words, with the computer's own reason", async () => {
    answer = () => ({ status: 409, body: { error: "machine_accounts_off" } });
    await mount();
    machineBox().querySelector(".s-account-add").click(); await settle(6);
    const d = dialog(); await type(d.querySelector("#acctAddName"), "personal"); btn(d, "Add").click(); await settle(10);
    expect(text(d.querySelector(".err"))).toBe("The owner of that computer has not allowed this. On that computer run: agend-runtime remote-setup accounts on");
    expect(shell.shellStore.get().dialog?.props?.profile).toBeUndefined();
  });
});

describe("Remove and Sign out on a computer", () => {
  it("Sign out names the computer, asks its Runtime (the body carries the computer), and offers no Switch", async () => {
    await mount();
    btn(mrow("work"), "Sign out…").click(); await settle(6);
    const d = dialog();
    expect(text(d)).toContain("AgEnD asks Desk PC's Runtime to run Claude Code's own logout for this account.");
    expect(labels(d)).not.toContain("Sign out and sign in");
    btn(d, "Sign out").click(); await settle(12);
    expect(calls).toEqual([{ method: "POST", url: "/ui/accounts/claude-code/signout", body: { profile: "work", confirm: true, machine: "m1" } }]);
  });
  it("Remove: the account's users are listed (an agent there with Move…, the computer's own default without one — changing it is done on that computer); typing the name enables it; the body carries the computer", async () => {
    await mount();
    btn(mrow("work"), "Remove…").click(); await settle(6);
    let d = dialog();
    expect(text(d.querySelector(".s-account-inuse"))).toContain("Agent w1"); expect(text(d.querySelector(".s-account-inuse"))).toContain("This computer's default account for agents");
    const moves = d.querySelectorAll(".s-account-inuse button"); expect(moves).toHaveLength(1);           // the agent's Move…, not the computer's default
    moves[0].click(); await settle(6); expect(opened).toEqual(["w1"]);
    // A computer's profile nobody uses: its name typed exactly, then DELETE with the computer.
    view.clis[0].rows[3] = row("work", { usedBy: { agents: [], classic: [], fleetDefault: false } });
    await mount(); btn(mrow("work"), "Remove…").click(); await settle(6); d = dialog();
    expect(text(d)).toContain("This deletes the account's folder on Desk PC"); expect(btn(d, "Remove").disabled).toBe(true);
    await type(d.querySelector("#acctRemoveName"), "work"); btn(d, "Remove").click(); await settle(12);
    expect(calls).toEqual([{ method: "DELETE", url: "/ui/accounts/claude-code/work", body: { confirm: "work", machine: "m1" } }]);
  });
  it("the computer's own refusal sentence is shown as it came; a refusal by code is worded", async () => {
    view.clis[0].rows[3] = row("work", { usedBy: { agents: [], classic: [], fleetDefault: false } });
    answer = () => ({ status: 409, body: { error: "machine_refused", message: 'Credential profile "work" is in use by a running task on this computer; stop it first' } });
    await mount(); btn(mrow("work"), "Remove…").click(); await settle(6);
    let d = dialog(); await type(d.querySelector("#acctRemoveName"), "work"); btn(d, "Remove").click(); await settle(10);
    expect(text(d.querySelector(".err"))).toBe('Credential profile "work" is in use by a running task on this computer; stop it first');
    answer = () => ({ status: 409, body: { error: "machine_offline" } });
    btn(d, "Remove").click(); await settle(10);
    expect(text(d.querySelector(".err"))).toBe("That computer is offline. Start its Runtime, then try again.");
  });
});

describe("Keep sign-in alive (#3292) is drawn on the host's rows only", () => {
  const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
  // A hostile or mistaken payload: a computer's rows (a default, and a profile with the host's profile's name) that carry a `keepAlive` of their own.
  const withKeepAlive = () => {
    const v = VIEW(), rows = v.clis[0]!.rows as any[];
    rows[0].keepAlive = { enabled: true, fallback: false, endsAt: later };                                       // the host's default
    rows.push({ scope: { kind: "host" }, backend: "claude-code", profile: "work", state: "usable", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false }, keepAlive: { enabled: false } });
    for (const row of rows) if (row.scope.kind === "machine" && (row.profile === null || row.profile === "work")) row.keepAlive = { enabled: true, fallback: true, endsAt: later };
    rows.push(row("work", { keepAlive: { enabled: true } }));                                                    // a computer's profile of the same name as the host's
    return v;
  };
  it.each([["en"], ["zh-TW"]])("%s: the host's rows show the control and no row of a computer does, whatever it carries", async (lang) => {
    view = withKeepAlive(); i18n.setLang(lang, { store: false });
    await mount();
    const hostBox = card().querySelector(".s-account-rows");
    expect(hostBox.querySelectorAll(".s-account-keepalive").length).toBe(2);                                    // the host's default and its "work"
    expect(machineBox().querySelectorAll(".s-account-keepalive").length).toBe(0);
    expect(machineBox().querySelectorAll('input[type="checkbox"]').length).toBe(0);
    expect(text(machineBox())).not.toMatch(/keep sign-in alive|保持登入/i);
    expect(card().querySelectorAll(".s-account-keepalive").length).toBe(2);                                     // nowhere else in the card either
    expect([...hostBox.querySelectorAll(".s-account-row")].filter((r: any) => r.querySelector(".s-account-keepalive")).map((r: any) => r.getAttribute("data-account"))).toEqual(["default", "work"]);
  });
  it("a computer's row with no keepAlive of its own draws none, and a host row without one draws none", async () => {
    await mount();
    expect(card().querySelectorAll(".s-account-keepalive").length).toBe(0);
  });
});
