/**
 * Hub rooms, Room settings (docs/design/hub-rooms-ux.md section 7) against the seam-1 fixture and its U2 block: the
 * basics (name, @All, history for new members), the people and agent rows' menus (role, remove; the last manager is
 * refused), adding and inviting with the pickers, the room's invitations (cancel; 重新邀請 once expired), the assistant
 * switch, archiving after a confirmation, and leaveRoom(). Each change is sent at once and asks the shell to read the
 * room again (onChanged).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";

let clientModule: any, mod: any, i18n: any, hooks: any, confirm: any;
const mounted: AppPage[] = [];
const realEventSource = (globalThis as any).EventSource;
beforeAll(async () => {
  const pg = page();
  clientModule = await import("/ui/js/hub-client.js"); mod = await import("/ui/js/hub-room-settings.js"); i18n = await import("/assets/app-i18n.js");
  hooks = await import("/assets/app-html.js"); confirm = await import("/assets/ui-confirm.js");
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
/** The shell's part: hold the detail, read it again on onChanged. */
async function mountSettings(pg: AppPage, client: any, roomId = "room-weekly", extra: any = {}) {
  const changed: number[] = [];
  const first = await client.room(roomId);
  function Host() {
    const [detail, setDetail] = hooks.useState(first);
    return h(mod.RoomSettings, { client, roomId, detail, assistant: true, ...extra,
      onChanged: async () => { changed.push(1); setDetail(await client.room(roomId)); } });
  }
  await pg.mount(h("div", null, h(Host, {}), h(confirm.ConfirmHost, {}))); await settle(20);
  return changed;
}
const writes = (calls: any[]) => calls.filter(c => c.method !== "GET").map(c => [c.method, c.path, c.body]);
const button = (pg: AppPage, label: string) => [...pg.document.querySelectorAll("button")].find((b: any) => b.textContent.trim() === label);
async function menu(pg: AppPage, rowId: string, item: string) {
  const row = pg.root.querySelector(`[data-member="${rowId}"]`); expect(row, rowId).toBeTruthy();
  fire(row.querySelector("button"), "click"); await settle(10);
  const it = [...pg.document.querySelectorAll("[role=menuitem]")].find((x: any) => x.textContent.trim() === item);
  expect(it, item).toBeTruthy(); fire(it, "click"); await settle(30);
}
async function search(pg: AppPage, id: string, value: string) { const el = pg.root.querySelector(`#${id}`); el.value = value; fire(el, "input"); await wait(260); await settle(10); }
async function pick(pg: AppPage, id: string, starts: string) {
  const b = [...pg.root.querySelector(`#${id}`).parentElement.querySelectorAll(".hub-room-result")].find((x: any) => x.textContent.trim().startsWith(starts));
  expect(b, starts).toBeTruthy(); fire(b, "click"); await settle(30);
}
const error = (pg: AppPage) => pg.root.querySelector(".hub-room-settings-error")?.textContent ?? null;

