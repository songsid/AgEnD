/**
 * AGEND-113: Settings → Accounts for Antigravity (src/ui/accounts-view.js, machine-signin.js, backend-signin.js, structured-signin.js, over a faked GET /ui/accounts).
 *  - this host: the Antigravity default row has Sign in / Sign in again and opens the SAME dialog Claude's does (BrowserSignInDialog), and an agy older than 1.5.0 keeps
 *    "Sign in on the host" with an update hint;
 *  - a paired computer: ONE row per computer (its own login, no profiles: no Add account, Sign out or Remove), a note that signing in replaces that computer's login, a
 *    confirmation BEFORE the dialog opens, and the dialog is the host's controls on `?machine=&backend=antigravity` (no Console hint, no profile name);
 *  - words in English and 繁體中文, and no new colour in the CSS the page uses. Fixtures only.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const INSTALL = "curl -fsSL https://antigravity.google/cli/install.sh | bash";
const scope = (extra: Record<string, unknown> = {}) => ({ kind: "machine", id: "m1", name: "Desk PC", online: true, ...extra });
const none = { agents: [] as string[], classic: [] as string[], fleetDefault: false };
const hostRow = (extra: Record<string, unknown> = {}) => ({ scope: { kind: "host" }, backend: "antigravity", profile: null, state: "usable", signIn: true, usedBy: none, ...extra });
const machineRow = (extra: Record<string, unknown> = {}, sc: Record<string, unknown> = {}) => ({ scope: scope(sc), backend: "antigravity", profile: null, state: "not_signed_in", signIn: true, usedBy: none, ...extra });
const view = (rows: unknown[]) => ({ clis: [{ backend: "antigravity", profiles: false, installed: true, fleetDefault: null, agents: [], rows }] });
let current: any = view([hostRow(), machineRow()]);
const calls: Array<{ method: string; url: string; body: any }> = [];
const gets: string[] = [];
const AGY_MACHINE = { selected: ["antigravity"], pending: ["antigravity"], skipped: [], states: { antigravity: "invalid" }, login: null, ready: true, target: { machine: "m1", backend: "antigravity" } };
const AGY_HOST = { selected: ["antigravity"], pending: ["antigravity"], skipped: [], states: { antigravity: "console_only" }, login: null, ready: false };
const fetchFake = async (url: string, init: any = {}) => {
  const method = (init.method || "GET").toUpperCase(), body = init.body ? JSON.parse(init.body) : undefined, u = String(url);
  if (method !== "GET") calls.push({ method, url: u, body }); else gets.push(u);
  const reply = u.startsWith("/ui/accounts") ? JSON.parse(JSON.stringify(current)) : u.startsWith("/ui/browser-backend-signins?machine=") ? AGY_MACHINE
    : u.startsWith("/ui/browser-backend-signins") ? AGY_HOST : { login: null, targets: [], structured: null };
  return { ok: true, status: 200, json: async () => reply };
};
let p: AppPage, A: any, S: any, M: any, C: any, i18n: any, shell: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js"); i18n = await import("/assets/app-i18n.js"); C = await import("/assets/ui-confirm.js");
  S = await import("/ui/js/backend-signin.js"); M = await import("/ui/js/machine-signin.js"); A = await import("/ui/js/accounts-view.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; (globalThis as any).confirm = undefined; });
beforeEach(async () => {
  await p.unmount(); i18n.setLang("en", { store: false }); current = view([hostRow(), machineRow()]); calls.length = 0; gets.length = 0;
  (globalThis as any).confirm = undefined;                  // the tests answer the app's own question themselves
  C.confirmStore.set({ queue: [] });
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); M.machineSignInStore.set({ phase: "", reason: "" }); shell.shellStore.set({ dialog: null });
});
async function mount() {
  await p.mount(h(A.AccountsView, { instances: { dev: {} }, stageAgent: () => {}, stageDefault: () => {}, openAgent: () => {} }));
  await settle(8);
}
const card = () => p.root.querySelector('.s-account-card[data-backend="antigravity"]');
const hostBox = () => card().querySelector(".s-account-rows .s-account-row");
const machineBox = () => card().querySelector(".s-account-machine");
const mrow = () => machineBox().querySelector('.s-account-row[data-account="default"]');
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const dialog = () => p.document.querySelector("dialog") ?? p.root.querySelector("dialog");
const btn = (root: any, label: string) => [...root.querySelectorAll("button")].find((b: any) => text(b) === label);
const labels = (root: any) => [...root.querySelectorAll("button")].map((b: any) => text(b));
const actions = (row: any) => labels(row.querySelector(".s-actions"));

describe("this host's Antigravity row", () => {
  it("has Sign in again (it is signed in) and opens the same dialog Claude's default row opens; Sign in for a login that is not there", async () => {
    await mount();
    expect(actions(hostBox())).toContain("Reconnect");
    btn(hostBox(), "Reconnect").click(); await settle(6);
    expect(shell.shellStore.get().dialog?.props).toEqual({ backend: "antigravity" });
    expect(shell.shellStore.get().dialog?.Component).toBe(S.BrowserSignInDialog);
    shell.shellStore.set({ dialog: null });
    current = view([hostRow({ state: "not_signed_in" })]); A.accountsStore.set({ loaded: false, failed: false, view: null }); await p.unmount(); await mount();
    expect(actions(hostBox())).toContain("Connect");
  });
  it("an agy older than 1.5.0 keeps the command to run (the older row), and is told to update, with the command", async () => {
    current = view([hostRow({ state: "not_signed_in", signIn: false, hostCommand: "agy", update: INSTALL })]);
    await mount();
    expect(actions(hostBox())).not.toContain("Connect"); expect(actions(hostBox())).not.toContain("Reconnect");
    expect(text(hostBox().querySelector("summary"))).toBe("Connect from chat");   // the older row, as upstream words it (a host row shows no command, a computer's does)
    expect(text(hostBox())).toContain("Antigravity needs a newer version before it can be connected from here. Update it on the host:"); expect(text(hostBox())).toContain(INSTALL);
    i18n.setLang("zh-TW", { store: false }); await p.unmount(); await mount();
    expect(text(hostBox())).toContain("Antigravity 需要更新到較新的版本，才能從這裡連接。請在主機上更新："); expect(text(hostBox().querySelector("summary"))).toBe("從聊天連接");
  });
  it("a version that was not read yet shows the host command and no update hint", async () => {
    current = view([hostRow({ state: "not_signed_in", signIn: false, hostCommand: "agy" })]); await mount();
    expect(text(hostBox())).not.toContain("newer version");
  });
  it("the dialog offers Sign in for Antigravity (the first-run list keeps it on the console fallback) and posts a start for it", async () => {
    await p.mount(h(S.BrowserSignInDialog, { backend: "antigravity", onClose: () => {} })); await settle(12);
    const d = dialog() ?? p.root;
    expect(text(d)).toContain("Not connected"); expect(text(d)).not.toContain("console fallback, or connect later"); expect(text(d.querySelector("section h3"))).toBe("Antigravity");
    expect(text(d)).not.toContain("Use console fallback");      // chat's /login agy is declined, so there is no console fallback to offer for it
    await btn(d, "Connect account").onclick(); await settle(8);
    const start = calls.find(c => c.method === "POST" && c.url.startsWith("/ui/browser-backend-signins"))!;
    expect(start.url).toBe("/ui/browser-backend-signins"); expect(start.body).toEqual({ operation: "start", backend: "antigravity", relogin: false });
  });
});

describe("a computer's Antigravity login", () => {
  it("is one row under the computer's name: Sign in, no Add account, Sign out or Remove, and a note that it replaces that computer's login", async () => {
    await mount();
    expect(text(machineBox().querySelector(".s-account-machine-head strong"))).toBe("On Desk PC");
    expect(actions(mrow())).toEqual(["Connect"]);
    expect(labels(card().querySelector(".s-account-head"))).toEqual([]);          // no + Add account on this card
    expect(text(mrow())).toContain("This is the Windows user's own Antigravity connection on Desk PC, one for the whole computer. Connecting here replaces it; use + Add account to keep another one beside it.");
    expect(machineBox().querySelectorAll(".s-account-row").length).toBe(1);
    current = view([machineRow({ state: "usable" })]); await p.unmount(); A.accountsStore.set({ loaded: false, failed: false, view: null }); await mount();
    expect(actions(mrow())).toEqual(["Reconnect"]);
  });
  it("says why when it cannot be signed in from here: an old agy, a missing agy, an old Runtime, the owner's switch", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ signIn: false }, "Antigravity on Desk PC is too old to connect from here (it needs 1.5.0 or newer). Update it on that computer."],
      [{ signIn: false }, "Antigravity is not installed on Desk PC."],
      [{ signIn: false }, "Desk PC's Runtime is too old to manage accounts from here. Update the Runtime on that computer."],
      [{ signIn: false }, "The owner of Desk PC has not allowed account changes from AgEnD. On that computer run: agend-runtime remote-setup accounts on"],
    ];
    const reasons = ["cli_old", "cli_missing", "runtime_old", "accounts_off"];
    for (const [i, [extra, words]] of cases.entries()) {
      current = view([machineRow(extra, { readOnlyReason: reasons[i] })]); A.accountsStore.set({ loaded: false, failed: false, view: null }); await p.unmount(); await mount();
      expect(actions(mrow()), reasons[i]).toEqual([]); expect(text(card().querySelector(".s-account-machine")), reasons[i]).toContain(words);
    }
    i18n.setLang("zh-TW", { store: false }); current = view([machineRow({ signIn: false }, { readOnlyReason: "cli_old" })]); A.accountsStore.set({ loaded: false, failed: false, view: null }); await p.unmount(); await mount();
    expect(text(mrow())).toContain("Desk PC 上的 Antigravity 版本太舊，無法從這裡連接（需要 1.5.0 或更新）。請在那台電腦上更新它。");
  });
  it("asks BEFORE anything opens: it replaces the login of that computer's Windows user; Cancel opens nothing, Continue opens the dialog for the computer with no profile", async () => {
    await mount();
    btn(mrow(), "Connect").click(); await settle(6);
    expect(shell.shellStore.get().dialog).toBeFalsy();
    let q = C.confirmStore.get().queue;
    expect(q).toHaveLength(1);
    expect(q[0].title).toBe("Change Antigravity's connection on Desk PC?");
    expect(q[0].message).toBe("This changes the Antigravity connection on Desk PC. One computer can only have one Antigravity account, so the account that is connected there now is replaced.");
    C.answerConfirm(q[0].id, false); await settle(6);
    expect(shell.shellStore.get().dialog).toBeFalsy(); expect(calls).toEqual([]);
    btn(mrow(), "Connect").click(); await settle(6);
    q = C.confirmStore.get().queue; C.answerConfirm(q[0].id, true); await settle(6);
    expect(shell.shellStore.get().dialog?.props).toEqual({ machine: { id: "m1", name: "Desk PC" }, backend: "antigravity" });
    expect(shell.shellStore.get().dialog?.Component).toBe(M.MachineSignInDialog);
    expect(calls).toEqual([]);                               // nothing is started by the click; the dialog's own Sign in does that
  });
  it("the question is in 繁體中文 too", async () => {
    i18n.setLang("zh-TW", { store: false }); await mount();
    btn(mrow(), "連接").click(); await settle(6);
    const q = C.confirmStore.get().queue[0];
    expect([q.title, q.confirmLabel]).toEqual(["要更改 Desk PC 上的 Antigravity 連接嗎？", "繼續"]);
    expect(q.message).toBe("這會更改 Desk PC 上的 Antigravity 連接。一台電腦只能有一個 Antigravity 帳號，所以目前連接在那裡的帳號會被取代。");
  });
  const mountDialog = async () => { await p.unmount(); await p.mount(h(M.MachineSignInDialog, { machine: { id: "m1", name: "Desk PC" }, backend: "antigravity", onClose: () => {} })); await settle(12); };
  it("the dialog is the host's controls on `?machine=&backend=antigravity`: titled for the computer, no profile name and no Claude Console hint", async () => {
    expect(M.machineSignInEndpoint("m1", undefined, "antigravity")).toBe("/ui/browser-backend-signins?machine=m1&backend=antigravity");
    expect(M.machineSignInEndpoint("m1", "work")).toBe("/ui/browser-backend-signins?machine=m1&profile=work");
    expect(M.machineSignInEndpoint("m1", "work", "claude-code")).toBe("/ui/browser-backend-signins?machine=m1&profile=work");
    await mountDialog();
    const d = dialog() ?? p.root;
    expect(gets).toContain("/ui/browser-backend-signins?machine=m1&backend=antigravity");
    expect(text(d)).toContain("Connect Antigravity on Desk PC");
    expect(text(d)).toContain("This replaces the Antigravity connection of the Windows user on that computer");
    expect(text(d)).not.toContain("agend-runtime login"); expect(text(d)).not.toContain("account “"); expect(text(d)).not.toContain("Connect later");
    expect(text(d)).toContain("Not connected"); expect(text(d.querySelector("section h3"))).toBe("Antigravity");   // not "(console fallback)": it signs in here
    i18n.setLang("zh-TW", { store: false }); await mountDialog();
    expect(text(dialog() ?? p.root)).toContain("在 Desk PC 連接 Antigravity");
  });
  it("Sign in posts a start for Antigravity to that address, with nothing about a profile, method, command or path", async () => {
    await mountDialog();
    await btn(dialog() ?? p.root, "Connect account").onclick(); await settle(8);
    const start = calls.find(c => c.method === "POST" && c.url.startsWith("/ui/browser-backend-signins"))!;
    expect(start.url).toBe("/ui/browser-backend-signins?machine=m1&backend=antigravity");
    expect(start.body).toEqual({ operation: "start", backend: "antigravity", relogin: false });
  });
  it("Claude's computer dialog is unchanged: its profile address, its title and its Console hint", async () => {
    await p.unmount(); await p.mount(h(M.MachineSignInDialog, { machine: { id: "m1", name: "Desk PC" }, profile: "work", onClose: () => {} })); await settle(12);
    const d = dialog() ?? p.root;
    expect(gets).toContain("/ui/browser-backend-signins?machine=m1&profile=work");
    expect(text(d)).toContain("Connect Claude Code account “work” on Desk PC"); expect(text(d)).toContain("Run this on that computer: agend-runtime login claude-code work");
  });
});

describe("this host's Antigravity row: the account and every quota pool with every window", () => {
  const H = 3_600_000;
  const win = (kind: string, percent: number, windowMs?: number) => ({ kind, percent, ...(windowMs ? { windowMs, resetsAt: new Date(Date.now() + windowMs / 2).toISOString() } : {}) });
  const CLAUDE_OTHERS = { label: "Claude & others", labelI18n: { key: "usage.metric.agy_claude_others" } };
  const GEMINI = { label: "Gemini", labelI18n: { key: "usage.metric.named", args: ["Gemini"] } };
  const ARGON = { label: "Gemini 4 Argon", labelI18n: { key: "usage.metric.named", args: ["Gemini 4 Argon"] } };
  const POOLS = [{ pool: GEMINI, windows: [win("session", 0, 5 * H), win("weekly", 13, 168 * H)] }, { pool: CLAUDE_OTHERS, windows: [win("session", 0, 5 * H), win("weekly", 39, 168 * H)] }, { pool: ARGON, windows: [win("unwindowed", 1)] }];
  const blocks = () => [...hostBox().querySelectorAll(".s-usage-group")].map((g: any) => ({ pool: text(g.querySelector(".s-usage-pool")), meters: [...g.querySelectorAll(".u-cm")].map((m: any) => [text(m.querySelector(".u-cm-tag")), text(m.querySelector(".u-cm-pct"))]) }));
  it("shows the masked account and one block per pool with ALL of its windows — Gemini's week and Claude & others' 5h are there, not hidden — in the page's language", async () => {
    current = view([hostRow({ identity: { maskedEmail: "ad***@example.com" }, usageGroups: POOLS })]);
    await mount();
    expect(text(hostBox().querySelector(".s-account-identity"))).toBe("ad***@example.com");
    expect(blocks()).toEqual([
      { pool: "Gemini", meters: [["5h", "0%"], ["7d", "13%"]] },
      { pool: "Claude & others", meters: [["5h", "0%"], ["7d", "39%"]] },
      { pool: "Gemini 4 Argon", meters: [["—", "1%"]] },       // one number with no window: a dash, under the pool's name
    ]);
    expect(hostBox().querySelector(".s-account-usage").className).toContain("is-pooled");
    i18n.setLang("zh-TW", { store: false }); await p.unmount(); A.accountsStore.set({ loaded: false, failed: false, view: null }); await mount();
    expect(blocks()).toEqual([
      { pool: "Gemini", meters: [["5h", "0%"], ["本週", "13%"]] },
      { pool: "Claude 與其他模型", meters: [["5h", "0%"], ["本週", "39%"]] },
      { pool: "Gemini 4 Argon", meters: [["—", "1%"]] },
    ]);
  });
  it("a provider with one set of limits (Claude, Codex) is drawn exactly as before: the windows side by side in the block, no pool block, no name", async () => {
    current = view([hostRow({ usageGroups: [{ windows: [win("session", 11, 5 * H), win("weekly", 27, 168 * H)] }] })]);
    await mount();
    expect(hostBox().querySelectorAll(".s-usage-group").length).toBe(0); expect(hostBox().querySelectorAll(".s-usage-pool").length).toBe(0);
    expect(hostBox().querySelector(".s-account-usage").className).not.toContain("is-pooled");
    expect([...hostBox().querySelector(".s-account-usage").children].map((c: any) => c.className.split(" ")[0])).toEqual(["u-cm", "u-cm"]);   // one grid item per window, as the stylesheet has it
  });
  it("a pool the page has no word for falls back to the label the server sent; a window with no name for its pool sits in a block with no heading", async () => {
    current = view([hostRow({ usageGroups: [{ pool: { label: "Some pool", labelI18n: { key: "usage.metric.does_not_exist" } }, windows: [win("session", 5, 5 * H)] }, { windows: [win("weekly", 6, 168 * H)] }] })]);
    await mount();
    expect(blocks().map((b: any) => b.pool)).toEqual(["Some pool", ""]);
  });
  it("a pool whose window has reset since the read says so in the usage panel's words instead of an old percent, and the pool's other windows keep their numbers", async () => {
    current = view([hostRow({ usageGroups: [{ pool: GEMINI, windows: [{ ...win("session", 90, 5 * H), resetPassed: true }, win("weekly", 13, 168 * H)] }] })]);
    await mount();
    const g = hostBox().querySelector(".s-usage-group");
    expect(g.querySelectorAll(".u-cm").length).toBe(2);
    expect(text(g.querySelector(".s-usage-reset"))).toMatch(/^5h.*reset|^5h.*重置/i); expect(text(g.querySelector(".s-usage-reset"))).not.toContain("90");
    expect(text(g.querySelectorAll(".u-cm")[1].querySelector(".u-cm-pct"))).toBe("13%");
  });
  it("the last known numbers are greyed and say so once", async () => {
    current = view([hostRow({ usageGroups: POOLS, usageStale: true })]); await mount();
    expect(hostBox().querySelector(".s-account-usage").className).toContain("is-stale");
    expect(hostBox().querySelectorAll(".s-usage-stale").length).toBe(1);
  });
  it("the account line is the address alone: no plan is invented for Antigravity", async () => {
    current = view([hostRow({ identity: { maskedEmail: "ad***@example.com" } })]); await mount();
    expect(text(hostBox().querySelector(".s-account-identity"))).not.toMatch(/Unknown plan|Pro|Max|Team/);
  });
});

describe("the code box for Antigravity", () => {
  it("says to paste only the code, not the page's address; Claude's code box has no such line, and a refused entry has a plain message", async () => {
    const { mountStructuredSignIns, SIGNIN_STRINGS } = await import("/ui/js/structured-signin.js");
    const root = p.document.createElement("div"); p.document.body.appendChild(root);
    const snapshot = (backend: string) => ({ selected: [backend], pending: [backend], skipped: [], states: { [backend]: "invalid" }, ready: false,
      login: { id: "a".repeat(32), backend, revision: 3, phase: "code", url: "https://example.com/x", canAct: true, mine: true } });
    const { capsOf } = await import("/ui/js/cli-caps.js");
    for (const [backend, expected] of [["antigravity", true], ["claude-code", false]] as const) {
      // The callers (backend-signin.js, machine-signin.js) pass what the registry says (`host.structuredSignIn.answer`): only a CLI whose own prompt also takes the page's address gets the line.
      const cards = mountStructuredSignIns(root, { endpoint: "/ui/x", lang: () => "en", dialog: true, focus: backend, codeHint: (b: string) => !!capsOf(b)?.codeHint, fetcher: async () => ({ ok: true, status: 200, json: async () => snapshot(backend) }) });
      await settle(8);
      expect(text(root).includes("Paste only the code the page shows, not the page's address."), backend).toBe(expected);
      cards.dispose();
    }
    for (const lang of ["en", "zh-TW"] as const) for (const key of ["codeOnly", "error_signin_action_invalid"]) expect(SIGNIN_STRINGS[lang][key], `${lang} ${key}`).toBeTruthy();
  });
});

describe("the page's words and colours", () => {
  it("every string of the new dialog and rows is in both languages", () => {
    const keys = ["titleDefault", "leadDefault", "confirmTitle", "confirm", "confirmLabel"];
    for (const lang of ["en", "zh-TW"]) { i18n.setLang(lang, { store: false }); for (const key of keys) expect(i18n.t(`machineSignin.${key}`, "A", "B"), `${lang} ${key}`).not.toBe(`machineSignin.${key}`); }
    for (const lang of ["en", "zh-TW"]) { i18n.setLang(lang, { store: false }); for (const key of ["why_cli_old", "why_cli_missing", "machineOneLogin", "updateHint"]) expect(i18n.t(`accounts.${key}`, "Desk PC"), `${lang} ${key}`).not.toBe(`accounts.${key}`); }
  });
  it("adds no hex colour to the files it touches in the UI (the shared Dialog, .btn and .note carry the look)", () => {
    for (const file of ["machine-signin.js", "accounts-view.js", "structured-signin.js", "backend-signin.js"]) {
      const source = readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
      expect(source.match(/#[0-9a-fA-F]{3,8}\b(?![\w-])/g)?.filter(hex => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) ?? [], file).toEqual([]);
    }
  });
});
