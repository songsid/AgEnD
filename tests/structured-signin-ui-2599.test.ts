import { createContext, runInContext } from "node:vm";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
const source = readFileSync(new URL("../src/ui/structured-signin.js", import.meta.url), "utf8").replace("export function mountStructuredSignIns", "function mountStructuredSignIns");
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
