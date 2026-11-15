/**
 * M-3167 (the user's desk at ~920 px): between a phone and a wide desk the header's chips drew under the agent's tabs,
 * and the composer showed the phone's ring and model picker unstyled. Now:
 *   - the composer's ring and model chip are drawn up to 1439 px (COMPOSER_TOOLS_Q), the chip with the model's short name
 *     on a desk (its full name stays its title); the header's chips give way at the same width (chat-work-bar.css);
 *   - which of these the page draws follows the window live (a window resized across a width redraws);
 *   - the ring and the picker are styled outside any media query.
 * The real Shell, router, store and chat panel; matchMedia answers per query.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" });
const base = { name: "web-dev", status: "running", backend: "claude-code", model: "claude-opus-5-5", effort: "high", context_pct: 56 };
let chat: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const dom = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  // @ts-expect-error — a JS module of the app, with no types
  chat = await import("../src/ui/panel-chat.js");
  chat.boot({ stream: { on() {} }, boot: null, deps: { fetch: () => new Promise(() => {}) } });
  dom.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } });
const PANELS = () => new Map<string, any>([["chat", { load: async () => chat.ChatPanel }],
  ...["view", "fleet", "settings", "needs", "details", "log"].map((k) => [k, { Component: () => h("div", { class: `stub-${k}` }, k) }] as [string, any])]);

/** A window `width` px wide: each max-width query matches as a browser's would, and tells its listeners when it changes. */
function windowOf(width: number) {
  const queries = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
  const matches = (q: string, w: number) => { const m = /max-width:\s*(\d+)px/.exec(q); return m ? w <= Number(m[1]) : false; };
  const mm = (q: string) => {
    let e = queries.get(q);
    if (!e) { e = { matches: matches(q, width), listeners: new Set() }; queries.set(q, e); }
    const entry = e;
    return { get matches() { return entry.matches; }, addEventListener: (_: string, f: () => void) => entry.listeners.add(f), removeEventListener: (_: string, f: () => void) => entry.listeners.delete(f) };
  };
  return { mm, resize(w: number) { width = w; for (const [q, e] of queries) { const now = matches(q, w); if (now !== e.matches) { e.matches = now; for (const f of e.listeners) f(); } } } };
}
async function app(width: number) {
  const win = windowOf(width);
  const pg = page({ url: "http://127.0.0.1:19280/ui/chat/web-dev", storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  (globalThis as any).matchMedia = win.mm; (pg.window as any).matchMedia = win.mm;
  (globalThis as any).fetch = fakeFetch;
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: [{ ...base }] });
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(8);
  return { pg, win };
}
const $ = (pg: AppPage, sel: string) => pg.root.querySelector(`.p-chat ${sel}`) as any;

describe("M-3167: one composer between a phone and a wide desk", () => {
  it("at 920 px: the ring and the short model chip (the full name its title); ", async () => {
    const { pg } = await app(920);
    expect([$(pg, ".composer-tools .ctx-ring") !== null, $(pg, ".composer-pick b")?.textContent, $(pg, ".composer-pick")?.getAttribute("title")])
      .toEqual([true, "Opus 5.5", expect.stringContaining("claude-opus-5-5")]);
  });
  it("at 1600 px: no ring or chip in the composer (the header has the model)", async () => {
    const { pg } = await app(1600);
    expect([$(pg, "#msgIn") !== null, $(pg, ".composer-tools")]).toEqual([true, null]);
  });

  it("a phone keeps its own (long) chip; the window resized across a width redraws the composer, nothing else changing", async () => {
    const { pg, win } = await app(390);
    expect($(pg, ".composer-pick b")?.textContent).not.toBe("Opus 5.5");
    win.resize(1600); await settle(6);
    expect($(pg, ".composer-tools")).toBeNull();
    win.resize(1000); await settle(6);
    expect($(pg, ".composer-pick b")?.textContent).toBe("Opus 5.5");
  });

  it("the short name", () => {
    expect(["Opus 5.5 (claude-opus-5-5)", "claude-opus-5-5", "claude-sonnet-5-5[1m]", "claude-haiku-5", "Opus", "gpt-6.1-sol", ""].map(chat.shortModelName))
      .toEqual(["Opus 5.5", "Opus 5.5", "Sonnet 5.5", "Haiku 5", "Opus", "gpt-6.1-sol", ""]);
  });

  it("the CSS: the ring and the picker are styled outside any media query; the header's chips give way at the composer's width", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/shared/chat-work-bar.css"), "utf8"), js = readFileSync(join(process.cwd(), "src/ui/panel-chat.js"), "utf8");
    // The rules at the top level (brace depth 0), not inside a media query.
    let depth = 0; const topLevel: string[] = [];
    for (const line of css.split("\n")) { if (depth === 0) topLevel.push(line); depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length; }
    expect([".ctx-ring {", ".ctx-dial {", ".composer-pick {"].map((r) => topLevel.some((l) => l.startsWith(r)))).toEqual([true, true, true]);
    const jsWidth = /COMPOSER_TOOLS_Q = "\(max-width: (\d+)px\)"/.exec(js)![1], cssWidth = /@media \(min-width: 900px\) and \(max-width: (\d+)px\) \{ \.p-chat \.panel-head \.panel-sub \.hd-chip \{ display: none; \} \}/.exec(css)![1];
    expect(cssWidth).toBe(jsWidth);
  });
});
