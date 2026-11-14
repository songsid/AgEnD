/**
 * M-3115 PR 3 (phone v2): on a phone, past 70% the context hint is one thin line in the status line's place — the words,
 * 壓縮 / 清空… as text, and ✕ that puts it away for this tab's session — and 最新 is a small round button floating at the
 * thread's bottom right (no count on it: the user, before 2.4.0-beta.3), not a row across the screen. A desk is unchanged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire, installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
const calls: Array<{ path: string; body: any }> = [];
const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" });
let chat: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const dom = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  // @ts-expect-error — a JS module of the app, with no types
  chat = await import("../src/ui/panel-chat.js");
  chat.boot({ stream: { on() {} }, boot: null, deps: { fetch: (path: string, init: any = {}) => { calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    return path === "/ui/command" ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" }) : new Promise(() => {}); } } });
  dom.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } calls.length = 0; });
const PANELS = () => new Map<string, any>([["chat", { load: async () => chat.ChatPanel }],
  ...["view", "fleet", "settings", "needs", "details", "log"].map((k) => [k, { Component: () => h("div", { class: `stub-${k}` }, k) }] as [string, any])]);
async function app({ narrow = true, pct = 74, storage = {} as Record<string, string> } = {}) {
  const pg = page({ url: "http://127.0.0.1:19280/ui/chat/web-dev", storage: { agend_tour_done: "1", ...storage }, matchNarrow: narrow });
  mounted.push(pg);
  (globalThis as any).fetch = fakeFetch;
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: [{ name: "web-dev", status: "running", backend: "claude-code", model: "opus", context_pct: pct }] });
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(8);
  return pg;
}
const $ = (pg: AppPage, sel: string) => pg.root.querySelector(`.p-chat ${sel}`) as any;

describe("M-3115 PR 3: the context hint as one line with ✕ (phone)", () => {
  it("≥70% on a phone: the line, its words, 壓縮 / 清空… and ✕; 壓縮 runs /compact", async () => {
    const pg = await app();
    const line = $(pg, ".quick-actions");
    expect([line.className, line.querySelector(".qa-ctx").textContent, [...line.querySelectorAll(".btn")].map((b: any) => b.getAttribute("aria-label") || b.textContent)])
      .toEqual(["quick-actions qa-line", "Context 74% used", ["Compact", "Clear…", "Hide this for now"]]);
    fire([...line.querySelectorAll(".btn")][0], "click"); await settle(4);
    expect(calls.some((c) => c.path === "/ui/command" && c.body?.command === "compact")).toBe(true);
  });

  it("✕ puts it away for this tab's session: gone now, and still gone on the next page of this tab", async () => {
    const pg = await app();
    fire($(pg, ".qa-dismiss"), "click"); await settle(4);
    expect([$(pg, ".quick-actions"), (globalThis as any).sessionStorage.getItem("agend_ctx_hint_hidden:web-dev")]).toEqual([null, "1"]);
    expect($(pg, ".ctx-ring")?.className, "the ring still says it").toBe("ctx-ring warn");
    for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
    const again = await app({ storage: {} });
    (globalThis as any).sessionStorage.setItem("agend_ctx_hint_hidden:web-dev", "1");   // this tab's session (a fresh page's store)
    const { applyStatus } = await import("/assets/app-store.js");
    applyStatus({ instances: [{ name: "web-dev", status: "running", backend: "claude-code", model: "opus", context_pct: 76 }] }); await settle(5);
    expect($(again, ".quick-actions")).toBeNull();
  });

  it("under 70%: no line; a desk: today's row with no ✕ (and ✕ is never a desk's)", async () => {
    expect($(await app({ pct: 69 }), ".quick-actions")).toBeNull();
    for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
    const desk = await app({ narrow: false });
    expect([$(desk, ".quick-actions")?.className, $(desk, ".qa-dismiss")]).toEqual(["quick-actions", null]);
  });

  it("the CSS: the line takes the idle strip's place (the working line takes it back), 22 px; 最新 a round button at the right, no badge", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/shared/app.css"), "utf8");
    const bar = readFileSync(join(process.cwd(), "src/ui/shared/chat-work-bar.css"), "utf8");   // fresh-linked: an older app.css still gets it
    for (const rule of [".p-chat .dock:has(.qa-line) .work-bar.idle { display: none; }", ".p-chat .dock:has(.work-bar:not(.idle)) .qa-line { display: none; }"]) expect(bar).toContain(rule);
    expect(css).toContain(".jump-count { display: none; }");   // a tab on an older panel-chat.js: its count stays hidden
    expect(bar).toMatch(/\.p-chat \.quick-actions\.qa-line \{ height: 22px;/);
    expect(bar).toMatch(/\.p-chat \.qa-line \.btn \{ min-height: var\(--tap\); min-width: var\(--tap\); height: var\(--tap\); margin-block: calc\(\(22px - var\(--tap\)\) \/ 2\)/);
    const picker = readFileSync(join(process.cwd(), "src/ui/shared/model-picker.css"), "utf8");
    expect(picker).toMatch(/\.p-chat \.jump-latest \{ left: auto; right: var\(--s-3\); transform: none; width: var\(--tap\); height: var\(--tap\)/);
    expect(picker, "no count badge on a phone (the user, before beta.3)").not.toMatch(/jump-count/);
    expect(picker).not.toMatch(/\.p-chat \.jump-dock \{ position: static/);   // no row of its own across the screen
  });
});
