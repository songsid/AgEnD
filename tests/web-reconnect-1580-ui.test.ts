/**
 * #1580, the page's side: while the app's stream is reconnecting, the shell says so (with when the next try is) instead
 * of showing a silent stale page, and the View's polls (the pane every 0.8 s, the roster every 5 s) skip their turn —
 * no read storm through a relay while the fleet restarts. Real modules in the mini DOM.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";

const g = globalThis as any;
let p: AppPage;
let requests: string[] = [];
let appStore: any, view: any, shell: any;

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/view/alpha", storage: { agend_tour_done: "1" } });
  g.fetch = async (u: string) => {
    requests.push(u);
    if (u === "/api/profiles") return { ok: true, status: 200, json: async () => [{ instance_name: "alpha", status: "running", backend: "codex", tags: [], has_avatar: false }] };
    if (u.startsWith("/api/pane/")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  g.getComputedStyle = () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0", fontFamily: "monospace", fontSize: "1px", lineHeight: "1.2" });
  ({ appStore } = await import("/assets/app-store.js"));
  view = await import("/assets/panel-view.js");
  shell = await import("/assets/app-shell.js");
});
afterAll(async () => { await p.unmount(); p.restore(); appStore.set({ connection: "connecting", retryAt: undefined }); for (const k of ["fetch", "getComputedStyle"]) delete g[k]; });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const panes = () => requests.filter(u => u.startsWith("/api/pane/")).length;

describe("the View while the fleet is unreachable", () => {
  it("the pane and roster reads skip their turns while reconnecting, and resume once it is live again", async () => {
    appStore.set({ connection: "live" });
    await p.mount(h(view.ViewPanel, { route: { panel: "view", instance: "alpha" }, navKey: "view:alpha|1|en" }));
    await wait(1000);
    expect(panes(), "live: the pane is read (every 0.8 s)").toBeGreaterThanOrEqual(1);
    appStore.set({ connection: "reconnecting" });
    requests = [];
    await wait(2000);
    expect(requests, "reconnecting: nothing").toEqual([]);
    appStore.set({ connection: "live" });
    await wait(1000);
    expect(panes(), "live again: reads resume").toBeGreaterThanOrEqual(1);
    await p.unmount();
  });
});

describe("the connection line", () => {
  it("reconnecting: it says the fleet may be restarting, and when the next try is", async () => {
    const line = () => p.root.querySelector(".conn")?.textContent?.trim() ?? null;
    appStore.set({ connection: "reconnecting", retryAt: performance.now() + 12_000, ready: true, instances: [] });
    await p.mount(h(shell.Shell, { panels: new Map(), onNewInstance() {} }));
    await settle();
    expect(line()).toBe("Can't reach AgEnD — it may be restarting. Trying again in 12 s.");
    appStore.set({ retryAt: performance.now() - 1 });
    await wait(1100); await settle();
    expect(line()).toBe("Can't reach AgEnD — it may be restarting. Reconnecting…");
    appStore.set({ connection: "ended" });
    await settle();
    expect(line(), "ended: agend-auth.js's banner says it, not this line").toBeNull();
    appStore.set({ connection: "live" });
    await settle();
    expect(line()).toBeNull();
    await p.unmount();
  });
});
