/**
 * #1920 phase 3 (P3a): a guest's web app — only what a guest may use, and who it is signed in as.
 * - The server marks a guest's page (data-tier="guest", its web name and platform; no usage panel) — an admin's page is
 *   unchanged.
 * - The shell: the sidebar lists its own agents to pick from (no filters, no reordering) with a "Guest · <name>
 *   (<platform>)" chip and its session — no Fleet overview, Needs you, Fleet, View, Settings, New agent or widget; no
 *   bottom tabs; no operations, usage rail, pending changes or owner-CSS bar. Its preferences are read-only.
 * - The chat: no instance tabs, ⋯ menu or effects; no command palette — a "/…" draft is refused here with why (the
 *   server would refuse it as a command) and kept; the hint says the agent sees its messages as a guest's.
 * Rigs: the real handler (server), and the real Shell / chat panel in a mini DOM (as web-new-agent-2074 and
 * web-chat-commands-1269).
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest } from "../src/web-api.js";
import { fire } from "./helpers/mini-dom.js";
import { settle, type AppPage } from "./helpers/app-harness.js";

const TOKEN = "c".repeat(48);

describe("the server marks a guest's page", () => {
  function shellFor(tier: "admin" | "guest") {
    const sessions = new WebSessionStore();
    const sid = sessions.create({ tier, surface: "local", label: "x", tokenEpoch: tokenEpoch(TOKEN), ...(tier === "guest" ? { owner: { adapterId: "dc", userId: "111" } } : {}) }).sessionId;
    const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui", headers: { host: "127.0.0.1:19280", cookie: `agend_session=${sid}` }, destroy: vi.fn() });
    let body = "";
    const res = { destroyed: false, headersSent: false, setHeader: () => {}, writeHead: () => {}, end: (t = "") => { body = String(t); }, destroy: vi.fn() };
    const ctx = { webToken: TOKEN, webSessions: sessions, fleetConfig: { web: {} }, guestBadge: () => ({ name: "Alice <&>", platform: "discord" }) };
    expect(handleWebRequest(req as never, res as never, new URL("http://127.0.0.1:19280/ui"), ctx as never)).toBe(true);
    return /<body[^>]*>/.exec(body)![0];
  }
  it("data-tier=guest, its name (escaped) and platform, and no usage panel; an admin's page has none of it", () => {
    const guest = shellFor("guest");
    expect(guest).toContain('data-tier="guest"');
    expect(guest).toContain('data-guest-name="Alice &#60;&#38;&#62;"');
    expect(guest).toContain('data-guest-platform="discord"');
    expect(guest).toContain('data-usage-panel="0"');
    const admin = shellFor("admin");
    expect(admin).not.toContain("data-tier");
    expect(admin).not.toContain("data-guest");
    expect(admin).toContain('data-usage-panel="1"');
  });
});

const mounted: AppPage[] = [];
const realFetch = (globalThis as { fetch?: unknown }).fetch;
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (globalThis as { fetch?: unknown }).fetch = realFetch;
  vi.resetModules();
});

describe("a guest's shell", () => {
  async function shell(guest: boolean) {
    vi.resetModules();
    const harness = await import("./helpers/app-harness.js");
    // A filter this device kept ("zzz" matches no agent), and host preferences on the page (so they could be written).
    const pg = harness.page({ url: "http://127.0.0.1:19280/ui/chat/web-dev", storage: { agend_tour_done: "1", agend_instance_filter: JSON.stringify({ q: "zzz", status: [], cli: [] }) } });
    mounted.push(pg);
    pg.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
    if (guest) { pg.document.body.setAttribute("data-tier", "guest"); pg.document.body.setAttribute("data-guest-name", "Alice"); pg.document.body.setAttribute("data-guest-platform", "discord"); }
    (pg.window as any).AgendAuth = { canWrite: async () => !guest, sessionEnded: () => false, onSessionEnd: () => () => {} };
    (globalThis as { fetch?: unknown }).fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    const { startRouter } = await import("/assets/app-nav.js" as string);
    const { applyStatus, appStore } = await import("/assets/app-store.js" as string);
    const { Shell, PanelHeader, setNewInstanceOpener } = await import("/assets/app-shell.js" as string);
    const prefs = await import("/assets/app-prefs.js" as string);
    setNewInstanceOpener(() => {});
    appStore.set({ viewOnly: false });
    startRouter(pg.window);
    applyStatus({ instances: [{ name: "web-dev", status: "running", tags: [] }, { name: "docs", status: "running", tags: [] }] });
    const Panel = () => harness.h("div", { class: "panel p-test" }, harness.h(PanelHeader, { title: "Test" }));
    await pg.mount(harness.h(Shell, { panels: new Map<string, unknown>([["chat", { Component: Panel }]]), onNewInstance: () => {} }));
    await settle(4);
    return { pg, prefs };
  }
  const texts = (pg: AppPage, sel: string) => [...pg.root.querySelectorAll(sel)].map((e: any) => e.textContent.trim());
  it("its own agents to pick from, its chip and session — and nothing of an admin's", async () => {
    const { pg, prefs } = await shell(true);
    expect(texts(pg, "#sidebar .guest-chip")).toEqual(["Guest · Alice (Discord)"]);
    // #2101 review: no trust marker of its own (inside the marked .side-foot) — effect-stock-trust's closed inventory
    // would refuse it, and a guest's static effect posters with it (real Chrome: smoke-1920-guest's poster proof).
    expect(pg.root.querySelector("#sidebar .guest-chip").getAttribute("data-trust")).toBeNull();
    expect(pg.root.querySelector("#sidebar .guest-chip").parentNode.getAttribute("data-trust")).toBe("navigation");
    expect(pg.root.querySelector("#sidebar .side-nav"), "no Fleet overview, Needs you, Fleet, View or New agent").toBeNull();
    expect(texts(pg, "#sidebar .side-foot a.side-row"), "no Settings").toEqual([]);
    expect(pg.root.querySelector("#sidebar .v-filter"), "no filters").toBeNull();
    expect(texts(pg, "#sidebar .inst-name").sort(), "a filter this device kept hides nothing").toEqual(["docs", "web-dev"]);
    expect(pg.root.querySelector("#sidebar [draggable=true]"), "no reordering").toBeNull();
    expect(pg.root.querySelector("nav.tabs"), "no bottom tabs").toBeNull();
    expect(pg.root.querySelector(".shell.guest")).not.toBeNull();
    expect(prefs.prefsWritable(), "its preferences are read-only").toBe(false);
  });
  it("control: an admin's shell keeps all of it", async () => {
    const { pg, prefs } = await shell(false);
    expect(pg.root.querySelector("#sidebar .guest-chip")).toBeNull();
    expect(pg.root.querySelector("#sidebar .side-nav")).not.toBeNull();
    expect(texts(pg, "#sidebar .side-foot a.side-row")).toEqual(["Settings"]);
    expect(pg.root.querySelector("#sidebar .v-filter")).not.toBeNull();
    expect(pg.root.querySelector("nav.tabs")).not.toBeNull();
    expect(texts(pg, "#sidebar .inst-name"), "the kept filter applies to an admin — only the open one, pinned (#1936) — so the guest case can tell").toEqual(["web-dev"]);
    expect(prefs.prefsWritable(), "an admin's page may write them").toBe(true);
  });
});

describe("a guest's chat", () => {
  async function chatPage(guest: boolean) {
    vi.resetModules();
    const harness = await import("./helpers/app-harness.js");
    const p = harness.page({ storage: { agend_tour_done: "1" } });
    mounted.push(p);
    if (guest) p.document.body.setAttribute("data-tier", "guest");
    const app = await import("/assets/app-store.js" as string);
    const panel = await import("/ui/js/panel-chat.js" as string);
    const calls: Array<{ path: string; body: unknown }> = [];
    const toasts: string[] = [];
    const fetch = async (path: string, o: { body?: unknown } = {}) => {
      calls.push({ path, body: typeof o.body === "string" ? JSON.parse(o.body) : o.body });
      return { ok: true, status: 200, json: async () => (path.startsWith("/ui/history") ? { messages: [] } : {}) };
    };
    const subs = new Map<string, Array<(d: unknown) => void>>();
    const stream = { on: (n: string, fn: (d: unknown) => void) => { subs.set(n, [...(subs.get(n) ?? []), fn]); return () => {}; }, emit: (n: string, d: unknown) => { for (const fn of subs.get(n) ?? []) fn(d); }, started: () => true, catchUp: () => {} };
    stream.on("status", app.applyStatus);
    panel.boot({ stream, boot: null, deps: { fetch, toast: (m: string) => toasts.push(m), setTimeout: () => 0 } });
    stream.emit("status", { uptime: 1, instances: [{ name: "w", status: "running", state: "idle" }] });
    const { Toasts } = await import("/assets/ui-toast.js" as string);
    await p.mount(harness.h("div", null, harness.h("main", { id: "main" }, harness.h(panel.ChatPanel, { route: { panel: "chat", instance: "w" }, navKey: "chat|w" })), harness.h(Toasts, null)));
    await settle();
    const box = () => p.root.querySelector("#msgIn");
    const type = async (text: string) => { box().value = text; fire(box(), "input"); await settle(); };
    const key = async (k: string) => { fire(box(), "keydown", { key: k }); await settle(); };
    const shown = () => [...p.root.querySelectorAll(".toast")].map((e: any) => e.textContent);
    return { p, calls, toasts, shown, box, type, key };
  }
  it("no tabs, menu or palette; a '/…' draft refused here with why and kept; the hint says it is a guest's", async () => {
    const c = await chatPage(true);
    expect(c.p.root.querySelector("nav.inst-switch"), "no Chat / View / Log / Details").toBeNull();
    expect(c.p.root.querySelector("[aria-haspopup=menu]"), "no ⋯ menu").toBeNull();
    await c.type("/clear");
    expect(c.p.root.querySelector(".cmd-palette"), "no command palette").toBeNull();
    await c.key("Enter");
    expect(c.calls.filter((x) => x.path === "/ui/send" || x.path === "/ui/command"), "nothing sent").toEqual([]);
    expect(c.shown().join(" | ")).toContain("Guests can't run commands");
    expect(c.box().value, "the draft is kept to edit").toBe("/clear");
    expect(c.p.root.querySelector(".guest-note")?.textContent).toContain("guest's (recognition only)");
    await c.type("hello");
    await c.key("Enter");
    expect(c.calls.filter((x) => x.path === "/ui/send").map((x) => (x.body as any).message), "a message goes as before").toEqual(["hello"]);
  });
  it("control: an admin's chat has its tabs, menu and palette", async () => {
    const c = await chatPage(false);
    expect(c.p.root.querySelector("nav.inst-switch")).not.toBeNull();
    expect(c.p.root.querySelector("[aria-haspopup=menu]")).not.toBeNull();
    await c.type("/");
    expect(c.p.root.querySelector(".cmd-palette")).not.toBeNull();
    expect(c.p.root.querySelector(".guest-note")).toBeNull();
  });
});
