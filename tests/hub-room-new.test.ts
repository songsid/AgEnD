/**
 * Hub rooms, the New room dialog (docs/design/hub-rooms-ux.md section 6) against the seam-1 fixture and its U2 block:
 * the required name (not a greyed button: 建立 says what is missing and puts the cursor there), the pickers (people, teams
 * and AD groups with their counts; my agents join, others are invited, a team's agents can be invited), the assistant
 * switch only when the Hub offers it, and what 建立 sends.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";

let clientModule: any, dlg: any, i18n: any;
const mounted: AppPage[] = [];
const realEventSource = (globalThis as any).EventSource;
beforeAll(async () => {
  const pg = page();
  clientModule = await import("/ui/js/hub-client.js"); dlg = await import("/ui/js/hub-room-new.js"); i18n = await import("/assets/app-i18n.js");
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
  return { fx, client, calls, pg };
}
const button = (pg: AppPage, label: string) => [...pg.root.querySelectorAll("button")].find((b: any) => b.textContent.trim() === label);
async function type(pg: AppPage, id: string, value: string) { const el = pg.root.querySelector(`#${id}`); el.value = value; fire(el, "input"); await settle(5); }
async function search(pg: AppPage, id: string, value: string) { await type(pg, id, value); await wait(260); await settle(10); }
const results = (pg: AppPage, id: string) => [...pg.root.querySelector(`#${id}`).parentElement.querySelectorAll(".hub-room-result")].map((b: any) => b.textContent.replace(/\s+/g, " ").trim());
const pick = async (pg: AppPage, id: string, starts: string) => {
  const b = [...pg.root.querySelector(`#${id}`).parentElement.querySelectorAll(".hub-room-result")].find((x: any) => x.textContent.trim().startsWith(starts));
  expect(b, starts).toBeTruthy(); fire(b, "click"); await settle(5);
};
const tags = (pg: AppPage, id: string) => [...pg.root.querySelector(`#${id}`).parentElement.querySelectorAll(".hub-room-tags > li")].map((li: any) => li.firstChild ? li.textContent.replace("×", "").replace(/\s+/g, " ").trim() : "");

describe("Hub New room dialog (section 6)", () => {
  it("建立 without a name: nothing is sent; it says 「請輸入房間名稱。」 and the cursor goes to the name", async () => {
    const { pg, client, calls } = await fixture();
    await pg.mount(h(dlg.NewRoomDialog, { client, assistant: false })); await settle(10);
    expect(pg.root.querySelector("#hubRoomName").getAttribute("placeholder")).toBe("例如：研一主管週會");
    expect(button(pg, "建立").disabled).toBe(false);
    fire(button(pg, "建立"), "click"); await settle(10);
    expect(pg.root.querySelector(".hub-room-new-error").textContent).toBe("請輸入房間名稱。");
    expect((pg.document as any).activeElement).toBe(pg.root.querySelector("#hubRoomName"));
    expect(calls.filter(c => c.method === "POST")).toEqual([]);
    expect(pg.root.querySelector("#hubRoomName").getAttribute("maxlength")).toBe("60");
  });

  it("the pickers: me fixed as manager; teams and groups with counts; agents of others are invitations; a team's agents too; 建立 sends the room, then the invitations, then opens it", async () => {
    const { pg, client, calls } = await fixture();
    const opened: string[] = []; let closed = 0;
    await pg.mount(h(dlg.NewRoomDialog, { client, assistant: true, onOpenRoom: (id: string) => opened.push(id), onClose: () => { closed++; } })); await settle(10);
    await type(pg, "hubRoomName", "  新案子  ");
    expect(tags(pg, "hubRoomPeople")).toEqual(["你 · 管理"]);
    await search(pg, "hubRoomPeople", "陳"); await pick(pg, "hubRoomPeople", "陳主任");
    // A group's count is read when it is chosen (R #3866: GET candidates/group/:id), so the result row has none.
    await search(pg, "hubRoomPeople", "研"); expect(results(pg, "hubRoomPeople")).toEqual(["研一 · 2 人", "研發一部", "研發二部"]);
    await pick(pg, "hubRoomPeople", "研一"); await search(pg, "hubRoomPeople", "研發"); await pick(pg, "hubRoomPeople", "研發一部");
    expect(tags(pg, "hubRoomPeople")).toEqual(["你 · 管理", "陳主任", "研一 · 2 人", "研發一部 · 20 人"]);
    expect(calls.filter(c => c.path.startsWith("/hub/v1/rooms/candidates/group/")).map(c => c.path)).toEqual(["/hub/v1/rooms/candidates/group/group-rd1"]);
    await search(pg, "hubRoomAgents", "my-"); expect(results(pg, "hubRoomAgents")).toEqual(["my-notes 王經理"]);
    await pick(pg, "hubRoomAgents", "my-notes");
    await search(pg, "hubRoomAgents", "spec"); expect(results(pg, "hubRoomAgents")).toEqual(["spec-writer 陳主任 邀請 · 等擁有者同意"]);
    await pick(pg, "hubRoomAgents", "spec-writer");
    await search(pg, "hubRoomAgents", "研一"); await pick(pg, "hubRoomAgents", "「研一」所有人的 Agent");
    expect(tags(pg, "hubRoomAgents")).toEqual(["my-notes", "spec-writer · 邀請 · 等擁有者同意", "「研一」所有人的 Agent · 邀請 · 等擁有者同意"]);
    { const sw = pg.root.querySelector("#hubRoomAssistant"); sw.checked = true; fire(sw, "change"); await settle(5); }
    fire(button(pg, "建立"), "click"); await settle(30);
    const posts = calls.filter(c => c.method === "POST");
    expect(posts[0]).toEqual({ path: "/hub/v1/rooms", method: "POST", body: { name: "新案子", people: ["person-chen"], teams: ["team-1"], groups: ["group-rd1"], agents: ["exp-mine-1"], assistant: true } });
    const roomId = opened[0]!;
    expect(posts.slice(1).map(c => [c.path, c.body])).toEqual([[`/hub/v1/rooms/${roomId}/invitations`, { agents: ["exp-02"] }], [`/hub/v1/rooms/${roomId}/invitations`, { team: "team-1" }]]);
    expect(closed).toBe(1);
  });

  it("a group the directory cannot read whole is not added: 「目前無法讀取「…」的成員，請稍後再試。」, the other picks stay", async () => {
    const { pg, client } = await fixture();
    await pg.mount(h(dlg.NewRoomDialog, { client, assistant: false })); await settle(10);
    await search(pg, "hubRoomPeople", "陳"); await pick(pg, "hubRoomPeople", "陳主任");
    await search(pg, "hubRoomPeople", "研發二"); await pick(pg, "hubRoomPeople", "研發二部"); await settle(10);
    expect(tags(pg, "hubRoomPeople")).toEqual(["你 · 管理", "陳主任"]);
    expect(pg.root.querySelector(".hub-room-picker-note").textContent).toBe("目前無法讀取「研發二部」的成員，請稍後再試。");
    await search(pg, "hubRoomPeople", "研發一"); await pick(pg, "hubRoomPeople", "研發一部"); await settle(10);   // the next pick clears it
    expect(pg.root.querySelector(".hub-room-picker-note")).toBeNull();
    expect(tags(pg, "hubRoomPeople")).toEqual(["你 · 管理", "陳主任", "研發一部 · 20 人"]);
  });

  it("over 100 people: no room, nothing invited; under the members field 「這個房間會有 N 人，超過上限 100 人。…」 and every pick stays", async () => {
    const { pg, client, calls } = await fixture();
    const opened: string[] = [];
    await pg.mount(h(dlg.NewRoomDialog, { client, assistant: false, onOpenRoom: (id: string) => opened.push(id) })); await settle(10);
    await type(pg, "hubRoomName", "全員");
    await search(pg, "hubRoomPeople", "全"); await pick(pg, "hubRoomPeople", "全公司"); await settle(10);
    await search(pg, "hubRoomAgents", "spec"); await pick(pg, "hubRoomAgents", "spec-writer");
    expect(tags(pg, "hubRoomPeople")).toEqual(["你 · 管理", "全公司 · 132 人"]);
    fire(button(pg, "建立"), "click"); await settle(30);
    expect(pg.root.querySelector(".hub-room-picker-note").textContent).toBe("這個房間會有 133 人，超過上限 100 人。請改選較小的 AD 群組或團隊。");
    expect(pg.root.querySelector(".hub-room-new-error")).toBeNull();
    expect(opened).toEqual([]);
    expect(calls.filter(c => c.method === "POST").map(c => c.path)).toEqual(["/hub/v1/rooms"]);
    expect(tags(pg, "hubRoomPeople")).toEqual(["你 · 管理", "全公司 · 132 人"]);
    expect(tags(pg, "hubRoomAgents")).toEqual(["spec-writer · 邀請 · 等擁有者同意"]);
    fire([...pg.root.querySelectorAll(".hub-room-tags button")].find((x: any) => x.getAttribute("aria-label") === "移除 全公司 · 132 人"), "click"); await settle(5);
    expect(pg.root.querySelector(".hub-room-picker-note")).toBeNull();                       // changing the members clears it
    fire(button(pg, "建立"), "click"); await settle(30);
    expect(opened).toHaveLength(1);
  });

  it("a group unreadable at 建立 (503 group-unavailable): that group is dropped, the rest kept, the room not created", async () => {
    let unreadable = true;
    const { pg, client, calls } = await fixture("en", (path, init) => unreadable && path === "/hub/v1/rooms" && init.method === "POST" ? { status: 503, body: { code: "group-unavailable", group: "group-rd1" } } : null);
    const opened: string[] = [];
    await pg.mount(h(dlg.NewRoomDialog, { client, assistant: false, onOpenRoom: (id: string) => opened.push(id) })); await settle(10);
    await type(pg, "hubRoomName", "R");
    await search(pg, "hubRoomPeople", "陳"); await pick(pg, "hubRoomPeople", "陳主任");
    await search(pg, "hubRoomPeople", "研發一"); await pick(pg, "hubRoomPeople", "研發一部"); await settle(10);
    expect(tags(pg, "hubRoomPeople")).toEqual(["You · Manager", "陳主任", "研發一部 · 20 people"]);
    fire(button(pg, "Create"), "click"); await settle(30);
    expect(pg.root.querySelector(".hub-room-picker-note").textContent).toBe("Can't read the members of “研發一部” right now. Try again later.");
    expect(tags(pg, "hubRoomPeople")).toEqual(["You · Manager", "陳主任"]);
    expect(opened).toEqual([]);
    unreadable = false;
    fire(button(pg, "Create"), "click"); await settle(30);
    expect(calls.filter(c => c.method === "POST" && c.path === "/hub/v1/rooms").at(-1)!.body).toMatchObject({ people: ["person-chen"], groups: [] });
    expect(opened).toHaveLength(1);
  });

  it.each(["en", "zh-TW"] as const)("a group of one reads 「1 person」 in English, 「1 人」 in zh (%s)", async (lang) => {
    {
      const { pg, client } = await fixture(lang, (path) => path === "/hub/v1/rooms/candidates/group/group-rd1" ? { status: 200, body: { kind: "group", id: "group-rd1", name: "Pilot direct group", people: 1 } } : null);
      await pg.mount(h(dlg.NewRoomDialog, { client, assistant: false })); await settle(10);
      await search(pg, "hubRoomPeople", "研發一"); await pick(pg, "hubRoomPeople", "研發一部"); await settle(10);
      expect(tags(pg, "hubRoomPeople").at(-1)).toBe(lang === "en" ? "Pilot direct group · 1 person" : "Pilot direct group · 1 人");
    }
  });

  it("a picked item is not offered again, and × removes it", async () => {
    const { pg, client } = await fixture("en");
    await pg.mount(h(dlg.NewRoomDialog, { client, assistant: false })); await settle(10);
    await search(pg, "hubRoomPeople", "陳"); await pick(pg, "hubRoomPeople", "陳主任");
    await search(pg, "hubRoomPeople", "陳"); expect(pg.root.textContent).toContain("Nothing matches.");
    fire([...pg.root.querySelectorAll(".hub-room-tags button")].find((x: any) => x.getAttribute("aria-label") === "Remove 陳主任"), "click"); await settle(5);
    expect(tags(pg, "hubRoomPeople")).toEqual(["You · Manager"]);
  });

  it("the assistant switch only when the Hub offers it (read from the list when not passed); off unless switched on", async () => {
    const { pg, client, calls } = await fixture("en");
    await pg.mount(h(dlg.NewRoomDialog, { client })); await settle(20);
    expect(calls.some(c => c.path.split("?")[0] === "/hub/v1/rooms" && c.method === "GET")).toBe(true);   // any version (?v=2 since #3848)
    expect(pg.root.querySelector("#hubRoomAssistant").checked).toBe(false);                 // me.assistant: true in the list
    await type(pg, "hubRoomName", "R"); fire(button(pg, "Create"), "click"); await settle(20);
    expect(calls.find(c => c.method === "POST")!.body.assistant).toBe(false);
  });

  it("no assistant switch when the list says the Hub has none", async () => {
    const { pg, client } = await fixture("en", (path, init) => path.split("?")[0] === "/hub/v1/rooms" && (init.method ?? "GET") === "GET" ? { status: 200, body: { rooms: [], me: { canCreateRooms: true, assistant: false }, invitations: 0 } } : null);
    await pg.mount(h(dlg.NewRoomDialog, { client })); await settle(20);
    expect(pg.root.querySelector("#hubRoomAssistant")).toBeNull();
  });

  it("a refused create says so and can be sent again; while it is on its way, a second press sends nothing", async () => {
    let refuse = true, release!: () => void; const held = new Promise<void>(r => { release = r; });
    const { pg, client, calls } = await fixture("en", (path, init) => refuse && path === "/hub/v1/rooms" && init.method === "POST" ? { status: 500, body: {} } : null);
    await pg.mount(h(dlg.NewRoomDialog, { client, assistant: false })); await settle(10);
    await type(pg, "hubRoomName", "R");
    fire(button(pg, "Create"), "click"); await settle(20);
    expect(pg.root.querySelector(".hub-room-new-error").textContent).toBe("The room was not created. Try again.");
    refuse = false;
    const slow = { ...client, createRoom: async (input: any) => { await held; return client.createRoom(input); } };
    await pg.unmount(); await pg.mount(h(dlg.NewRoomDialog, { client: slow, assistant: false })); await settle(10);
    await type(pg, "hubRoomName", "R");
    fire(button(pg, "Create"), "click"); await settle(5); fire(button(pg, "Create"), "click"); release(); await settle(20);
    expect(calls.filter(c => c.method === "POST" && c.path === "/hub/v1/rooms")).toHaveLength(2);   // the refused one and one more
  });
});
