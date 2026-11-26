/**
 * S-255 (Prism #4544 P2-2): a member reaches Install as an app from the Hub's ordinary signed-in pages — the chats home
 * and a room's header beside the bell (on a phone, in the room's ⋯ menu with Notify) — not only from Notices.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let client: any, hubPanel: any, i18n: any, router: any, install: any;
const mounted: AppPage[] = [];
const until = async (fn: () => unknown, n = 300) => { for (let i = 0; i < n && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); };
const R1 = "room-weekly";

beforeAll(async () => {
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  router = await import("/assets/app-nav.js");
  i18n = await import("/assets/app-i18n.js");
  client = await import("/ui/js/hub-client.js");
  hubPanel = await import("/ui/js/panel-hub.js");
  install = await import("/assets/app-install.js");
});
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  client.setHubClient(null); hubPanel.resetHubSession(); install.installStore.set({ state: "none" });
});

function api() {
  const room = { id: R1, kind: "group", name: "Weekly sync", people: 3, agents: 1, online: 1, unread: 0, lastAt: 1, lastText: "", lastAuthor: "" };
  const routes: Record<string, () => unknown> = {
    "GET /hub/v1/session": () => [200, { signedIn: true, displayName: "Sample member", login: "member", csrf: "c".repeat(64), hub: { name: "Team Hub" }, features: ["rooms-v1"] }],
    "GET /hub/v1/rooms": () => [200, { ok: true, rooms: [room] }],
    [`GET /hub/v1/rooms/${R1}`]: () => [200, { ok: true, room: { id: R1, kind: "group", name: room.name }, me: { id: "person-member", role: "member" }, members: [], settings: { allMention: true, historyForNew: "all" } }],
    [`GET /hub/v1/rooms/${R1}/messages`]: () => [200, { ok: true, messages: [], more: false }],
  };
  const fetchImpl = async (path: string, init: any = {}) => {
    const key = `${init.method || "GET"} ${String(path).split("?")[0]}`;
    const [status, json] = routes[key] ? (await routes[key]!() as [number, unknown]) : [404, { code: "not-found" }];
    return { ok: status >= 200 && status < 300, status, json: async () => json, headers: { get: () => null } };
  };
  client.setHubClient(client.createHubWebClient({ fetchImpl }));
}
async function open(url: string, opts: { narrow?: boolean } = {}) {
  i18n.setLang("en", { store: false });
  const pg = page({ url, storage: { agend_tour_done: "1" }, ...(opts.narrow ? { matchNarrow: true } : {}) });
  pg.document.body.setAttribute("data-hub", "hub"); pg.document.body.setAttribute("data-hub-name", "Team Hub");
  mounted.push(pg);
  router.startRouter(pg.window);
  await pg.mount(h(hubPanel.HubPanel, { route: { panel: "hub", tab: "ask" }, navKey: `hub:ask|install:${url}:${!!opts.narrow}` }));
  return pg;
}

describe("Install as an app on the Hub's ordinary pages", () => {
  it("the chats home shows it in its header", async () => {
    install.installStore.set({ state: "untrusted" }); api();
    const pg = await open("http://127.0.0.1:19281/ui/hub");
    await until(() => pg.root.querySelector(".hub-install"));
    expect(pg.root.querySelector(".hub-install")?.getAttribute("aria-label")).toBe("Install as an app");
  });
  it("a room's header has it beside the bell; nothing when there is nothing to offer", async () => {
    install.installStore.set({ state: "available" }); api();
    const pg = await open(`http://127.0.0.1:19281/ui/hub?room=${R1}`);
    await until(() => pg.root.querySelector(".hub-chat-head .hub-install"));
    const tools = pg.root.querySelector(".hub-chat-head .hub-head-tools")!;
    const order = [...tools.children].map((el: any) => el.classList.contains("hub-install") ? "install" : el.classList.contains("hub-notify") ? "notify" : "other");
    expect(order.indexOf("install")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("install")).toBe(order.indexOf("notify") - 1);
    install.installStore.set({ state: "none" });
    await until(() => !pg.root.querySelector(".hub-chat-head .hub-install"));
    expect(pg.root.querySelector(".hub-chat-head .hub-install")).toBeNull();
  });
  it("on a phone, the room's ⋯ menu carries it with Notify", async () => {
    install.installStore.set({ state: "untrusted" }); api();
    const pg = await open(`http://127.0.0.1:19281/ui/hub?room=${R1}`, { narrow: true });
    await until(() => pg.root.querySelector(".hub-room-menu button"));
    fire(pg.root.querySelector(".hub-room-menu button") as any, "click"); await settle();
    const items = [...pg.root.querySelectorAll("[role=menuitem], [role=menuitemcheckbox]")].map((el: any) => el.textContent.trim());
    expect(items).toContain("Install as an app");
  });
});