describe("Hub Room settings (section 7)", () => {
  it("基本: rename with 儲存; @All and history are sent at once; each change asks the shell to read again; an empty name is refused", async () => {
    const { pg, client, calls } = await fixture();
    const changed = await mountSettings(pg, client); calls.length = 0;
    const name = pg.root.querySelector("#hubRoomSettingsName");
    expect(name.value).toBe("研一主管週會"); expect(button(pg, "儲存").disabled).toBe(true);
    name.value = "研一週會"; fire(name, "input"); await settle(5);
    fire(button(pg, "儲存"), "click"); await settle(30);
    const allMention = pg.root.querySelector("#hubRoomAllMention"); expect(allMention.checked).toBe(true);
    allMention.checked = false; fire(allMention, "change"); await settle(30);
    const all = [...pg.root.querySelectorAll("input[name=hubRoomHistory]")].find((x: any) => x.value === "all"); all.checked = true; fire(all, "change"); await settle(30);
    expect(writes(calls)).toEqual([["PATCH", "/hub/v1/rooms/room-weekly", { name: "研一週會" }], ["PATCH", "/hub/v1/rooms/room-weekly", { allMention: false }], ["PATCH", "/hub/v1/rooms/room-weekly", { historyForNew: "all" }]]);
    expect(changed).toHaveLength(3);
    expect(pg.root.querySelector("#hubRoomAllMention").checked).toBe(false);
    name.value = "  "; fire(name, "input"); await settle(5); fire(button(pg, "儲存"), "click"); await settle(10);
    expect(error(pg)).toBe("請輸入房間名稱。");
  });

  it("rows: make a person room manager, then step down; the last manager cannot; remove an agent", async () => {
    const { pg, client, calls } = await fixture();
    await mountSettings(pg, client); calls.length = 0;
    await menu(pg, FIXTURE_ME.id, "改為成員");
    expect(error(pg)).toBe("請先把另一個人設為房間管理。");
    await menu(pg, "person-chen", "設為房間管理");
    await menu(pg, FIXTURE_ME.id, "改為成員");
    await menu(pg, "exp-03", "從房間移除");
    expect(writes(calls)).toEqual([
      ["PATCH", `/hub/v1/rooms/room-weekly/members/${FIXTURE_ME.id}`, { role: "member" }],
      ["PATCH", "/hub/v1/rooms/room-weekly/members/person-chen", { role: "manager" }],
      ["PATCH", `/hub/v1/rooms/room-weekly/members/${FIXTURE_ME.id}`, { role: "member" }],
      ["DELETE", "/hub/v1/rooms/room-weekly/members/exp-03", undefined],
    ]);
    expect(error(pg)).toBeNull();
    expect(pg.root.querySelector('[data-member="exp-03"]')).toBeNull();
  });

  it("adding: a person joins; my agent joins; someone else's agent and a team's agents are invited; members already in are not offered", async () => {
    const { pg, client, calls } = await fixture();
    await mountSettings(pg, client, "room-rd"); calls.length = 0;
    await search(pg, "hubRoomAddPeople", "陳");
    expect(pg.root.querySelector("#hubRoomAddPeople").parentElement.textContent).toContain("找不到符合的結果。");   // 陳主任 is in
    await search(pg, "hubRoomAddPeople", "吳"); await pick(pg, "hubRoomAddPeople", "吳小安");
    await search(pg, "hubRoomAddAgents", "my-"); await pick(pg, "hubRoomAddAgents", "my-notes");
    await search(pg, "hubRoomAddAgents", "budget"); await pick(pg, "hubRoomAddAgents", "budget-check");
    await search(pg, "hubRoomAddAgents", "研一"); await pick(pg, "hubRoomAddAgents", "「研一」所有人的 Agent");
    expect(writes(calls)).toEqual([
      ["POST", "/hub/v1/rooms/room-rd/members", { kind: "person", id: "person-wu" }],
      ["POST", "/hub/v1/rooms/room-rd/members", { kind: "agent", id: "exp-mine-1" }],
      ["POST", "/hub/v1/rooms/room-rd/invitations", { agents: ["exp-06"] }],
      ["POST", "/hub/v1/rooms/room-rd/invitations", { team: "team-1" }],
    ]);
  });

  it("the room's invitations: a pending one can be cancelled; an expired one (7 days) can be sent again", async () => {
    const { pg, client, calls, fx } = await fixture();
    const room = fx.rooms.find((r: any) => r.id === "room-weekly");
    room.invited.push({ id: "inv-old", exposureId: "exp-91", name: "old-audit", owner: "林小華", at: 1, state: "expired" });
    await mountSettings(pg, client); calls.length = 0;
    const rows = [...pg.root.querySelectorAll(".hub-settings-invited li")].map((li: any) => li.textContent.replace(/\s+/g, " ").trim());
    expect(rows).toEqual(["audit-helper（周小明）· 已邀請，等擁有者同意取消邀請", "old-audit（林小華）· 邀請已過期重新邀請"]);
    fire(button(pg, "重新邀請"), "click"); await settle(30);
    fire(button(pg, "取消邀請"), "click"); await settle(30);
    expect(writes(calls)).toEqual([
      ["POST", "/hub/v1/rooms/room-weekly/invitations", { agents: ["exp-91"] }],
      ["DELETE", "/hub/v1/rooms/room-weekly/invitations/inv-old", undefined],
      ["DELETE", "/hub/v1/rooms/room-weekly/invitations/inv-0001", undefined],
    ]);
  });

  it("the assistant switch follows the room; off removes it, on adds it; hidden when the Hub has none and the room has none", async () => {
    const { pg, client, calls } = await fixture("en");
    await mountSettings(pg, client); calls.length = 0;
    const sw = pg.root.querySelector("#hubRoomSettingsAssistant"); expect(sw.checked).toBe(true);
    sw.checked = false; fire(sw, "change"); await settle(30);
    expect(pg.root.querySelector("#hubRoomSettingsAssistant").checked).toBe(false);
    const again = pg.root.querySelector("#hubRoomSettingsAssistant"); again.checked = true; fire(again, "change"); await settle(30);
    expect(writes(calls)).toEqual([["DELETE", "/hub/v1/rooms/room-weekly/members/assistant", undefined], ["POST", "/hub/v1/rooms/room-weekly/members", { kind: "assistant" }]]);
    await pg.unmount();
    await mountSettings(pg, client, "room-rd", { assistant: false });
    expect(pg.root.querySelector("#hubRoomSettingsAssistant")).toBeNull();
  });

  it("封存房間 asks first: 取消 sends nothing; 封存 archives and closes", async () => {
    const { pg, client, calls } = await fixture();
    const prior = (globalThis as any).confirm; (globalThis as any).confirm = undefined;   // drive the app's own dialog (app-harness)
    try {
    let closed = 0;
    await mountSettings(pg, client, "room-weekly", { onClose: () => { closed++; } }); calls.length = 0;
    fire(button(pg, "封存房間"), "click"); await settle(10);
    expect(pg.document.body.textContent).toContain("要封存「研一主管週會」嗎？房間會變成唯讀，內容仍然看得到。");
    fire(button(pg, "取消"), "click"); await settle(20);
    expect(writes(calls)).toEqual([]);
    fire(button(pg, "封存房間"), "click"); await settle(10);
    fire(pg.document.querySelector("[data-confirm=yes]"), "click"); await settle(30);
    expect(writes(calls)).toEqual([["PATCH", "/hub/v1/rooms/room-weekly", { archived: true }]]);
    expect(closed).toBe(1);
    } finally { (globalThis as any).confirm = prior; }
  });

  it("leaveRoom: removes me; the last manager is told to hand the role on", async () => {
    const { client } = await fixture("zh-TW", (path, init) => init.method === "DELETE" && path.endsWith("/room-weekly/members/person-wang") ? { status: 409, body: { code: "last-manager" } } : null);
    expect(await mod.leaveRoom(client, "room-weekly", FIXTURE_ME.id)).toEqual({ ok: false, text: "請先把另一個人設為房間管理。" });
    expect(await mod.leaveRoom(client, "room-rd", FIXTURE_ME.id)).toEqual({ ok: true });
  });
});
