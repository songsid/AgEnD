import { createContext, runInContext } from "node:vm";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
const source = readFileSync(new URL("../src/ui/structured-signin.js", import.meta.url), "utf8").replace(/^export /gm, "");
afterEach(() => vi.restoreAllMocks());
function browser(options: Record<string, unknown> = {}, init: Record<string, unknown> = {}, nativeConfirm: (message: string) => boolean = () => true) {
  function element(tag: string): any {
    return { tag, textContent: "", children: [], dataset: {}, disabled: false, ownerDocument: doc,
      append(child: any) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute(key: string, value: string) { this[key] = value; } };
  }
  const doc = { createElement: element, getElementById: () => null };
  const root = element("main"), state = { selected: ["kiro-cli", "antigravity"], pending: ["kiro-cli", "antigravity"], skipped: [], states: { "kiro-cli": "invalid", antigravity: "console_only" } as Record<string, string>, login: null as any, ready: false, ...init };
  const fetcher = vi.fn(async (_url: string, options: any) => {
    const data = options.body ? JSON.parse(options.body) : null;
    if (data?.operation === "start") state.login = { backend: "kiro-cli", id: "a".repeat(32), revision: 3, phase: "method", choices: ["builder_id", "github"], canAct: true };
    if (data?.operation === "input") state.login = { ...state.login, revision: 4, canAct: false };
    // As the server answers: only a start that CREATED the run names it (`started`).
    return { ok: true, json: async () => ({ ...structuredClone(state), ...(data?.operation === "start" ? { started: state.login.id } : {}) }) };
  });
  const timers: (() => Promise<void>)[] = [];
  const ctx = createContext({ document: doc, fetch: fetcher, setTimeout: (fn: any) => { timers.push(fn); return 1; }, clearTimeout() {}, URL, confirm: nativeConfirm });
  runInContext(source, ctx);
  const cards = ctx.mountStructuredSignIns(root, { endpoint: "setup/signins", fetcher, ...options });
  const nodes = (): any[] => { const all: any[] = []; const visit = (n: any) => { all.push(n); n.children.forEach(visit); }; visit(root); return all; };
  const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  const click = async (text: string) => { const b = nodes().find(n => n.tag === "button" && n.textContent === text); expect(b, text).toBeDefined(); if (!b.disabled) await b.onclick(); await flush(); };
  const texts = () => nodes().map(n => n.textContent).filter(Boolean);
  return { root, cards, state, fetcher, nodes, click, texts, flush, poll: async () => { await timers.shift()?.(); await flush(); } };
}
it("method controls submit once, show the waiting latch, and never expose an agy launch", async () => {
  const h = browser(); await h.flush();
  await h.click("Connect account"); await h.click("GitHub");
  expect(h.fetcher.mock.calls.filter(([, o]) => o.body && JSON.parse(o.body).operation === "input")).toHaveLength(1);
  expect(h.nodes().some(n => n.textContent.includes("Answer sent."))).toBe(true);
  expect(h.nodes().some(n => n.textContent === "GitHub")).toBe(false);
  expect(h.nodes().filter(n => n.textContent === "Connect account")).toHaveLength(0);
  expect(h.nodes().some(n => n.textContent.includes("explicit console fallback"))).toBe(true);
  h.cards.dispose();
});
it("a failed POST releases controls, uses a safe error, and allows deliberate retry", async () => {
  const h = browser(); await h.flush(); h.fetcher.mockRejectedValueOnce(new Error("secret-like vendor text"));
  await h.click("Connect account");
  expect(h.nodes().some(n => n.role === "alert" && n.textContent.includes("Could not connect the account"))).toBe(true);
  expect(JSON.stringify(h.nodes().map(n => n.textContent))).not.toContain("secret-like");
  expect(h.nodes().find(n => n.textContent === "Connect account").disabled).toBe(false);
  await h.click("Connect account"); expect(h.nodes().some(n => n.textContent === "GitHub")).toBe(true); h.cards.dispose();
});
it("returned code is submitted literally to the closed API and cleared from the input", async () => {
  const h = browser(); await h.flush();
  h.state.login = { backend: "kiro-cli", id: "b".repeat(32), revision: 8, phase: "code", canAct: true };
  await h.poll(); const field = h.nodes().find(n => n.tag === "input"); field.value = "synthetic#code";
  await h.click("Submit authorization code"); expect(field.value).toBe("");
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
  ["kiro-cli", "en", "Reconnect", "Reconnect Kiro? It disconnects its current account first."],
  ["claude-code", "en", "Reconnect", "Reconnect Claude Code? The new connection replaces the account it uses now."],
  ["codex", "en", "Reconnect", "Reconnect Codex? The new connection replaces the account it uses now."],
  ["claude-code", "zh-TW", "重新連接", "要重新連接 Claude Code 嗎？新的連接會取代目前使用的帳號。"],
  ["kiro-cli", "zh-TW", "重新連接", "要重新連接 Kiro 嗎？會先撤銷目前帳號的連接。"],
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
  await h.nodes().find((n) => n.tag === "button" && n.textContent === "Reconnect").onclick(); await h.flush();
  expect([calls, h.asked, h.starts()]).toEqual([[["Reconnect Claude Code? The new connection replaces the account it uses now.", "Claude Code"]], [],
    [{ operation: "start", backend: "claude-code", relogin: true }]]);
  h.cards.dispose();
});

