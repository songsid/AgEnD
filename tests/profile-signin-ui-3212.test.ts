/**
 * #3212: a NAMED Claude account is signed in with the same dialog as the default account — press Sign in, open the provider's page, paste the code back — and not
 * the old web-terminal flow (a temporary public link, a terminal page, a one-time access code). The real modules on the mini DOM with a recording fetch; nothing
 * reaches a server.
 */
import { readFileSync } from "node:fs";
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

const ENDPOINT = "/ui/browser-backend-signins?backend=claude-code&profile=CHY";
const DEFAULT_ENDPOINT = "/ui/browser-backend-signins";
const AUTH_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
const snapshot = (over: Record<string, unknown> = {}) => ({ selected: ["claude-code"], pending: ["claude-code"], skipped: [], states: { "claude-code": "invalid" }, login: null, ready: false,
  target: { backend: "claude-code", profile: "CHY" }, ...over });
const waitingForCode = { id: "a".repeat(32), backend: "claude-code", revision: 3, phase: "code", mine: true, canAct: true, url: AUTH_URL };

let p: AppPage;
let S: any, shell: any, i18n: any, C: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agent", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  (globalThis as any).navigator.clipboard = { writeText: async () => {} };
  shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js");
  S = await import("/ui/js/backend-signin.js");
  C = await import("/assets/ui-confirm.js");
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
const open = async (props: Record<string, unknown>) => { await p.mount(h(S.BrowserSignInDialog, props)); await settle(8); };
/** The cards set `onclick` on their buttons (structured-signin.js); the dialog's own buttons are Preact's (`fire`). */
const press = async (label: string) => { const b = btn(label) as any; expect(b, label).toBeDefined(); await b.onclick(); await settle(8); };
/** What the dialog does when it is closed: the shell takes it off the page (its effects' cleanup runs), as `closeDialog` does. */
const closing = () => async () => { await p.unmount(); };

describe("openSignIn routes a named account to the same dialog as the default one", () => {
  it("claude-code with a profile → BrowserSignInDialog with the name; kiro/codex profiles (never signed in from the dashboard) keep the older dialog that names the command", () => {
    S.openSignIn({ backend: "claude-code", profile: "CHY" });
    expect(shell.shellStore.get().dialog.Component).toBe(S.BrowserSignInDialog);
    expect(shell.shellStore.get().dialog.props).toEqual({ backend: "claude-code", profile: "CHY" });
    for (const backend of ["kiro-cli", "codex"]) {
      S.openSignIn({ backend, profile: "CHY" });
      expect(shell.shellStore.get().dialog.Component, backend).toBe(S.SignInDialog);
      expect(shell.shellStore.get().dialog.props).toEqual({ backend, profile: "CHY" });
    }
  });
  it("the default account is unchanged: no profile in the props", () => {
    S.openSignIn({ backend: "claude-code" });
    expect(shell.shellStore.get().dialog.Component).toBe(S.BrowserSignInDialog);
    expect(shell.shellStore.get().dialog.props).toEqual({ backend: "claude-code" });
  });
  it("an unknown backend still opens the older dialog", () => {
    S.openSignIn({ backend: "antigravity" });
    expect(shell.shellStore.get().dialog.Component).toBe(S.SignInDialog);
  });
});

const SETUP_ONLY_EN = ["Sign in your AI backends", "no terminal typing", "Check sign-ins", "Sign in later", "You can continue setup"];
const SETUP_ONLY_ZH = ["登入你的 AI 後端", "不需要在終端機輸入", "檢查登入狀態", "稍後登入", "可以繼續設定了"];
const TERMINAL_EN = ["temporary public link", "Open the sign-in terminal", "Access code", "access code"];

