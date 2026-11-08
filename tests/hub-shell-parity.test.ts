/**
 * cid-hub-shell-parity (the user: 「agend 排得很好看, agend hub 醜到不行」; the approved mockup): the Hub's sidebar is the
 * fleet dashboard's own (style guide rule 1), in a mini DOM:
 * - the brand is one line, "AgEnD Hub" — the Hub's name its tooltip, absent when the Hub has none (#3426);
 * - the dashboard's rows: Conversations, My shared agents, Administration (the administrator only), Notices (only where the
 *   Hub offers its security notices — and no count: the Hub exposes no read state), Search (Ctrl K: the conversation
 *   filter), New conversation (the side-new row, never a bordered pill);
 * - the conversation list under its section label, its empty state one line (no paragraph); the main page's too;
 * - the foot: Settings (this device's theme and language) and the session row ("Signed in"; its menu names the person);
 * - Notices is a page of its own (/ui/hub?view=notices).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let client: any, shell: any, router: any, i18n: any, hubPanel: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  router = await import("/assets/app-nav.js");
  shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js");
  client = await import("/ui/js/hub-client.js");
  hubPanel = await import("/ui/js/panel-hub.js");
  pg.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); });

/** A Hub workspace page signed in as `who`, its client answering the session, the rooms and the notices. */
async function hub(o: { admin?: boolean; features?: string[]; rooms?: unknown[]; name?: string | null; path?: string; lang?: string } = {}) {
  const session = { signedIn: true, displayName: "Alex", login: "alex", admin: !!o.admin, csrf: "c".repeat(64), features: o.features ?? [] };
  const c = client.createHubWebClient({ fetchImpl: async (path: string, init: any = {}) => {
    const key = `${init.method || "GET"} ${path.split("?")[0]}`;
    const json = key === "GET /hub/v1/session" ? session : key === "GET /hub/v1/rooms" ? { rooms: o.rooms ?? [] } : key === "GET /hub/v1/notices" ? { notices: [] }
      : key === "GET /hub/v1/exposures" ? { mine: [], askable: [] } : {};
    return { ok: true, status: 200, json: async () => json, headers: { get: () => null } };
  } });
  if (o.features?.includes("quick-pairing-v1")) c.quickPairingV1 = true;
  client.setHubClient(c);
  hubPanel.resetHubSession();
  if (o.lang) i18n.setLang(o.lang, { store: false });
  const pg = page({ url: `http://127.0.0.1:19280${o.path ?? "/ui/hub"}`, storage: { agend_tour_done: "1" } });
  pg.document.body.setAttribute("data-hub", "hub");
  if (o.name !== null) pg.document.body.setAttribute("data-hub-name", o.name ?? "Team Hub");
  mounted.push(pg);
  router.startRouter(pg.window);
  await pg.mount(h(shell.Shell, { panels: new Map([["hub", { Component: hubPanel.HubPanel }]]), onNewInstance() {} }));
  await until(() => pg.root.querySelector(".side-nav .side-new"));
  await settle(10);
  return pg;
}
const rows = (pg: AppPage) => [...pg.root.querySelectorAll(".side-nav .side-row .grow")].map((x: any) => x.textContent);

