/**
 * Hub rooms, Administration → Rooms (docs/design/hub-rooms-ux.md section 11) against the seam-1 fixture and its U2
 * block: who may start rooms (named tags; saved on change; empty = administrators only), every group room without its
 * content, and each row's menu (join as a room manager; archive after a confirmation).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";

let clientModule: any, mod: any, i18n: any, confirm: any;
const mounted: AppPage[] = [];
const realEventSource = (globalThis as any).EventSource;
beforeAll(async () => {
  const pg = page();
  clientModule = await import("/ui/js/hub-client.js"); mod = await import("/ui/js/hub-admin-rooms.js"); i18n = await import("/assets/app-i18n.js"); confirm = await import("/assets/ui-confirm.js");
  pg.restore();
});
afterEach(async () => {
  for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); }
  (globalThis as any).EventSource = realEventSource; i18n.setLang("en", { store: false });
});
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function fixture(lang: "en" | "zh-TW" = "zh-TW", over: (path: string, init: any) => any = () => null) {
  const fx = createHubRoomsFixture(), calls: Array<{ path: string; method: string; body?: any }> = [];
  const fetchImpl = async (path: string, init: any = {}) => {
    calls.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    const forced = over(path, init);
    if (forced) return { ok: forced.status < 400, status: forced.status, headers: { get: () => null }, json: async () => forced.body ?? {} };
    return fx.fetch(path, init);
  };
  const pg = page({ url: "http://127.0.0.1:19443/ui/hub" }); mounted.push(pg);
  (globalThis as any).EventSource = fx.EventSource; i18n.setLang(lang, { store: false });
  const client = clientModule.createHubWebClient({ fetchImpl }); await client.session();
  await pg.mount(h("div", null, h(mod.AdminRooms, { client }), h(confirm.ConfirmHost, {}))); await settle(30);
  return { fx, client, calls, pg };
}
const writes = (calls: any[]) => calls.filter(c => c.method !== "GET").map(c => [c.method, c.path, c.body]);
const tags = (pg: AppPage) => [...pg.root.querySelectorAll("#hubRoomCreators")[0].parentElement.querySelectorAll(".hub-room-tags > li")].map((li: any) => li.textContent.replace("×", "").trim());
const rows = (pg: AppPage) => [...pg.root.querySelectorAll(".hub-admin-rooms-table tbody tr")].map((tr: any) => [...tr.querySelectorAll("td")].slice(0, 6).map((td: any, i: number) => i === 4 ? (td.textContent ? "time" : "") : td.textContent));
async function menu(pg: AppPage, roomId: string, item: string) {
  fire(pg.root.querySelector(`[data-room="${roomId}"] button`), "click"); await settle(10);
  const it = [...(pg.document as any).querySelectorAll("[role=menuitem]")].find((x: any) => x.textContent.trim() === item);
  expect(it, item).toBeTruthy(); fire(it, "click"); await settle(30);
}

describe("Hub Administration → Rooms (section 11)", () => {
  it("who may start rooms: named tags, saved on change; empty says administrators only; every room, no content", async () => {
    const { pg, calls } = await fixture();
    expect(tags(pg)).toEqual(["王經理"]);
    expect(pg.root.textContent).toContain("每個人都可以開一對一對話。");
    expect(pg.root.textContent).toContain("這裡看不到任何房間的內容。");
    expect(rows(pg)).toEqual([["研一主管週會", "3", "12", "王經理", "time", "使用中"], ["研發例會", "2", "4", "陳主任", "time", "使用中"], ["去年專案", "2", "1", "王經理", "time", "已封存"]]);
    const el = pg.root.querySelector("#hubRoomCreators"); el.value = "研一"; fire(el, "input"); await wait(260); await settle(10);
    fire([...pg.root.querySelectorAll(".hub-room-result")].find((b: any) => b.textContent.startsWith("研一")), "click"); await settle(30);
    expect(tags(pg)).toEqual(["王經理", "研一 · 2 人"]);
    fire(pg.root.querySelectorAll(".hub-room-tags button")[0], "click"); await settle(30);
    fire(pg.root.querySelectorAll(".hub-room-tags button")[0], "click"); await settle(30);
    expect(pg.root.textContent).toContain("目前只有 Hub 管理員可以開房間。");
    expect(writes(calls)).toEqual([
      ["PUT", "/hub/v1/admin/rooms/creators", { people: ["person-wang"], teams: ["team-1"] }],
      ["PUT", "/hub/v1/admin/rooms/creators", { people: [], teams: ["team-1"] }],
      ["PUT", "/hub/v1/admin/rooms/creators", { people: [], teams: [] }],
    ]);
  });

  it("a row's menu: join as a room manager (it says what happens); archive asks first; an archived room offers no archive", async () => {
    const { pg, calls } = await fixture();
    const prior = (globalThis as any).confirm; (globalThis as any).confirm = undefined;
    try {
      await menu(pg, "room-rd", "加入自己成為房間管理");
      expect(pg.root.querySelector("[role=status]").textContent).toBe("你現在是「研發例會」的房間管理，房間裡會出現一則說明。");
      expect(rows(pg)[1][3]).toBe("王經理、陳主任");
      await menu(pg, "room-rd", "封存");
      expect((pg.document as any).body.textContent).toContain("要封存「研發例會」嗎？房間會變成唯讀，成員仍然看得到內容。");
      fire((pg.document as any).querySelector("[data-confirm=yes]"), "click"); await settle(40);
      expect(rows(pg)[1][5]).toBe("已封存");
      fire(pg.root.querySelector('[data-room="room-archived"] button'), "click"); await settle(10);
      expect([...(pg.document as any).querySelectorAll("[role=menuitem]")].map((x: any) => x.textContent.trim())).toEqual(["加入自己成為房間管理"]);
      expect(writes(calls)).toEqual([["POST", "/hub/v1/admin/rooms/room-rd/join", {}], ["PATCH", "/hub/v1/admin/rooms/room-rd", { archived: true }]]);
    } finally { (globalThis as any).confirm = prior; }
  });

  it("a refused save puts the tags back and says so", async () => {
    let refuse = true;
    const { pg } = await fixture("en", (path, init) => refuse && path === "/hub/v1/admin/rooms/creators" && init.method === "PUT" ? { status: 500, body: {} } : null);
    fire(pg.root.querySelector(".hub-room-tags button"), "click"); await settle(30);
    expect(pg.root.querySelector("[role=alert]").textContent).toBe("That was not saved. Try again.");
    expect(tags(pg)).toEqual(["王經理"]);
    refuse = false;
  });

  it("a page that cannot be read offers a retry", async () => {
    let down = true;
    const second = await fixture("en", (path) => down && path === "/hub/v1/admin/rooms" ? { status: 500, body: {} } : null);
    expect(second.pg.root.querySelector("[role=alert]").textContent).toContain("Rooms could not be loaded.");
    down = false; fire([...second.pg.root.querySelectorAll("button")].find((b: any) => b.textContent === "Try again"), "click"); await settle(30);
    expect(rows(second.pg)).toHaveLength(3);
  });
});