describe("the named account's dialog", () => {
  it("reads the account's own endpoint; the title names the account; none of the first-install page's words, and no temporary public link, terminal or access code", async () => {
    answer = r => r.url === ENDPOINT ? snapshot() : {};
    await open({ backend: "claude-code", profile: "CHY" });
    expect(reqs[0]).toMatchObject({ method: "GET", url: ENDPOINT });
    expect(posts(DEFAULT_ENDPOINT), "the default account's controls are not used").toEqual([]);
    expect(p.root.querySelector(".dlg-title").textContent).toBe("Sign in to Claude Code · CHY");
    expect(btn("Sign in")).toBeDefined();
    for (const gone of [...SETUP_ONLY_EN, ...TERMINAL_EN]) expect(text(), gone).not.toContain(gone);
    expect(reqs.filter(r => r.url.startsWith("/ui/backend-login/")), "the terminal flow is not used").toEqual([]);
  });
  it("the buttons are only Sign in (Cancel sign-in while it runs) and Close; the console fallback is a line of small text at the bottom, made of shared classes", async () => {
    answer = r => r.url === ENDPOINT ? snapshot() : {};
    await open({ backend: "claude-code", profile: "CHY" });
    const labels = () => p.root.querySelectorAll("dialog button").map((b: any) => b.textContent.trim()).filter(Boolean);
    expect(labels()).toEqual(["Sign in", "Use console fallback", "Close"]);
    const actions = p.root.querySelector(".signin-browser-actions");
    expect(actions.querySelectorAll("button").map((b: any) => b.textContent.trim()), "the actions row: only Close").toEqual(["Close"]);
    const fallback = btn("Use console fallback") as any;
    expect(fallback.className.split(" ").sort()).toEqual(["btn", "btn-ghost", "btn-sm"]);   // the shared button, its small ghost form: no class of its own
    expect(fallback.parentElement.className).toBe("note");
    // It is below the cards, last in the body.
    const body = p.root.querySelector(".signin-browser").parentElement;
    expect(body.children[body.children.length - 1]).toBe(fallback.parentElement);
  });
  it("the default account's dialog is the same screen: its text equals the named one's once the account's name is swapped, and so are its buttons", async () => {
    answer = r => r.url === DEFAULT_ENDPOINT ? snapshot({ target: undefined }) : {};
    await open({ backend: "claude-code" });
    const defaultText = text(), defaultButtons = p.root.querySelectorAll("dialog button").map((b: any) => b.textContent.trim());
    expect(p.root.querySelector(".dlg-title").textContent).toBe("Sign in to Claude Code · Default sign-in");
    await p.unmount(); reqs = [];
    answer = r => r.url === ENDPOINT ? snapshot() : {};
    await open({ backend: "claude-code", profile: "CHY" });
    expect(text()).toBe(defaultText.replace("Default sign-in", "CHY"));
    expect(p.root.querySelectorAll("dialog button").map((b: any) => b.textContent.trim())).toEqual(defaultButtons);
    for (const gone of SETUP_ONLY_EN) expect(defaultText, gone).not.toContain(gone);
  });
  it("the default account's dialog shows only ITS backend's card, though its checklist holds others", async () => {
    answer = r => r.url === DEFAULT_ENDPOINT ? { selected: ["kiro-cli", "claude-code", "codex"], pending: ["kiro-cli", "claude-code", "codex"], skipped: [],
      states: { "kiro-cli": "invalid", "claude-code": "invalid", codex: "invalid" }, login: null, ready: false } : {};
    await open({ backend: "claude-code" });
    expect(p.root.querySelectorAll(".signin-browser section").map((e: any) => e.dataset.backend)).toEqual(["claude-code"]);
    expect(text()).not.toMatch(/Kiro|Codex/);
  });
it("Sign in → the link opens the provider's page → the code is pasted back into the dialog: start and input go to the account's endpoint, and only there", async () => {
    let login: any = null;
    answer = r => {
      if (r.url !== ENDPOINT) return {};
      if (r.body?.operation === "start") login = waitingForCode;
      if (r.body?.operation === "input") login = { ...waitingForCode, revision: 4, canAct: false };
      return snapshot({ login });
    };
    await open({ backend: "claude-code", profile: "CHY" });
    await press("Sign in");
    expect(posts(ENDPOINT, "start")[0]!.body).toEqual({ operation: "start", backend: "claude-code", relogin: false });
    const link = p.root.querySelectorAll("a").find((a: any) => a.textContent.includes("Open provider sign-in"));
    expect([link.href, link.target, link.rel]).toEqual([AUTH_URL, "_blank", "noopener noreferrer"]);
    const field = p.root.querySelectorAll("input").find((i: any) => i.type === "password") as any;
    expect(field, "a field for the code").toBeDefined(); field.value = "pasted#code";
    await press("Submit code");
    expect(posts(ENDPOINT, "input")[0]!.body).toEqual({ operation: "input", id: waitingForCode.id, revision: 3, action: { kind: "code", value: "pasted#code" } });
    expect(reqs.filter(r => r.method === "POST" && r.url !== ENDPOINT), "nothing is sent to any other endpoint").toEqual([]);
  });
  it("a signed-in account says so, offers Sign in again, and nothing is written to the default account's controls", async () => {
    answer = r => r.url === ENDPOINT ? snapshot({ states: { "claude-code": "valid" }, pending: [], ready: true }) : {};
    await open({ backend: "claude-code", profile: "CHY" });
    expect(text()).toContain("Signed in ✓"); expect(btn("Sign in again")).toBeDefined();
    expect(posts(DEFAULT_ENDPOINT)).toEqual([]);
  });
});

