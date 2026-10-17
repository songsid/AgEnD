/**
 * #2074: "New agent" in the left sidebar — a labelled row under the nav that opens the Create agent dialog (the app's
 * onNewInstance), for an admin's session only: /auth/session's tier through AgendAuth.canWrite() (a guest's create is
 * refused by the server). With the sidebar collapsed on a wide screen, a "+" beside the header's ☰ does the same; a
 * phone has the row in its drawer. A session that ends takes both away. The real Shell and router in a mini DOM.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const mounted: AppPage[] = [];
const realFetch = (globalThis as { fetch?: unknown }).fetch;
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (globalThis as { fetch?: unknown }).fetch = realFetch;
  const { setLang } = await import("/assets/app-i18n.js");
  setLang("en");
});

type Auth = { canWrite: () => Promise<boolean>; sessionEnded: () => boolean; onSessionEnd: (fn: () => void) => () => void; end: () => void };
function auth(admin: boolean): Auth {
  let ended = false; const fns = new Set<() => void>();
  return {
    canWrite: async () => admin && !ended, sessionEnded: () => ended,
    onSessionEnd: (fn) => { fns.add(fn); return () => fns.delete(fn); },
    end: () => { ended = true; for (const fn of fns) fn(); },
  };
}
async function shell(opts: { admin?: boolean; collapsed?: boolean; narrow?: boolean; auth?: Auth | null } = {}) {
  const storage: Record<string, string> = { agend_tour_done: "1" };
  if (opts.collapsed) storage.agend_sidebar = "hidden";
  const pg = page({ url: "http://127.0.0.1:19280/ui/fleet", storage, matchNarrow: opts.narrow });
  mounted.push(pg);
  const a = opts.auth === undefined ? auth(opts.admin ?? true) : opts.auth;
  if (a) (pg.window as any).AgendAuth = a;
  (globalThis as { fetch?: unknown }).fetch = async () => ({ ok: true, status: 200, json: async () => [] });
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus, appStore } = await import("/assets/app-store.js");
  const { Shell, PanelHeader, shellStore, setNewInstanceOpener } = await import("/assets/app-shell.js");
  shellStore.set({ collapsed: !!opts.collapsed, drawer: false });
  const opened: string[] = [];
  const onNewInstance = () => { opened.push("dialog"); };
  setNewInstanceOpener(onNewInstance);
  appStore.set({ viewOnly: false });
  startRouter(pg.window);
  applyStatus({ instances: [{ name: "web-dev", status: "running", backend: "claude-code", tags: [] }] });
  const Panel = () => h("div", { class: "panel p-test" }, h(PanelHeader, { title: "Test" }));
  await pg.mount(h(Shell, { panels: new Map<string, unknown>([["fleet", { Component: Panel }]]), onNewInstance }));
  await settle(4);
  return { pg, opened, auth: a };
}
const row = (pg: AppPage) => pg.root.querySelector("#sidebar .side-nav button.side-new") as any;
const plus = (pg: AppPage) => pg.root.querySelector(".panel-head button.sb-new") as any;

describe("New agent in the sidebar", () => {
  it("an admin's sidebar has the labelled row under the nav; it opens the Create agent dialog", async () => {
    const { pg, opened } = await shell();
    const r = row(pg);
    expect([r?.textContent.trim(), r?.getAttribute("type"), [...r?.parentNode?.children].at(-1) === r]).toEqual(["New agent", "button", true]);
    r.click(); await settle();
    expect(opened).toEqual(["dialog"]);
    expect(plus(pg), "the sidebar is open: no header +").toBeNull();
    expect(pg.root.querySelectorAll("#sidebar .side-head button").length, "the brand row keeps only its collapse button").toBe(1);
  });
  it("in Chinese it says 新增 Agent", async () => {
    const { setLang } = await import("/assets/app-i18n.js");
    setLang("zh-TW");
    const { pg } = await shell();
    expect(row(pg)?.textContent.trim()).toBe("新增 Agent");
  });
  it("is not drawn for a session that may not create (a guest, a read session), nor with no AgendAuth at all", async () => {
    for (const a of [auth(false), null]) {
      const { pg } = await shell({ auth: a, collapsed: false });
      expect([row(pg), plus(pg)], a ? "canWrite false" : "no AgendAuth").toEqual([null, null]);
      const p = mounted.pop()!; await p.unmount(); p.restore();
    }
    const { pg } = await shell({ auth: auth(false), collapsed: true });
    expect([row(pg), plus(pg)], "collapsed").toEqual([null, null]);
  });
  it("a collapsed sidebar puts a + beside the header's ☰; it opens the same dialog", async () => {
    const { pg, opened } = await shell({ collapsed: true });
    const p = plus(pg);
    expect([p?.getAttribute("aria-label"), p?.getAttribute("title"), (() => { const kids = [...p.parentNode.children]; return kids[kids.indexOf(p) - 1]?.id; })()]).toEqual(["New agent", "New agent", "sbOpen"]);
    p.click(); await settle();
    expect(opened).toEqual(["dialog"]);
  });
  it("a session that ends takes the row and the + away", async () => {
    const { pg, auth: a } = await shell({ collapsed: true });
    expect(plus(pg)).not.toBeNull();
    a!.end(); await settle(2);
    expect(plus(pg)).toBeNull();
    (await import("/assets/app-shell.js")).shellStore.set({ collapsed: false }); await settle(2);
    expect(row(pg)).toBeNull();
  });
  it("a phone hides the header + (its drawer has the row); the row is a .side-row like the others", () => {
    const css = readFileSync("src/ui/shared/app.css", "utf8");
    const blocks = css.split("@media (max-width: 899px) {").slice(1).map((b) => b.slice(0, b.indexOf("\n}")));
    expect(blocks.some((b) => b.includes(".panel-head .sb-new { display: none; }")), "inside a phone block").toBe(true);
  });
});
