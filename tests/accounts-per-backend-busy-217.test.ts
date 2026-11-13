/**
 * AGEND-217 (PR #62): Settings → Agents → Accounts disables a button only for the AI whose sign-in or install is running — the login window is one PER BACKEND on the server
 * (login-window-lock.ts), so a Claude Code sign-in no longer holds Grok's Connect. The real accounts-view over faked /ui/accounts, /ui/backend-login, /ui/browser-backend-signins and /ui/host-install.
 * - A structured Claude Code sign-in running (this tab's or another's): its Connect / Sign out buttons wait; Grok's Connect is pressable.
 * - A terminal sign-in running: its own backend's buttons wait, the others' do not.
 * - An install running: the other Install buttons wait (one installer on the host), but another AI's Connect does not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const row = (backend: string, state: string, extra: Record<string, unknown> = {}) => ({ scope: { kind: "host" }, backend, profile: null, state, signIn: true, usedBy: { agents: [], classic: [], fleetDefault: true }, ...extra });
const CLAUDE = { backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [row("claude-code", "usable")] };
const GROK = { backend: "grok", profiles: false, installed: true, fleetDefault: null, agents: [], rows: [row("grok", "not_signed_in")] };
const CODEX = { backend: "codex", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [row("codex", "not_signed_in")] };
const GEMINI = { backend: "gemini-cli", profiles: false, installed: false, fleetDefault: null, agents: [], rows: [row("gemini-cli", "not_installed", { signIn: false, install: "curl … | sh" })] };
const OPENCODE = { backend: "opencode", profiles: false, installed: false, installOnly: true, fleetDefault: null, agents: [], rows: [row("opencode", "not_installed", { signIn: false, install: "curl … | sh" })] };
let view: any = { clis: [CLAUDE, GROK, CODEX, GEMINI, OPENCODE] };
let controller: any = null, structured: any = null, install: any = null;
const fetchFake = async (url: string) => {
  const u = String(url);
  const body = u.startsWith("/ui/accounts") ? view : u === "/ui/host-install" ? { install } : u.startsWith("/ui/browser-backend-signins") ? structured : { login: controller, targets: [] };
  return { ok: true, status: 200, json: async () => body };
};
const SNAP = (login: unknown) => ({ selected: ["claude-code", "grok"], pending: [], skipped: [], states: {}, login, ready: false });
const STRUCT = (over: Record<string, unknown> = {}) => ({ id: "s".repeat(32), backend: "claude-code", revision: 1, phase: "code", mine: true, ...over });
const CTRL = (over: Record<string, unknown> = {}) => ({ id: "c".repeat(32), backend: "grok", phase: "running", ok: null, startedOn: "Firefox on Linux", startedAt: 1, endedAt: null, mine: true, ...over });
const RUN = (over: Record<string, unknown> = {}) => ({ id: "r".repeat(32), backend: "gemini-cli", phase: "running", startedOn: "Firefox on Linux", startedAt: 1, endedAt: null, lines: [], exitCode: null, verified: null, version: null, signIn: false, cleanupFailed: false, ...over });

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
  view = { clis: [CLAUDE, GROK, CODEX, GEMINI, OPENCODE] }; controller = null; structured = null; install = null;
  A.accountsStore.set({ loaded: false, failed: false, view: null });
  HI.hostInstallStore.set({ loaded: false, run: null, dismissed: [], starting: null });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null }); shell.shellStore.set({ dialog: null });
});
async function mount() { await p.mount(h(A.AccountsView, { instances: {}, stageAgent: () => {}, stageDefault: () => {} })); await settle(8); }
const card = (b: string) => p.root.querySelector(`.s-account-card[data-backend="${b}"]`);
const btn = (b: string, label: RegExp) => card(b)?.querySelectorAll("button").find((x: any) => label.test(x.textContent.trim()));
const off = (el: any) => !!el && (el.disabled === true || el.getAttribute("disabled") !== null);   // present and disabled: a missing button is not "disabled"
const connect = (b: string) => btn(b, /^Connect$|^Reconnect$/);
const signOut = (b: string) => card(b)?.querySelector(".s-account-signout");

describe("a sign-in on one AI holds only that AI's buttons", () => {
  it("nothing running: every Connect is pressable (the checks below are not vacuous)", async () => {
    await mount();
    expect(off(connect("claude-code"))).toBe(false); expect(off(connect("grok"))).toBe(false); expect(off(connect("codex"))).toBe(false);
  });
  it("Claude Code's structured sign-in running: its Connect and Sign out wait; Grok's and Codex's Connect do not", async () => {
    structured = SNAP(STRUCT());
    await mount();
    expect(off(connect("claude-code"))).toBe(true);
    expect(off(signOut("claude-code"))).toBe(true);
    expect(off(connect("grok"))).toBe(false);
    expect(off(connect("codex"))).toBe(false);
  });
  it("the same when the sign-in is another tab's (not mine)", async () => {
    structured = SNAP(STRUCT({ mine: false }));
    await mount();
    expect(off(connect("claude-code"))).toBe(true);
    expect(off(connect("grok"))).toBe(false);
  });
  it("a structured sign-in that has ended (done, or failed with its reason) holds nothing", async () => {
    structured = SNAP(STRUCT({ phase: "done" }));
    await mount();
    expect(off(connect("claude-code"))).toBe(false);
    await p.unmount();
    structured = SNAP(STRUCT({ phase: "failed", reason: "cancelled" }));
    await mount();
    expect(off(connect("claude-code"))).toBe(false);
  });
  it("Grok's terminal sign-in (also another tab's) running: Grok's Connect waits; Claude Code's does not", async () => {
    controller = CTRL({ mine: false });
    await mount();
    expect(off(connect("grok"))).toBe(true);
    expect(off(connect("claude-code"))).toBe(false);
    expect(off(signOut("claude-code"))).toBe(false);
  });
  it("both running at once: each holds its own AI, and Codex is still free", async () => {
    structured = SNAP(STRUCT()); controller = CTRL();
    await mount();
    expect(off(connect("claude-code"))).toBe(true); expect(off(connect("grok"))).toBe(true);
    expect(off(connect("codex"))).toBe(false);
  });
  it("pressing Grok's Connect while Claude Code's sign-in runs opens Grok's dialog", async () => {
    structured = SNAP(STRUCT());
    await mount();
    expect(off(connect("grok"))).toBe(false);
    connect("grok").click();
    await settle(4);
    const dialog = shell.shellStore.get().dialog;
    expect(dialog && dialog.props).toMatchObject({ backend: "grok" });
  });
});

describe("an install is one on the host, but holds only its own AI's sign-in", () => {
  it("Gemini's install running: Gemini and OpenCode Install wait (one installer), Claude Code's and Grok's Connect do not", async () => {
    install = RUN();
    await mount();
    expect(off(btn("gemini-cli", /Install/))).toBe(true);
    expect(off(btn("opencode", /^Install$/))).toBe(true);
    expect(off(connect("claude-code"))).toBe(false);
    expect(off(connect("grok"))).toBe(false);
  });
  it("a sign-in running does not hold any Install button (another AI's installer window is free)", async () => {
    structured = SNAP(STRUCT());
    await mount();
    expect(off(btn("gemini-cli", /^Install$/))).toBe(false);
    expect(off(btn("opencode", /^Install$/))).toBe(false);
  });
  it("an install of an AI that is signed in holds that AI's Connect", async () => {
    install = RUN({ backend: "grok", mode: "update" });
    await mount();
    expect(off(connect("grok"))).toBe(true);
    expect(off(connect("claude-code"))).toBe(false);
  });
});
