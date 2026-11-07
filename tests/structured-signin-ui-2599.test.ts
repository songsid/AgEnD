import { createContext, runInContext } from "node:vm";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
const source = readFileSync(new URL("../src/ui/structured-signin.js", import.meta.url), "utf8").replace(/^export /gm, "");
afterEach(() => vi.restoreAllMocks());
function browser() {
  function element(tag: string): any {
    return { tag, textContent: "", children: [], dataset: {}, disabled: false, ownerDocument: doc,
      append(child: any) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute(key: string, value: string) { this[key] = value; } };
  }
  const doc = { createElement: element, getElementById: () => null };
  const root = element("main"), state = { selected: ["kiro-cli", "antigravity"], pending: ["kiro-cli", "antigravity"], skipped: [], states: { "kiro-cli": "invalid", antigravity: "console_only" }, login: null as any, ready: false };
  const fetcher = vi.fn(async (_url: string, options: any) => {
    const data = options.body ? JSON.parse(options.body) : null;
    if (data?.operation === "start") state.login = { backend: "kiro-cli", id: "a".repeat(32), revision: 3, phase: "method", choices: ["builder_id", "github"], canAct: true };
    if (data?.operation === "input") state.login = { ...state.login, revision: 4, canAct: false };
    return { ok: true, json: async () => structuredClone(state) };
  });
  const timers: (() => Promise<void>)[] = [];
  const ctx = createContext({ document: doc, fetch: fetcher, setTimeout: (fn: any) => { timers.push(fn); return 1; }, clearTimeout() {}, URL, confirm: () => true });
  runInContext(source, ctx);
  const cards = ctx.mountStructuredSignIns(root, { endpoint: "setup/signins", fetcher });
  const nodes = (): any[] => { const all: any[] = []; const visit = (n: any) => { all.push(n); n.children.forEach(visit); }; visit(root); return all; };
  const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  const click = async (text: string) => { const b = nodes().find(n => n.tag === "button" && n.textContent === text); expect(b, text).toBeDefined(); if (!b.disabled) await b.onclick(); await flush(); };
  return { root, cards, state, fetcher, nodes, click, flush, poll: async () => { await timers.shift()?.(); await flush(); } };
}
it("method controls submit once, show the waiting latch, and never expose an agy launch", async () => {
  const h = browser(); await h.flush();
  await h.click("Sign in"); await h.click("GitHub");
  expect(h.fetcher.mock.calls.filter(([, o]) => o.body && JSON.parse(o.body).operation === "input")).toHaveLength(1);
  expect(h.nodes().some(n => n.textContent.includes("Answer sent."))).toBe(true);
  expect(h.nodes().some(n => n.textContent === "GitHub")).toBe(false);
  expect(h.nodes().filter(n => n.textContent === "Sign in")).toHaveLength(0);
  expect(h.nodes().some(n => n.textContent.includes("explicit console fallback"))).toBe(true);
  h.cards.dispose();
});
it("a failed POST releases controls, uses a safe error, and allows deliberate retry", async () => {
  const h = browser(); await h.flush(); h.fetcher.mockRejectedValueOnce(new Error("secret-like vendor text"));
  await h.click("Sign in");
  expect(h.nodes().some(n => n.role === "alert" && n.textContent.includes("Could not complete"))).toBe(true);
  expect(JSON.stringify(h.nodes().map(n => n.textContent))).not.toContain("secret-like");
  expect(h.nodes().find(n => n.textContent === "Sign in").disabled).toBe(false);
  await h.click("Sign in"); expect(h.nodes().some(n => n.textContent === "GitHub")).toBe(true); h.cards.dispose();
});
it("returned code is submitted literally to the closed API and cleared from the input", async () => {
  const h = browser(); await h.flush();
  h.state.login = { backend: "kiro-cli", id: "b".repeat(32), revision: 8, phase: "code", canAct: true };
  await h.poll(); const field = h.nodes().find(n => n.tag === "input"); field.value = "synthetic#code";
  await h.click("Submit code"); expect(field.value).toBe("");
  const input = h.fetcher.mock.calls.filter(([, o]) => o.body && JSON.parse(o.body).operation === "input")[0];
  expect(JSON.parse(input![1].body)).toMatchObject({ operation: "input", revision: 8, action: { kind: "code", value: "synthetic#code" } }); h.cards.dispose();
});

