/**
 * AGEND-203 (dashboard side): connecting Grok said "Your claude-code account is already being connected. Use /login cancel first." — a chat command, on a web page,
 * for a sign-in an earlier dialog had left running.
 *   - A start refused because another sign-in runs shows the plain sentence and a button that ends THAT sign-in (by its backend) and asks again.
 *   - Closing the default account's dialog ends the run THAT dialog started (by its id), as a named account's always did — none is left holding the backend.
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

const CHECK = "/ui/backend-login/check", CANCEL = "/ui/backend-login/cancel", DEFAULT_ENDPOINT = "/ui/browser-backend-signins";
const AUTH_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
const snapshot = (over: Record<string, unknown> = {}) => ({ selected: ["claude-code"], pending: ["claude-code"], skipped: [], states: { "claude-code": "invalid" }, login: null, ready: false, ...over });
const waitingForCode = { id: "a".repeat(32), backend: "claude-code", revision: 3, phase: "code", mine: true, canAct: true, url: AUTH_URL };
const BUSY = { message: "⚠️ Your claude-code account is already being connected. Cancel that connection first, then try again.", busy: { backend: "claude-code" } };
const CONFIRM = { confirm: { id: "b".repeat(32), backend: "grok", tokenPresent: false, logoutFirst: null, publicLink: false, deviceAuth: true, expiresAt: 1 } };

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
  reqs = []; answer = () => ({});
  i18n.setLang("en", { store: false });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null });
  shell.shellStore.set({ dialog: null });
});
const text = () => p.root.textContent.replace(/\s+/g, " ");
const btn = (label: string) => p.root.querySelectorAll("button, a").find((b: any) => b.textContent.trim() === label);
const posts = (url: string, operation?: string) => reqs.filter(r => r.method === "POST" && r.url === url && (!operation || r.body?.operation === operation));
const closing = () => async () => { await p.unmount(); };

describe("a start refused because another sign-in runs (SignInDialog)", () => {
  it("says it in a sentence without the chat command, and offers to cancel THAT sign-in; pressing it cancels by backend and asks again", async () => {
    let asked = 0;
    answer = r => {
      if (r.url === CHECK) return ++asked === 1 ? BUSY : CONFIRM;
      if (r.url === CANCEL) return { message: "🛑 Connecting your claude-code account was cancelled." };
      return {};
    };
    await p.mount(h(S.SignInDialog, { backend: "grok" })); await settle(8);
    expect(text()).toContain("Your claude-code account is already being connected. Cancel that connection first");
    expect(text()).not.toContain("/login");
    expect(btn("Close")).toBeDefined(); expect(btn("Cancel that connection and continue")).toBeDefined();
    fire(btn("Cancel that connection and continue"), "click"); await settle(10);
    expect(posts(CANCEL).map(r => r.body)).toEqual([{ backend: "claude-code" }]);
    expect(posts(CHECK).map(r => r.body)).toEqual([{ backend: "grok" }, { backend: "grok" }]);   // asked again after the cancel
    expect(btn("Connect")).toBeDefined();                                                         // …and now the confirmation
    expect(text()).not.toContain("already being connected");
  });
  it("in Traditional Chinese", async () => {
    i18n.setLang("zh-TW", { store: false });
    // The server's sentence follows the HOST's language; the dialog words it in the page's own.
    answer = r => r.url === CHECK ? BUSY : {};
    await p.mount(h(S.SignInDialog, { backend: "grok" })); await settle(8);
    expect(btn("取消那個連接並繼續")).toBeDefined();
    expect(text()).toContain("正在連接 claude-code 帳號。請先取消那個連接，再重試。");
    expect(text()).not.toContain("already being connected");
    expect(text()).not.toContain("/login");
  });
  it("a refusal that is not 'busy' (not installed, unsupported…) keeps only Close — nothing offers to cancel", async () => {
    answer = r => r.url === CHECK ? { message: "grok is not installed on this machine." } : {};
    await p.mount(h(S.SignInDialog, { backend: "grok" })); await settle(8);
    expect(btn("Close")).toBeDefined(); expect(btn("Cancel that connection and continue")).toBeUndefined();
  });
});

describe("closing the default account's dialog ends the run it started (BrowserSignInDialog)", () => {
  const server = () => {
    let state = snapshot();
    return (r: Req) => {
      if (r.url !== DEFAULT_ENDPOINT) return {};
      if (r.method === "POST" && r.body?.operation === "start") state = snapshot({ login: waitingForCode });
      if (r.method === "POST" && r.body?.operation === "cancel") state = snapshot();
      return state;
    };
  };
  const press = async (label: string) => { const b = btn(label) as any; expect(b, label).toBeDefined(); await b.onclick(); await settle(8); };
  it("Close posts a cancel carrying that run's id — so the backend's window is not held for the ten minutes", async () => {
    answer = server();
    await p.mount(h(S.BrowserSignInDialog, { backend: "claude-code", onClose: closing() })); await settle(8);
    await press("Connect account");
    expect(posts(DEFAULT_ENDPOINT, "start")).toHaveLength(1);
    reqs = [];
    fire(btn("Close"), "click"); await settle(8);
    expect(posts(DEFAULT_ENDPOINT, "cancel").map(r => r.body)).toEqual([{ operation: "cancel", id: waitingForCode.id }]);
  });
  it("a dialog that started nothing ends nothing (a run another tab started is only shown)", async () => {
    answer = r => r.url === DEFAULT_ENDPOINT ? snapshot({ login: waitingForCode }) : {};
    await p.mount(h(S.BrowserSignInDialog, { backend: "claude-code", onClose: closing() })); await settle(8);
    reqs = [];
    fire(btn("Close"), "click"); await settle(8);
    expect(reqs.filter(r => r.method === "POST")).toEqual([]);
  });
  it("the installer's list (several backends) keeps its runs when it closes", async () => {
    answer = server();
    await p.mount(h(S.BrowserSignInDialog, { backends: ["claude-code", "codex"], onClose: closing() })); await settle(8);
    reqs = [];
    fire(btn("Close"), "click"); await settle(8);
    expect(reqs.filter(r => r.method === "POST")).toEqual([]);
  });
});

describe("AGEND-215: with two sign-ins at once, every web cancel names the backend it is for", () => {
  const grokRun = (over: Record<string, unknown> = {}) => ({ id: "c".repeat(32), backend: "grok", phase: "running", mine: true, hint: { url: "https://x.ai/device", code: "ABCD-EFGH", linkable: true }, ...over });
  const claudeStructured = { selected: ["claude-code"], pending: ["claude-code"], skipped: [], states: {}, login: waitingForCode, ready: false };
  it("Cancel sign-in in the Grok dialog ends Grok by name — Claude Code's structured sign-in beside it is not asked to end", async () => {
    answer = r => r.url === CANCEL ? { message: "🛑 Connecting your grok account was cancelled." } : {};
    S.signInStore.set({ loaded: true, login: grokRun(), targets: [], structured: claudeStructured });
    await p.mount(h(S.SignInDialog, { backend: "grok", resume: true, onClose: closing() })); await settle(6);
    reqs = [];
    fire(btn("Cancel connecting"), "click"); await settle(8);
    expect(posts(CANCEL).map(r => r.body)).toEqual([{ backend: "grok" }]);
  });
  it("the same button on a sign-in another session started (not mine) also names its backend", async () => {
    answer = r => r.url === CANCEL ? { message: "ok" } : {};
    S.signInStore.set({ loaded: true, login: grokRun({ mine: false, startedOn: "Other browser" }), targets: [], structured: claudeStructured });
    await p.mount(h(S.SignInDialog, { backend: "grok", resume: true, onClose: closing() })); await settle(6);
    reqs = [];
    fire(btn("Cancel connecting"), "click"); await settle(8);
    expect(posts(CANCEL).map(r => r.body)).toEqual([{ backend: "grok" }]);
  });
  it("a controller sign-in of Claude Code names claude-code, whatever dialog shows it", async () => {
    answer = r => r.url === CANCEL ? { message: "ok" } : {};
    S.signInStore.set({ loaded: true, login: grokRun({ backend: "claude-code" }), targets: [], structured: null });
    await p.mount(h(S.SignInDialog, { backend: "claude-code", resume: true, onClose: closing() })); await settle(6);
    reqs = [];
    fire(btn("Cancel connecting"), "click"); await settle(8);
    expect(posts(CANCEL).map(r => r.body)).toEqual([{ backend: "claude-code" }]);
  });
  it("the Claude Code dialog's console fallback, with no run of its own, ends a structured run on claude-code only — it names the backend", async () => {
    answer = r => r.url === DEFAULT_ENDPOINT ? snapshot({ login: waitingForCode }) : {};
    await p.mount(h(S.BrowserSignInDialog, { backend: "claude-code", onClose: closing() })); await settle(8);
    reqs = [];
    const fallback = p.root.querySelectorAll("button").find((b: any) => /console/i.test(b.textContent)) as any;
    expect(fallback).toBeDefined();
    fire(fallback, "click"); await settle(8);
    expect(posts(DEFAULT_ENDPOINT, "cancel").map(r => r.body)).toEqual([{ operation: "cancel", backend: "claude-code" }]);
  });
});

describe("AGEND-216: the console fallback says what it costs", () => {
  const mountDefault = async () => {
    answer = r => r.url === DEFAULT_ENDPOINT ? snapshot({ login: waitingForCode }) : {};
    await p.mount(h(S.BrowserSignInDialog, { backend: "claude-code", onClose: closing() })); await settle(8);
  };
  it("a single-account dialog carries a plain line under the fallback: it takes the only terminal sign-in, so Grok waits", async () => {
    await mountDefault();
    expect(text()).toContain("Using the console takes the only terminal sign-in. Until it finishes or you cancel it, Grok and any other AI that connects through the terminal has to wait.");
    const note = p.root.querySelectorAll("p").find((n: any) => /only terminal sign-in/.test(n.textContent)) as any;
    expect(note.className).toBe("note");   // the dialog's own hint style, not a one-off
  });
  it("in Traditional Chinese", async () => {
    i18n.setLang("zh-TW", { store: false });
    await mountDefault();
    expect(text()).toContain("改用主控台會佔用唯一的終端登入。在它完成或你取消之前，Grok 和其他走終端登入的 AI 都要等。");
    expect(text()).not.toContain("only terminal sign-in");
  });
  it("the installer's list (several backends) does not carry it", async () => {
    answer = r => r.url === DEFAULT_ENDPOINT ? snapshot() : {};
    await p.mount(h(S.BrowserSignInDialog, { backends: ["claude-code", "codex"], onClose: closing() })); await settle(8);
    expect(text()).not.toContain("only terminal sign-in");
  });
});