describe("closing, cancelling and the console fallback end the sign-in", () => {
  it("Close ends the account's sign-in (a cancel to its endpoint) so none is left running to refuse Remove", async () => {
    answer = r => r.url === ENDPOINT ? snapshot({ login: waitingForCode }) : {};
    await open({ backend: "claude-code", profile: "CHY", onClose: closing() });
    reqs = [];
    fire(btn("Close"), "click"); await settle(8);
    expect(posts(ENDPOINT, "cancel")).toHaveLength(1);
    expect(posts(DEFAULT_ENDPOINT)).toEqual([]);
  });
  it("the cancel button inside the cards posts a cancel to the account's endpoint", async () => {
    answer = r => r.url === ENDPOINT ? snapshot({ login: waitingForCode }) : {};
    await open({ backend: "claude-code", profile: "CHY" });
    await press("Cancel sign-in");
    expect(posts(ENDPOINT, "cancel").length).toBeGreaterThanOrEqual(1);
    expect(posts(DEFAULT_ENDPOINT)).toEqual([]);
  });
  it("the default account's dialog keeps its behaviour: closing it does not cancel", async () => {
    answer = r => r.url === DEFAULT_ENDPOINT ? snapshot({ target: undefined, login: waitingForCode }) : {};
    await open({ backend: "claude-code", onClose: closing() });
    reqs = [];
    fire(btn("Close"), "click"); await settle(8);
    expect(reqs.filter(r => r.method === "POST")).toEqual([]);
  });
  it("Use console fallback ends the sign-in at the account's endpoint, then opens the older dialog for the SAME account", async () => {
    answer = r => r.url === ENDPOINT ? snapshot() : {};
    await open({ backend: "claude-code", profile: "CHY" });
    fire(btn("Use console fallback"), "click"); await settle(8);
    expect(posts(ENDPOINT, "cancel").length).toBeGreaterThanOrEqual(1);
    expect(shell.shellStore.get().dialog.Component).toBe(S.SignInDialog);
    expect(shell.shellStore.get().dialog.props).toEqual({ backend: "claude-code", profile: "CHY" });
  });
});