// Ridge #3321 S01 (P1): Accounts → Claude Code → "Sign in again" asked "Kiro will sign out its existing account first".
// The question names the card's own CLI and says what a sign-in again does to it: only Kiro signs out first (its
// logoutArgv); Claude Code and Codex sign in again over the account they have. Declining sends nothing.
function relogin(backend: string, opts: { lang?: string; ask?: (q: string, cli: string) => Promise<boolean> | boolean; answer?: boolean } = {}) {
  const asked: string[] = [];
  const state = { selected: [backend], pending: [], skipped: [], states: { [backend]: "valid" }, login: null as any, ready: true };
  const fetcher = vi.fn(async (_url: string, options: any) => ({ ok: true, json: async () => structuredClone(state) }));
  function element(tag: string): any {
    return { tag, textContent: "", children: [], dataset: {}, disabled: false, ownerDocument: doc,
      append(child: any) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute(key: string, value: string) { this[key] = value; } };
  }
  const doc = { createElement: element, getElementById: () => null, documentElement: { lang: opts.lang ?? "en" } };
  const root = element("main");
  const ctx = createContext({ document: doc, fetch: fetcher, setTimeout: () => 1, clearTimeout() {}, URL,
    confirm: (q: string) => { asked.push(q); return opts.answer ?? false; } });
  runInContext(source, ctx);
  const cards = ctx.mountStructuredSignIns(root, { endpoint: "setup/signins", fetcher, ...(opts.ask ? { ask: opts.ask } : {}) });
  const nodes = (): any[] => { const all: any[] = []; const visit = (n: any) => { all.push(n); n.children.forEach(visit); }; visit(root); return all; };
  const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  const starts = () => fetcher.mock.calls.map(([, o]) => (o.body ? JSON.parse(o.body) : null)).filter((b) => b?.operation === "start");
  return { asked, cards, nodes, flush, starts };
}
it.each([
  ["kiro-cli", "en", "Sign in again", "Sign in to Kiro again? It signs out its current account first."],
  ["claude-code", "en", "Sign in again", "Sign in to Claude Code again? The new sign-in replaces the account it uses now."],
  ["codex", "en", "Sign in again", "Sign in to Codex again? The new sign-in replaces the account it uses now."],
  ["claude-code", "zh-TW", "重新登入", "要重新登入 Claude Code 嗎？新的登入會取代目前使用的帳號。"],
  ["kiro-cli", "zh-TW", "重新登入", "要重新登入 Kiro 嗎？會先登出目前的帳號。"],
])("Ridge #3321 S01: %s (%s) — Sign in again asks about that CLI, and declining sends nothing", async (backend, lang, label, question) => {
  const h = relogin(backend, { lang, answer: false }); await h.flush();
  const b = h.nodes().find((n) => n.tag === "button" && n.textContent === label); expect(b, label).toBeDefined();
  await b.onclick(); await h.flush();
  expect([h.asked, h.starts()]).toEqual([[question], []]);
  h.cards.dispose();
});
it("Ridge #3321 S01: the dashboard's own confirmation is used when given (with the CLI's name); yes starts the re-login", async () => {
  const calls: [string, string][] = [];
  const h = relogin("claude-code", { ask: async (q, cli) => { calls.push([q, cli]); return true; } }); await h.flush();
  await h.nodes().find((n) => n.tag === "button" && n.textContent === "Sign in again").onclick(); await h.flush();
  expect([calls, h.asked, h.starts()]).toEqual([[["Sign in to Claude Code again? The new sign-in replaces the account it uses now.", "Claude Code"]], [],
    [{ operation: "start", backend: "claude-code", relogin: true }]]);
  h.cards.dispose();
});
