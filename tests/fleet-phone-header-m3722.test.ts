/**
 * M-3722 (a): on a phone, Fleet's eight tabs no longer fit beside ☰ at 390 px (Authorizations and Host health pushed the
 * last off-screen, en and zh-TW). The phone header is now two rows: ☰ and this page's name (the h1), then every tab as an
 * icon across the width, each a whole touch target (app.css; measured in a real browser by
 * scripts/manual/office-toolbar-bubble-m3722/capture.mts). On a desktop the header still says "Fleet".
 * The real Shell, router and Fleet panel in a mini DOM.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const mounted: AppPage[] = [];
const realFetch = (globalThis as { fetch?: unknown }).fetch;
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (globalThis as { fetch?: unknown }).fetch = realFetch;
});

async function shell(opts: { narrow?: boolean; media?: unknown } = {}) {
  const pg = page({ url: "http://127.0.0.1:19280/ui/fleet/org", storage: { agend_tour_done: "1" }, matchNarrow: opts.narrow });
  mounted.push(pg);
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => ({ ok: true, status: 200,
    json: async () => (String(url).startsWith("/ui/org") ? { teams: [], general: null, instances: [] } : []) });
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus, appStore } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  // @ts-expect-error — a JS module of the app, with no types
  const { FleetPanel } = await import("../src/ui/panel-fleet.js");
  appStore.set({ viewOnly: false });
  startRouter(pg.window);
  applyStatus({ instances: [{ name: "web-dev", status: "running", backend: "claude-code", tags: [] }] });
  await pg.mount(h(Shell, { panels: new Map<string, unknown>([["fleet", { Component: FleetPanel }]]), onNewInstance() {} }));
  await settle(4);
  return pg;
}

const title = (pg: AppPage) => (pg.root.querySelector(".p-fleet .panel-head .panel-title h1") as any)?.textContent.trim();

describe("M-3722: Fleet's header on a phone names the page", () => {
  it("a phone: the h1 is the page's name (Org chart), the tabs still in the header's nav", async () => {
    const pg = await shell({ narrow: true });
    expect(title(pg)).toBe("Org chart");
    expect(pg.root.querySelectorAll(".p-fleet .panel-head nav.fleet-phone-tabs > a").length).toBeGreaterThanOrEqual(7);
  });
  it("a desktop: unchanged — the h1 says Fleet", async () => {
    const pg = await shell();
    expect(title(pg)).toBe("Fleet");
  });
  it("the phone rules: the tab row spans the width in equal columns, each a --tap target; the page's name shows", () => {
    const css = readFileSync("src/ui/shared/app.css", "utf8");
    expect(css).toMatch(/\.p-fleet > \.panel-head \.fleet-phone-tabs \{[^}]*flex: 1 0 100%;[^}]*display: grid;[^}]*grid-auto-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.p-fleet > \.panel-head \.fleet-phone-tabs \.seg-item \{[^}]*min-height: var\(--tap\)/);
    expect(css).not.toMatch(/\.p-fleet > \.panel-head \.panel-title h1, \.p-fleet > \.panel-head \.panel-actions \{ display: none/);
  });
});