describe("the Hub's sidebar is the dashboard's (cid-hub-shell-parity)", () => {
  it("a one-line brand: AgEnD Hub, the name its tooltip — and plain AgEnD Hub when the Hub has no name (#3426)", async () => {
    const named = await hub();
    const brand = named.root.querySelector(".side-head .brand")!;
    expect([brand.textContent, brand.getAttribute("title"), brand.className]).toEqual(["AgEnD Hub", "Team Hub", "brand"]);
    await named.unmount(); mounted.splice(0); named.restore();
    const unnamed = await hub({ name: null });
    const plain = unnamed.root.querySelector(".side-head .brand")!;
    expect([plain.textContent, plain.getAttribute("title")]).toEqual(["AgEnD Hub", null]);
  });
  it("the rows, as the dashboard draws them: Administration for the administrator only; New conversation a side-new row, never a pill", async () => {
    const person = await hub();
    expect(rows(person)).toEqual(["Chats", "My shared agents", "Search", "New chat"]);
    expect([person.root.querySelector("#sidebar .hub-new"), person.root.querySelector(".side-nav .side-new")!.tagName]).toEqual([null, "BUTTON"]);
    await person.unmount(); mounted.splice(0); person.restore();
    const admin = await hub({ admin: true });
    expect(rows(admin)).toEqual(["Chats", "My shared agents", "Administration", "Search", "New chat"]);
    expect(admin.root.querySelector(".side-nav a.side-row.active .grow")!.textContent).toBe("Chats");
  });
  it("Notices only where the Hub offers its security notices — with no count (the Hub exposes no read state); it opens their own page", async () => {
    const pg = await hub({ features: ["quick-pairing-v1"] });
    expect(rows(pg)).toEqual(["Chats", "My shared agents", "Notices", "Search", "New chat"]);
    const notices = [...pg.root.querySelectorAll(".side-nav a.side-row")].find((a: any) => a.textContent.includes("Notices")) as any;
    expect([notices.getAttribute("href"), notices.querySelector(".nav-count")]).toEqual(["/ui/hub?view=notices", null]);
    notices.click(); await settle(20);
    expect([pg.window.location.search, pg.root.querySelector(".p-hub-notices h1")?.textContent, pg.root.querySelector(".side-nav a.side-row.active .grow")!.textContent])
      .toEqual(["?view=notices", "Notices", "Notices"]);
  });
  it("the Notices page with no notice says so in one line (the card is drawn only with a notice)", async () => {
    const pg = await hub({ features: ["quick-pairing-v1"], path: "/ui/hub?view=notices" });
    await until(() => pg.root.querySelector(".p-hub-notices .empty-title"));
    expect([pg.root.querySelector(".p-hub-notices .hub-notices-col .empty-title")?.textContent, pg.root.querySelector(".p-hub-notices .empty-hint"),
      pg.root.querySelector(".hub-security-notices")]).toEqual(["No security notices", null, null]);
  });
  it("Search and Ctrl K open the conversation filter (the Hub's own — no fleet search here); Escape closes it", async () => {
    const rooms = [{ id: "11111111-2222-4333-8444-555555555555", exposureId: "e1", grantId: "g1", state: "active", exposureName: "Sales numbers", ownerName: "Olivia", lastAt: 1, waiting: false, features: [] },
      { id: "21111111-2222-4333-8444-555555555555", exposureId: "e2", grantId: "g2", state: "active", exposureName: "Design guide", ownerName: "Olivia", lastAt: 2, waiting: false, features: [] }];
    const pg = await hub({ rooms });
    await until(() => pg.root.querySelectorAll(".hub-side-rooms .hub-room-row").length === 2);
    expect([pg.root.querySelector(".hub-side-filter"), pg.root.querySelector(".hub-side-rooms .inst-head .count")!.textContent]).toEqual([null, "2"]);
    fire(pg.document as any, "keydown", { key: "k", ctrlKey: true });
    await settle(10);
    const input = pg.root.querySelector(".hub-side-filter input") as any;
    expect(!!input).toBe(true);
    input.value = "design"; fire(input, "input"); await settle(5);
    expect([...pg.root.querySelectorAll(".hub-side-rooms .hub-room-row .t")].map((x: any) => x.textContent)).toEqual(["Design guide"]);
    fire(input, "keydown", { key: "Escape" }); await settle(5);
    expect([pg.root.querySelector(".hub-side-filter"), pg.root.querySelectorAll(".hub-side-rooms .hub-room-row").length]).toEqual([null, 2]);
  });
  it("no conversation yet: one line in the sidebar and on the page — no paragraph (zh-TW)", async () => {
    const pg = await hub({ lang: "zh-TW" });
    await until(() => pg.root.querySelector(".hub-side-rooms .side-empty"));
    // One line wherever the list is empty: the sidebar's, and the home page's own list (a phone's).
    expect([pg.root.querySelector(".hub-side-rooms .side-empty")!.textContent, [...pg.root.querySelectorAll(".hub-list-empty")].map((p: any) => p.textContent)]).toEqual(["還沒有對話", ["還沒有對話"]]);
    await until(() => pg.root.querySelector(".hub-home-pick .empty-title"));
    expect([pg.root.querySelector(".hub-home-pick .empty-title")!.textContent, pg.root.querySelector(".hub-home-pick .empty-hint")]).toEqual(["還沒有對話", null]);
  });
  it("the foot: Settings (this device's theme and language) and the session row — Signed in, its menu naming the person first", async () => {
    const pg = await hub({ admin: true });
    await until(() => pg.root.querySelector(".side-foot .hub-session-row button"));
    expect([pg.root.querySelector(".side-foot .hub-prefs summary .grow")!.textContent, pg.root.querySelector(".side-foot .hub-session-row button .grow")!.textContent])
      .toEqual(["Settings", "Signed in"]);
    expect([...pg.root.querySelectorAll(".side-foot .hub-prefs select")].length).toBe(2);   // theme and language — no fleet-only field
    (pg.root.querySelector(".side-foot .hub-session-row button") as any).click(); await settle(5);
    expect([...pg.root.querySelectorAll(".side-foot [role=menuitem]")].map((b: any) => b.textContent.trim())).toEqual(["Alex", "My shared agents", "Administration", "Sign out"]);
  });
});
