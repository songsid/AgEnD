/**
 * M-3307 (#4146): the AI accounts card of an npm-global Claude Code offers "Switch to native install"; the switch's result says where `claude` runs now, and while the npm
 * copy is left the card offers "Remove the npm copy" with what it removes. Each button posts only `{ backend: "claude-code" }` to its route. Both languages, no raw key.
 * Harness: tests/accounts-update-ui-136.test.ts's (the real modules over a faked /ui/accounts and /ui/host-*).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const hostRow = (backend: string, state: string, extra: Record<string, unknown> = {}) => ({ scope: { kind: "host" }, backend, profile: null, state, signIn: false, usedBy: { agents: [], classic: [], fleetDefault: true }, ...extra });
const upd = (state: string, installed: string, audited: string, over: Record<string, unknown> = {}) => ({ state, installed, audited, button: state === "behind", via: "dashboard", ...over });
const GROK_BEHIND = { backend: "grok", profiles: false, installed: true, fleetDefault: null, agents: [], rows: [hostRow("grok", "usable", { signIn: true, version: "1.0.70", cliUpdate: upd("behind", "1.0.70", "1.0.77") })] };
const CODEX_CURRENT = { backend: "codex", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [hostRow("codex", "usable", { signIn: true, version: "0.166.0", cliUpdate: upd("current", "0.166.0", "0.166.0") })] };
const CLAUDE_NEWER = { backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [hostRow("claude-code", "usable", { signIn: true, version: "2.1.319", cliUpdate: upd("newer", "2.1.319", "2.1.318") })] };
const AGY_SELF = { backend: "antigravity", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [hostRow("antigravity", "usable", { signIn: true, version: "1.3.5", cliUpdate: upd("behind", "1.3.5", "1.3.6", { via: "self", button: false }) })] };
const OPENCODE_BEHIND = { backend: "opencode", profiles: false, installed: true, installOnly: true, fleetDefault: null, agents: [], rows: [hostRow("opencode", "usable", { version: "1.17.20", cliUpdate: upd("behind", "1.17.20", "1.18.34") })] };
const NPM = "/usr/lib/node_modules/@anthropic-ai/claude-code";
const CLAUDE_NPM = { backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [hostRow("claude-code", "usable", { signIn: true, version: "2.1.325", cliUpdate: upd("current", "2.1.325", "2.1.325"), nativeSwitch: { npmPackageDir: NPM } })] };
let view: any = { clis: [CLAUDE_NPM] };
let run: any = null;
type Req = { method: string; url: string; body: any };
let reqs: Req[] = [];
let postAnswer: (r: Req) => { status?: number; body: unknown } = () => ({ body: {} });
const fetchFake = async (url: string, init: any = {}) => {
  const r: Req = { method: init.method || "GET", url: String(url), body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  if (r.method === "POST") { const a = postAnswer(r); const status = a.status ?? 200; return { ok: status < 300, status, json: async () => a.body }; }
  const body = r.url.startsWith("/ui/accounts") ? view : r.url === "/ui/host-install" ? { install: run } : { login: null, targets: [] };
  return { ok: true, status: 200, json: async () => body };
};
const RUN = (over: Record<string, unknown> = {}) => ({ id: "u".repeat(32), backend: "grok", mode: "update", fromVersion: "1.0.70", targetVersion: "1.0.77", phase: "running", startedOn: "Firefox on Linux", startedAt: 1, endedAt: null, lines: [], exitCode: null, verified: null, version: null, signIn: false, cleanupFailed: false, ...over });

let p: AppPage, A: any, S: any, HI: any, i18n: any, shell: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  shell = await import("/assets/app-shell.js"); i18n = await import("/assets/app-i18n.js");
  S = await import("/ui/js/backend-signin.js");
  HI = await import("/ui/js/host-install.js");
  A = await import("/ui/js/accounts-view.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount(); i18n.setLang("en", { store: false });
  view = { clis: [CLAUDE_NPM] }; run = null; reqs = []; postAnswer = () => ({ body: {} });
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  HI.hostInstallStore.set({ loaded: false, run: null, dismissed: [], starting: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); shell.shellStore.set({ dialog: null });
  document.body?.removeAttribute?.("data-public-link");
});
async function mount() { await p.mount(h(A.AccountsView, { instances: {}, stageAgent: () => {}, stageDefault: () => {} })); await settle(8); }
const card = (b: string) => p.root.querySelector(`.s-account-card[data-backend="${b}"]`);
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const updateBtn = (b: string) => card(b)?.querySelectorAll("button").find((x: any) => /^(Update to |Updating|更新)/.test(x.textContent.trim()));
const line = (b: string) => card(b)?.querySelector(".s-account-version");
const post = () => reqs.filter(r => r.method === "POST");
const disabled = (el: any) => !!(el?.disabled ?? el?.hasAttribute?.("disabled"));

const NRUN = (over: Record<string, unknown> = {}) => ({ id: "n".repeat(32), backend: "claude-code", mode: "native", fromVersion: "2.1.325", targetVersion: "2.1.325", latest: false, phase: "ok", startedOn: "Firefox on Linux", startedAt: 1, endedAt: 2, lines: [], exitCode: null, verified: true, version: "2.1.325", signIn: false, reached: true, cleanupFailed: false, claude: null, ...over });
const btn = (re: RegExp) => card("claude-code")?.querySelectorAll("button").find((x: any) => re.test(x.textContent.trim()));

describe("M-3307: switch an npm-global Claude Code to the native install", () => {
  it("the card says it is an npm install, why that matters, and offers the switch; pressing it posts only the CLI's id to its route", async () => {
    await mount();
    const offer = card("claude-code")?.querySelector("[data-native-offer]");
    expect(text(offer)).toContain(NPM);
    expect(text(offer)).toContain("half-installed");
    const b = btn(/^Switch to native install$/);
    expect(b).toBeTruthy();
    postAnswer = () => ({ body: { install: NRUN({ phase: "running" }) } });
    fire(b, "click"); await settle(8);
    expect(post()).toEqual([{ method: "POST", url: "/ui/host-native-switch", body: { backend: "claude-code" } }]);
  });

  it("no offer on a native or unknown install", async () => {
    view = { clis: [{ ...CLAUDE_NPM, rows: [{ ...CLAUDE_NPM.rows[0], nativeSwitch: undefined }] }] };
    await mount();
    expect(card("claude-code")?.querySelector("[data-native-offer]")).toBeFalsy();
    expect(btn(/^Switch to native install$/)).toBeFalsy();
  });

  it("switched, npm copy left: says where claude runs now, and offers the removal with what it removes; pressing it posts to its own route", async () => {
    run = NRUN({ claude: { kind: "native", path: "/home/u/.local/share/claude/versions/2.1.325", npmLeftover: NPM } });
    await mount();
    expect(text(card("claude-code"))).toContain("`claude` now runs from Claude's native install: /home/u/.local/share/claude/versions/2.1.325 (2.1.325).");
    const left = card("claude-code")?.querySelector("[data-npm-left]");
    expect(text(left)).toContain(NPM);
    expect(text(left)).toContain("npm -g uninstall @anthropic-ai/claude-code");
    postAnswer = () => ({ body: { install: NRUN({ mode: "remove-npm", phase: "running" }) } });
    fire(btn(/^Remove the npm copy$/), "click"); await settle(8);
    expect(post()).toEqual([{ method: "POST", url: "/ui/host-npm-remove", body: { backend: "claude-code" } }]);
  });

  it("the native installer finished but npm still comes first on PATH: a warning that the removal finishes the switch", async () => {
    run = NRUN({ claude: { kind: "npm-global", path: `${NPM}/bin/claude.exe`, npmLeftover: NPM } });
    await mount();
    expect(text(card("claude-code"))).toContain("still runs the npm copy");
    expect(btn(/^Remove the npm copy$/)).toBeTruthy();
  });

  it("removed: says so and where claude runs; a copy npm could not remove says so", async () => {
    run = NRUN({ mode: "remove-npm", claude: { kind: "native", path: "/home/u/.local/share/claude/versions/2.1.325", npmLeftover: null } });
    await mount();
    expect(text(card("claude-code"))).toContain("The npm copy was removed.");
    expect(btn(/^Remove the npm copy$/)).toBeFalsy();
    await p.unmount();
    run = NRUN({ mode: "remove-npm", claude: { kind: "native", path: "/x", npmLeftover: NPM } });
    HI.hostInstallStore.set({ loaded: false, run: null, dismissed: [], starting: null });
    await mount();
    expect(text(card("claude-code"))).toContain("the npm copy is still at");
  });

  it("zh-TW: the offer and the buttons in Chinese, no raw key", async () => {
    i18n.setLang("zh-TW", { store: false });
    run = NRUN({ claude: { kind: "native", path: "/p", npmLeftover: NPM } });
    await mount();
    const all = text(card("claude-code"));
    expect(all).toContain("Claude Code 是用 npm 安裝的");
    expect(all).toContain("移除 npm 那份");
    expect(all).not.toMatch(/hostinstall\./);
  });
});
