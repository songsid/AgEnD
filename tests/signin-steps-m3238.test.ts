/**
 * M-3238 (the user): in Settings → AI accounts → Connect, the provider's page was a small link and its code a bare line. The
 * account dialog's cards (structured-signin.js) now show numbered steps — 1. Open the sign-in page: a big link that names the
 * page (host and path), with Copy link; 2. Enter this code on that page: the code large, with Copy; 3. Come back here — for
 * every backend's flow: Codex (link and code), Kiro (a method first, then link and code), Claude Code (link, then the code
 * pasted back here: no "come back" step while it waits for that). In English and 繁體中文. The real module, in a VM with a
 * bare DOM (as structured-signin-ui-2599); the dialog around it and a browser are the PR's smoke.
 */
import { createContext, runInContext } from "node:vm";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

const source = readFileSync(new URL("../src/ui/structured-signin.js", import.meta.url), "utf8").replace(/^export /gm, "");

function cards(backend: string, login: Record<string, unknown>, lang = "en") {
  const doc: any = { createElement: (tag: string) => element(tag), getElementById: () => null, documentElement: { lang } };
  function element(tag: string): any {
    return { tag, textContent: "", children: [], dataset: {}, disabled: false, ownerDocument: doc, className: "",
      append(child: any) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute(key: string, value: string) { this[key] = value; } };
  }
  const root = element("main");
  const state = { selected: [backend], pending: [backend], skipped: [], states: { [backend]: "invalid" }, login: { backend, id: "a".repeat(32), revision: 2, ...login }, ready: false };
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => structuredClone(state) }));
  const written: string[] = [];
  const ctx = createContext({ document: doc, fetch: fetcher, setTimeout: () => 1, clearTimeout() {}, URL, navigator: { clipboard: { writeText: async (v: string) => { written.push(v); } } } });
  runInContext(source, ctx);
  ctx.mountStructuredSignIns(root, { endpoint: "/ui/browser-backend-signins", fetcher, dialog: true, dashboard: true, focus: backend });
  const nodes = (): any[] => { const all: any[] = []; const visit = (n: any) => { all.push(n); n.children.forEach(visit); }; visit(root); return all; };
  const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  const of = (cls: string) => nodes().filter((n) => (n.className || "").split(" ").includes(cls));
  const steps = () => (of("signin-steps")[0]?.children ?? []).map((li: any) => li.children.length ? li.children[0].textContent : li.textContent);
  return { nodes, flush, of, steps, written };
}

it("Codex: open the page (a big link naming it, Copy link), enter the code (large, Copy), come back", async () => {
  const c = cards("codex", { phase: "authorization", url: "https://auth.openai.com/codex/device", code: "ABCD-1234", canAct: false });
  await c.flush();
  expect(c.steps()).toEqual(["Open the sign-in page", "Enter this code on that page", "Come back here when you're done. This page updates by itself."]);
  const link = c.of("signin-open")[0];
  expect([link.tag, link.href, link.target, link.rel, link.children[0].textContent]).toEqual(["a", "https://auth.openai.com/codex/device", "_blank", "noopener noreferrer", "auth.openai.com/codex/device"]);
  expect(c.of("signin-code")[0].textContent).toBe("ABCD-1234");
  const copies = c.of("signin-copy");
  expect(copies.map((b: any) => b.textContent)).toEqual(["Copy link", "Copy"]);
  await copies[1].onclick(); await c.flush();
  expect([c.written, copies[1].textContent]).toEqual([["ABCD-1234"], "Copied"]);
});

it("Kiro: after its method, the same steps; Claude Code: the link, then the code pasted back here (no 'come back' yet)", async () => {
  const kiro = cards("kiro-cli", { phase: "authorization", url: "https://view.awsapps.com/start/#/device?user_code=QWER-TYUI", code: "QWER-TYUI", canAct: false });
  await kiro.flush();
  expect(kiro.steps()).toEqual(["Open the sign-in page", "Enter this code on that page", "Come back here when you're done. This page updates by itself."]);
  expect(kiro.of("signin-open")[0].children[0].textContent).toBe("view.awsapps.com/start/");
  const claude = cards("claude-code", { phase: "code", url: "https://claude.ai/oauth/authorize?code=true&client_id=x&state=y", canAct: true });
  await claude.flush();
  expect(claude.steps()).toEqual(["Open the sign-in page"]);
  expect(claude.of("signin-open")[0].children[0].textContent, "the address without its query").toBe("claude.ai/oauth/authorize");
  expect(claude.nodes().some((n) => n.tag === "input"), "the field for the code the page gives").toBe(true);
});

it("never a link for a page that is not https; in Chinese: 開啟登入頁面 / 在那個頁面輸入這組授權碼 / 複製連結", async () => {
  const plain = cards("codex", { phase: "authorization", url: "http://auth.example/device", code: "ABCD-1234", canAct: false });
  await plain.flush();
  expect([plain.of("signin-open").length, plain.steps()]).toEqual([0, ["Enter this code on that page"]]);
  const zh = cards("codex", { phase: "authorization", url: "https://auth.openai.com/codex/device", code: "ABCD-1234", canAct: false }, "zh-TW");
  await zh.flush();
  expect(zh.steps()).toEqual(["開啟登入頁面", "在那個頁面輸入這組授權碼", "完成後回到這裡，這個畫面會自動更新。"]);
  expect(zh.of("signin-copy").map((b: any) => b.textContent)).toEqual(["複製連結", "複製"]);
});