describe("Sign in again asks in the app's own dialog (#3321 S01's words, for a named account too)", () => {
  const valid = (backend: string, extra: Record<string, unknown> = {}) => ({ selected: [backend], pending: [], skipped: [], states: { [backend]: "valid" }, login: null, ready: true, ...extra });
  const ask = async (props: Record<string, unknown>, snap: unknown) => {
    (globalThis as any).confirm = undefined;   // the harness answers questions through confirm() while it is a function; undefined = the app's dialog is the only way to ask (a browser confirm() would throw)
    answer = () => snap;
    await open(props);
    const again = btn(i18n.lang() === "zh-TW" ? "重新登入" : "Sign in again") as any; expect(again, "Sign in again").toBeDefined();
    const pending = again.onclick(); await settle(6);
    return { pending, question: C.confirmStore.get().queue[0] };
  };
  const finish = async (pending: Promise<void>, id: number, yes: boolean) => { C.answerConfirm(id, yes); await pending; await settle(6); };
  it("Claude Code (named): the in-app question names Claude Code and does not mention Kiro; No sends nothing; Yes starts it with relogin, at the account's endpoint", async () => {
    const { pending, question } = await ask({ backend: "claude-code", profile: "CHY" }, valid("claude-code", { target: { backend: "claude-code", profile: "CHY" } }));
    expect(question.message).toBe("Sign in to Claude Code again? The new sign-in replaces the account it uses now."); expect(question.message).not.toMatch(/Kiro/i);
    expect(question.title).toBe("Sign in to Claude Code again"); expect(question.confirmLabel).toBe("Sign in again");   // the title names the CLI, the button says what it does
    await finish(pending, question.id, false);
    expect(posts(ENDPOINT, "start")).toEqual([]);
    const second = await (async () => { const again = btn("Sign in again") as any; const pend = again.onclick(); await settle(6); return { pend, q: C.confirmStore.get().queue[0] }; })();
    await finish(second.pend, second.q.id, true);
    expect(posts(ENDPOINT, "start").map(r => r.body)).toEqual([{ operation: "start", backend: "claude-code", relogin: true }]);
  });
  it("Claude Code (default) and Codex: the new sign-in replaces the account; Kiro is the only one that says it signs out first", async () => {
    const claude = await ask({ backend: "claude-code" }, valid("claude-code"));
    expect(claude.question.message).toBe("Sign in to Claude Code again? The new sign-in replaces the account it uses now."); await finish(claude.pending, claude.question.id, false);
    await p.unmount();
    const codex = await ask({ backend: "codex" }, valid("codex"));
    expect(codex.question.message).toBe("Sign in to Codex again? The new sign-in replaces the account it uses now."); await finish(codex.pending, codex.question.id, false);
    await p.unmount();
    const kiro = await ask({ backend: "kiro-cli" }, valid("kiro-cli"));
    expect(kiro.question.message).toBe("Sign in to Kiro again? It signs out its current account first."); await finish(kiro.pending, kiro.question.id, false);
  });
  it("zh-TW", async () => {
    i18n.setLang("zh-TW", { store: false });
    const claude = await ask({ backend: "claude-code", profile: "CHY" }, valid("claude-code", { target: { backend: "claude-code", profile: "CHY" } }));
    expect(claude.question.message).toBe("要重新登入 Claude Code 嗎？新的登入會取代目前使用的帳號。"); expect(claude.question.message).not.toMatch(/Kiro/);
    await finish(claude.pending, claude.question.id, false);
  });
});

describe("zh-TW", () => {
  it("the title names the account (a named one, or 預設登入), and the screen has none of the setup page's or the terminal flow's words", async () => {
    i18n.setLang("zh-TW", { store: false });
    answer = r => r.url === ENDPOINT ? snapshot() : r.url === DEFAULT_ENDPOINT ? snapshot({ target: undefined }) : {};
    await open({ backend: "claude-code", profile: "CHY" });
    expect(p.root.querySelector(".dlg-title").textContent).toBe("登入 Claude Code · CHY");
    for (const gone of ["臨時公開連結", "登入終端機", "存取碼", ...SETUP_ONLY_ZH]) expect(text(), gone).not.toContain(gone);
    expect(btn("改用主控台備援")).toBeDefined();
    await p.unmount();
    await open({ backend: "claude-code" });
    expect(p.root.querySelector(".dlg-title").textContent).toBe("登入 Claude Code · 預設登入");
  });
});

// The style guide's rules for a dialog that carries a user-chosen name: nothing scrolls sideways with a long value (§7), a phone control is the --tap size, and a failed first read is retried (§6).
describe("the dialog's layout rules (docs/design/ui-style-guide.md §6, §7)", () => {
  const css = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8");
  it("a title wraps inside the dialog: a 64-character account name has no space to break at", () => {
    expect(css).toMatch(/^\.dlg-title\s*\{[^}]*overflow-wrap:\s*anywhere/m);
  });
  it("the console-fallback link below the cards is the phone tap size, as the buttons of the cards and of the dialog's footer are", () => {
    const coarse = css.slice(css.indexOf("@media (pointer: coarse), (max-width: 899px) {\n  .signin-browser"));
    expect(coarse.slice(0, coarse.indexOf("}"))).toMatch(/\.signin-browser ~ \.note \.btn[^}]*min-height:\s*var\(--tap\)/);
  });
});
