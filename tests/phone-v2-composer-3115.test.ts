/**
 * M-3115 PR 2 (phone v2): on a phone the composer is one row — ＋, the box, the context's ring (from 50%; amber from 70%),
 * one model · effort picker, Send — and while the agent works with nothing typed, Send is Stop. The working bar is a
 * thin status line whose small 「停止」 shows only once something is typed. The phone's old row of backend / model chips
 * is gone (the backend stays in Details). A desk is unchanged.
 * The real Shell, router, store and chat panel; the chat store's requests are recorded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire, installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
const calls: Array<{ method: string; path: string; body: any }> = [];
const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" });
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
async function app(inst: Record<string, unknown> = {}, { narrow = true } = {}) {
  const pg = page({ url: "http://127.0.0.1:19280/ui/chat/web-dev", storage: { agend_tour_done: "1" }, matchNarrow: narrow });
  mounted.push(pg);
  (globalThis as any).fetch = fakeFetch;
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: [{ ...base, ...inst }] });
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(8);
  return { pg, status: async (o: Record<string, unknown>) => { applyStatus({ instances: [{ ...base, ...inst, ...o }] }); await settle(5); } };
}
const $ = (pg: AppPage, sel: string) => pg.root.querySelector(`.p-chat ${sel}`) as any;
const type = async (pg: AppPage, text: string) => { const box = $(pg, "#msgIn"); box.value = text; fire(box, "input"); await settle(4); };

describe("M-3115 PR 2: one composer row on a phone", () => {
  it("the row: ＋, the box, the picker (model · effort), Send — in that order; no ring under 50%; no chip row", async () => {
    const { pg } = await app();
    const row = $(pg, ".composer");
    const kinds = [...row.children].filter((n: any) => n.tagName !== "INPUT").map((n: any) => n.id || n.className.split(" ")[0]);
    expect(kinds).toEqual(["attachBtn", "composer-field", "composer-tools", "sendBtn"]);
    // The row shows the model (the box keeps its room); its name says the effort too.
    expect([$(pg, ".composer-pick b").textContent, $(pg, ".composer-pick .pick-effort"), $(pg, ".composer-pick").getAttribute("aria-label"), $(pg, ".ctx-ring"), $(pg, ".model-entry-row")])
      .toEqual(["Opus", null, "Model: Opus · High — choose another", null, null]);
  });

  it("the picker opens /model; the ring from 50% (amber from 70%) opens /ctx", async () => {
    const { pg, status } = await app();
    fire($(pg, ".composer-pick"), "click"); await settle(4);
    expect(calls.some((c) => c.path === "/ui/command" && c.body?.command === "model")).toBe(true);
    await status({ context_pct: 55 });
    expect([$(pg, ".ctx-ring")?.className, $(pg, ".ctx-pct")?.textContent, $(pg, ".ctx-ring")?.getAttribute("aria-label")]).toEqual(["ctx-ring", "55", "Context 55% used"]);
    await status({ context_pct: 74 });
    expect($(pg, ".ctx-ring").className).toBe("ctx-ring warn");
    fire($(pg, ".ctx-ring"), "click"); await settle(4);
    expect(calls.some((c) => c.path === "/ui/command" && c.body?.command === "ctx")).toBe(true);
  });

  it("working with nothing typed: Send is Stop (it stops the reply); typing makes it Send again", async () => {
    const { pg } = await app({ execution_state: "working" });
    const send = () => $(pg, "#sendBtn");
    expect([send().className.includes("is-stop"), send().getAttribute("aria-label"), send().disabled]).toEqual([true, "Stop reply", false]);
    fire(send(), "click"); await settle(4);
    expect(calls.some((c) => c.method === "POST" && c.path === "/ui/cancel/web-dev")).toBe(true);
    await type(pg, "only the first part");
    expect([send().className.includes("is-stop"), send().getAttribute("aria-label")]).toEqual([false, "Send"]);
    expect(pg.root.querySelector(".p-chat .work-bar .btn-stop"), "the status line's 停止 (CSS shows it now)").toBeTruthy();
  });

  it("a desk: no tools beside the box, and Send never turns into Stop (Stop stays in the working bar)", async () => {
    const { pg } = await app({ execution_state: "working", context_pct: 80 }, { narrow: false });
    expect([$(pg, ".composer-tools"), $(pg, "#sendBtn").className.includes("is-stop"), $(pg, "#sendBtn").getAttribute("aria-label")]).toEqual([null, false, "Send"]);
    expect($(pg, ".work-bar .btn-stop")).toBeTruthy();
  });

  it("the CSS: the phone's thin status line, its Stop only with something typed (a tap target drawn as text); the row's tap targets", () => {
    const bar = readFileSync(join(process.cwd(), "src/ui/shared/chat-work-bar.css"), "utf8");
    for (const rule of [".p-chat .work-bar { block-size: 22px; min-block-size: 22px; max-block-size: 22px; overflow: visible; }",
      ".p-chat .dock:has(.composer-field textarea:placeholder-shown) .work-bar .btn-stop { display: none; }",
      ]) expect(bar).toContain(rule);
    // In the fresh-linked file (a tab on an older app.css gets them too), with Send-as-Stop's size.
    expect(bar).toMatch(/\.ctx-ring \{[^}]*min-width: var\(--tap\); min-height: var\(--tap\)/);
    expect(bar).toMatch(/\.composer-pick \{[^}]*min-height: var\(--tap\)/);
    expect(bar).toContain(".p-chat .composer .btn-send { width: var(--tap); min-width: var(--tap); min-height: var(--tap); }");
    expect(bar).toContain(".p-chat .work-bar .btn-stop { min-height: var(--tap); min-width: var(--tap); height: var(--tap); margin-block: calc((22px - var(--tap)) / 2);");
    expect(readFileSync(join(process.cwd(), "src/ui/shared/app.css"), "utf8")).not.toMatch(/\.composer-pick|\.ctx-ring/);
  });
});