// #3212 (named accounts on this host): Settings → Accounts' dialog draws only what ONE account's sign-in needs (`dashboard` + `dialog`); the first-install page is as it was.
it("the setup page (no `dialog` option) keeps its heading, lead, Check sign-ins, Sign in later and every selected backend's card", async () => {
  const h = browser(); await h.flush();
  expect(h.nodes().find(n => n.tag === "h2")?.textContent).toBe("Connect your AI accounts");
  expect(h.texts().some(t => t.startsWith("Use the controls here"))).toBe(true);
  expect(h.nodes().filter(n => n.tag === "button" && n.textContent === "Check connections")).toHaveLength(1);
  expect(h.nodes().some(n => n.tag === "button" && n.textContent.startsWith("Connect later"))).toBe(true);
  expect(h.nodes().filter(n => n.tag === "section").map(n => n.dataset.backend)).toEqual(["kiro-cli", "antigravity"]);
  h.cards.dispose();
});
it("`dashboard` + `dialog` leave out the heading, lead, Check sign-ins, Sign in later and the setup's \"You can continue\"; `focus` keeps one backend's card", async () => {
  const h = browser({ dashboard: true, dialog: true, focus: "kiro-cli" }, { ready: true }); await h.flush();
  expect(h.nodes().some(n => n.tag === "h2")).toBe(false);
  const all = h.texts().join(" | ");
  for (const gone of ["Connect your AI accounts", "Use the controls here", "Check connections", "Connect later", "You can continue setup"]) expect(all, gone).not.toContain(gone);
  expect(h.nodes().filter(n => n.tag === "section").map(n => n.dataset.backend)).toEqual(["kiro-cli"]);
  expect(h.nodes().filter(n => n.tag === "button").map(n => n.textContent)).toEqual(["Connect account"]);
  h.cards.dispose();
});
it("`dialog`: a read that fails is still said (an alert), and there is still no Check sign-ins (the cards read themselves every second)", async () => {
  const h = browser({ dashboard: true, dialog: true, focus: "kiro-cli" }); await h.flush();
  h.fetcher.mockRejectedValueOnce(new Error("offline")); await h.poll();
  expect(h.nodes().some(n => n.role === "alert")).toBe(true);
  expect(h.nodes().filter(n => n.tag === "button").map(n => n.textContent)).toEqual(["Connect account"]);
  h.cards.dispose();
});

it("`dialog`: a first read that fails leaves nothing to show, so it is said and offered as a retry (Check sign-ins); once it reads, the retry is gone (docs/design/ui-style-guide.md §6)", async () => {
  let failing = true;
  const state = { selected: ["kiro-cli"], pending: ["kiro-cli"], skipped: [], states: { "kiro-cli": "invalid" }, login: null, ready: false };
  const fetcher = vi.fn(async () => { if (failing) throw new Error("offline"); return { ok: true, json: async () => structuredClone(state) }; });
  const h = browser({ dashboard: true, dialog: true, focus: "kiro-cli", fetcher }); await h.flush();
  expect(h.nodes().some(n => n.role === "alert")).toBe(true);
  expect(h.nodes().filter(n => n.tag === "button").map(n => n.textContent)).toEqual(["Check connections"]);
  failing = false; await h.click("Check connections");
  expect(h.nodes().filter(n => n.tag === "button").map(n => n.textContent)).toEqual(["Connect account"]);
  h.cards.dispose();
});

// #3418 review: the account dialog ends, when it closes, exactly the run its own Sign in started — so the cards say which run that was.
it("`started` gets the id of the run a press of Sign in in these cards started — once, and not for what happens after", async () => {
  const seen: string[] = [];
  const h = browser({ dashboard: true, dialog: true, focus: "kiro-cli", started: (id: string) => { seen.push(id); } }); await h.flush();
  expect(seen).toEqual([]);
  await h.click("Connect account");
  expect(seen).toEqual(["a".repeat(32)]);
  await h.click("GitHub");   // an answer to the run's prompt, then more polls: still the one run, announced once
  await h.poll(); await h.poll();
  expect(seen).toEqual(["a".repeat(32)]);
  h.cards.dispose();
});
it("`started` is not called for a run that was already going when the cards were drawn (another session's or tab's), nor for a cancel", async () => {
  const seen: string[] = [];
  const running = { backend: "kiro-cli", id: "b".repeat(32), revision: 5, phase: "method", choices: ["builder_id"], canAct: true };
  const h = browser({ dashboard: true, dialog: true, focus: "kiro-cli", started: (id: string) => { seen.push(id); } }, { login: running }); await h.flush();
  await h.poll();
  await h.click("Cancel connecting");
  expect(seen).toEqual([]);
  h.cards.dispose();
});
