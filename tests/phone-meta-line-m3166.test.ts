/**
 * M-3166 PR 1 (Argon 0–1, the user's OK of round 2): a phone's meta line above the box, in place of the working bar and of
 * the line under the box. Idle: the model · effort · context, a button that opens /model. Busy: what the agent is doing and
 * for how long · context (a dot, amber while it waits for you or looks stuck); with something typed, Stop. Not verified: the
 * composer's own Authorize (all its states) at the right end. A desk: unchanged (the working bar, the line under the box).
 * The real Shell, router, store and chat panel; the chat store's requests are recorded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire, installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
const calls: Array<{ method: string; path: string; body: any }> = [];
let authAnswer: unknown = null;   // GET /ui/authorization's answer, when a test sets one
const fakeFetch = async (url: string = "") => ({ ok: true, status: 200, json: async () => (String(url).includes("/ui/authorization") && authAnswer ? authAnswer : {}), text: async () => "{}" });
const base = { name: "web-dev", status: "running", backend: "claude-code", model: "opus", effort: "high", context_pct: 42 };
let chat: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const dom = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  // @ts-expect-error — a JS module of the app, with no types
  chat = await import("../src/ui/panel-chat.js");
  chat.boot({ stream: { on() {} }, boot: null, deps: { fetch: (path: string, init: any = {}) => { calls.push({ method: init.method || "GET", path, body: init.body ? JSON.parse(init.body) : null });
    // A command is answered (so the next can start); anything else stays out.
    return path === "/ui/command" ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" }) : new Promise(() => {}); } } });
  dom.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } calls.length = 0; });
const PANELS = () => new Map<string, any>([["chat", { load: async () => chat.ChatPanel }],
  ...["view", "fleet", "settings", "needs", "details", "log"].map((k) => [k, { Component: () => h("div", { class: `stub-${k}` }, k) }] as [string, any])]);
async function app(inst: Record<string, unknown> = {}, { narrow = true, name = "web-dev" } = {}) {
  const pg = page({ url: `http://127.0.0.1:19280/ui/chat/${name}`, storage: { agend_tour_done: "1" }, matchNarrow: narrow });
  mounted.push(pg);
  (globalThis as any).fetch = fakeFetch;
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: [{ ...base, name, ...inst }] });
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(8);
  return { pg, status: async (o: Record<string, unknown>) => { applyStatus({ instances: [{ ...base, name, ...inst, ...o }] }); await settle(5); } };
}
const $ = (pg: AppPage, sel: string) => pg.root.querySelector(`.p-chat ${sel}`) as any;
const type = async (pg: AppPage, text: string) => { const box = $(pg, "#msgIn"); box.value = text; fire(box, "input"); await settle(4); };


describe("M-3166: the meta line (phone)", () => {
  it("idle: model · effort · context as one button that opens /model; no working bar, no line under the box", async () => {
    const { pg } = await app();
    const meta = $(pg, ".chat-meta");
    expect([meta.className, $(pg, ".chat-meta-model").textContent, $(pg, ".work-bar"), $(pg, ".chat-meta-dot")]).toEqual(["chat-meta", "Opus · high · 42%⌄", null, null]);
    fire($(pg, ".chat-meta-model"), "click"); await settle(4);
    expect(calls.some((c) => c.path === "/ui/command" && c.body?.command === "model")).toBe(true);
  });

  it("busy: what it is doing · context, with its dot; waiting for you and stuck say so; Stop only with something typed (CSS)", async () => {
    const working = await app({ execution_state: "working" });
    expect([$(working.pg, ".chat-meta").className, $(working.pg, ".chat-meta-left").textContent.trim(), !!$(working.pg, ".chat-meta-dot"), !!$(working.pg, ".chat-meta-stop"), $(working.pg, ".chat-meta-model")])
      .toEqual(["chat-meta busy working", expect.stringMatching(/^Working( \d+:\d\d)? · 42%$/), true, true, null]);
    fire($(working.pg, ".chat-meta-stop"), "click"); await settle(4);
    expect(calls.some((c) => c.method === "POST" && c.path === "/ui/cancel/web-dev")).toBe(true);
    for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
    const stuck = await app({ execution_state: "stuck" });
    expect([$(stuck.pg, ".chat-meta").className, $(stuck.pg, ".chat-meta-left").textContent.trim()]).toEqual(["chat-meta busy stuck", expect.stringMatching(/^Looks stuck/)]);
    const css = readFileSync(join(process.cwd(), "src/ui/shared/chat-work-bar.css"), "utf8");
    expect(css).toContain(".p-chat .dock:has(.composer-field textarea:placeholder-shown):not(:has(.pending-files)) .chat-meta-stop { display: none; }");   // M-3198
  });

  it("the CSS: 26 px, the small type, hit targets ≥ 32 px; the line under the box goes; five lines at most; files in one strip", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/shared/chat-work-bar.css"), "utf8");
    const at = css.indexOf("M-3166 (Argon 0 and 1");                       // the meta line's own phone block (the sheet's has another)
    const phone = css.slice(css.indexOf("@media (max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px) {", at), css.indexOf("\n}", at));
    for (const rule of [".chat-meta { display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); height: 26px; padding: 0 var(--s-1); font-size: var(--fs-xs);",
      "min-height: 32px; margin: -3px 0;", ".p-chat .dock:has(.chat-meta) .composer-row { display: none; }",
      ".p-chat .composer textarea { max-height: calc(4 * var(--lh-md) + var(--tap)); overflow-y: auto; }", ".p-chat .composer-box .pending-files { flex-wrap: nowrap; overflow-x: auto; }",
      '.chat-meta-right .webauth-row[data-state="verified"] > :not(.webauth-notice) { display: none; }']) expect(phone).toContain(rule);
  });

  // M-3198 (#4001 review P3): an empty text box hides the phone's other Stop only when nothing is waiting to go. With a file
  // attached, Send is Send (the file can go), so Stop must stay — the meta line's, and a guest's working-bar Stop alike.
  it("the CSS: an empty box hides the other Stop only with no file waiting (a files-only draft keeps a Stop)", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/shared/chat-work-bar.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const hides = css.split("\n").filter((l) => /textarea:placeholder-shown\)/.test(l) && /(chat-meta-stop|\.btn-stop) \{ display: none; \}/.test(l));
    expect(hides.length, "the two rules that hide a Stop").toBe(2);
    for (const l of hides) expect(l, l.trim()).toContain(":not(:has(.pending-files))");
  });

  it("not verified: the composer's own Not verified · Authorize at the right end (and nowhere else)", async () => {
    (await import("/assets/web-authorize.js")).resetWebAuthorization();
    authAnswer = { state: "none", reason: "not_authorized" };
    try {
      const { pg } = await app();
      await settle(8);
      const row = $(pg, ".chat-meta-right .webauth-row");
      expect([row?.getAttribute("data-state"), row?.querySelector(".webauth-ask")?.textContent, pg.root.querySelectorAll(".webauth-row").length]).toEqual(["none", "Authorize", 1]);
    } finally { authAnswer = null; (await import("/assets/web-authorize.js")).resetWebAuthorization(); }
  });

  it("a desk: unchanged — the working bar and the line under the box, no meta line", async () => {
    const { pg } = await app({ execution_state: "working" }, { narrow: false });
    expect([$(pg, ".chat-meta"), !!$(pg, ".work-bar"), !!$(pg, ".composer-row")]).toEqual([null, true, true]);
  });
});

 it("M3540: phone meta/status background belongs to the strip while Stop keeps its action", async () => {
  const { pg } = await app({ execution_state: "working" }, { name: "example-meta" });
  const strip = $(pg, ".composer-hit"), meta = $(pg, ".chat-meta"), box = $(pg, "#msgIn");
  expect(meta.closest(".composer-hit")).toBe(strip);
  expect($(pg, ".thread").closest(".composer-hit")).toBeNull();
  pg.root.focus();
  const touch = fire(meta, "pointerdown", { button: 0, pointerType: "touch" });
  expect(touch.defaultPrevented).toBe(false);
  expect(box.ownerDocument.activeElement).toBe(pg.root);
  fire(meta, "click", { button: 0 });
  expect(box.ownerDocument.activeElement).toBe(box);
  pg.root.focus();
  fire($(pg, ".chat-meta-stop"), "click", { button: 0 }); await settle();
  expect(calls.filter(c => c.path === "/ui/cancel/example-meta")).toHaveLength(1);
  expect(box.ownerDocument.activeElement).toBe(pg.root);
 });
