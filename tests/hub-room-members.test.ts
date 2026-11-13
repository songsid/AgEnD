/**
 * Hub rooms, the members panel (docs/design/hub-rooms-ux.md section 5) against the seam-1 fixture: the counts, the agents
 * in presence order with the Fleet sidebar's dots, the 8-row fold, the assistant, the agent card (@, one-to-one when
 * allowed, remove for a manager), and the stream (presence.changed in place, member.changed reads again).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";

let clientModule: any, panel: any, i18n: any;
const mounted: AppPage[] = [];
const realEventSource = (globalThis as any).EventSource;
beforeAll(async () => {
  const pg = page();
  clientModule = await import("/ui/js/hub-client.js"); panel = await import("/ui/js/hub-room-members.js"); i18n = await import("/assets/app-i18n.js");
  pg.restore();
});
afterEach(async () => {
  for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); }
  (globalThis as any).EventSource = realEventSource; i18n.setLang("en", { store: false });
});
async function fixture(lang: "en" | "zh-TW" = "zh-TW") {
  const fx = createHubRoomsFixture(), calls: Array<{ path: string; method: string }> = [];
  const fetchImpl = async (path: string, init: any = {}) => { calls.push({ path, method: init.method ?? "GET" }); return fx.fetch(path, init); };
  const pg = page({ url: "http://127.0.0.1:19443/ui/hub" }); mounted.push(pg);
  (globalThis as any).EventSource = fx.EventSource; i18n.setLang(lang, { store: false });
  const client = clientModule.createHubWebClient({ fetchImpl }); await client.session();
  return { fx, client, calls, pg };
}
async function detailOf(client: any, roomId: string, canAsk: string[] = []) {
  const d = await client.room(roomId);
  return { room: d.room, me: { ...d.me, id: FIXTURE_ME.id }, members: d.members.map((m: any) => canAsk.includes(m.id) ? { ...m, canAsk: true } : m), settings: d.settings, invited: d.invited };
}
const heads = (pg: AppPage) => [...pg.root.querySelectorAll(".hub-room-members h4")].map((x: any) => x.textContent);
const agentRows = (pg: AppPage) => [...pg.root.querySelectorAll(".hub-member-agent .hub-member-open")].map((b: any) => [b.querySelector(".hub-member-name").textContent, b.querySelector(".dot").className, b.querySelector(".hub-member-state").textContent]);
const button = (pg: AppPage, label: string) => [...pg.root.querySelectorAll("button")].find((b: any) => b.textContent === label);

describe("Hub room members panel (section 5)", () => {
  it("counts people and agents online; me and the manager are marked; agents in presence order with the Fleet dots; 8 then a fold", async () => {
    const { pg, client } = await fixture();
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail: await detailOf(client, "room-weekly") })); await settle(20);
    expect(heads(pg)).toEqual(["成員 · 3（線上 2）", "Agent · 12（線上 9）", "誰看得到"]);
    const people = [...pg.root.querySelectorAll(".hub-member:not(.hub-member-agent):not(.hub-member-assistant)")].map((li: any) => li.textContent);
    expect(people).toEqual(["王經理 你 管理線上", "陳主任線上", "吳小安離線"]);
    expect(agentRows(pg)).toEqual([
      ["project-helper", "dot busy", "處理中"], ["budget-check", "dot busy", "處理中"],
      ["spec-writer", "dot ok", "待命"], ["release-notes", "dot ok", "待命"], ["test-runner", "dot ok", "待命"], ["doc-search", "dot ok", "待命"], ["design-review", "dot ok", "待命"],
      ["schedule-bot", "dot warn", "暫停 · 額度用完"],
    ]);
    fire(button(pg, "… 其餘 4 個"), "click"); await settle(5);
    expect(agentRows(pg).slice(8)).toEqual([["infra-watch", "dot warn", "暫停 · 等待登入"], ["report-bot", "dot off", "離線"], ["old-helper", "dot off", "需要更新 AgEnD"], ["desk-notes", "dot off", "上線時回答"]]);
    expect(button(pg, "收合")).toBeTruthy();
    expect(pg.root.querySelector(".hub-member-assistant").textContent).toBe("房間助理待命 · Hub 提供");
    expect(pg.root.querySelector(".hub-room-who p").textContent).toBe("房間裡的每個人都看得到所有訊息與回答。Agent 被 @ 時會讀到最近的對話。");
    expect(pg.root.querySelector(".hub-member-agent .hub-member-open").getAttribute("title")).toBe("擁有者：林小華");
  });

  it("a manager sees Room settings and may remove an agent; the card offers one-to-one only when I may ask it", async () => {
    const { pg, client, calls } = await fixture("en");
    let settings = 0; const mentioned: string[] = [], direct: string[] = [];
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail: await detailOf(client, "room-weekly", ["exp-01"]),
      onSettings: () => { settings++; }, onMention: (m: any) => mentioned.push(m.id), onOpenChat: (m: any) => direct.push(m.id) })); await settle(20);
    fire(button(pg, "Room settings"), "click"); expect(settings).toBe(1);
    fire(pg.root.querySelector(".hub-member-agent .hub-member-open"), "click"); await settle(5);
    const card = pg.root.querySelector(".hub-member-card");
    expect(card.textContent).toContain("Owner: 林小華"); expect(card.textContent).toContain("Working");
    fire(button(pg, "@ it here"), "click"); expect(mentioned).toEqual(["exp-01"]); await settle(5);
    fire(pg.root.querySelector(".hub-member-agent .hub-member-open"), "click"); await settle(5);
    fire(button(pg, "Chat with it one-to-one"), "click"); expect(direct).toEqual(["exp-01"]); await settle(5);
    fire(pg.root.querySelectorAll(".hub-member-agent .hub-member-open")[1], "click"); await settle(5);
    expect(button(pg, "Chat with it one-to-one")).toBeUndefined();                     // budget-check: not mine to ask
    fire(button(pg, "Remove from the room"), "click"); await settle(20);
    expect(calls.filter(c => c.method === "DELETE").map(c => c.path)).toEqual(["/hub/v1/rooms/room-weekly/members/exp-06"]);
    expect(agentRows(pg).map(r => r[0])).not.toContain("budget-check");
    expect(heads(pg)[1]).toBe("Agents · 11 (8 online)");
  });

  it("a plain member: no Room settings, no remove", async () => {
    const { pg, client } = await fixture("en");
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-rd", detail: await detailOf(client, "room-rd") })); await settle(20);
    expect(button(pg, "Room settings")).toBeUndefined();
    expect(pg.root.querySelector(".hub-member").textContent).toBe("王經理 YouOnline");
    fire(pg.root.querySelector(".hub-member-agent .hub-member-open"), "click"); await settle(5);
    expect(button(pg, "Remove from the room")).toBeUndefined();
    expect(pg.root.querySelector(".hub-member-assistant")).toBeNull();
  });

  it("presence.changed moves one agent in place until the shell's next detail; another room's events are ignored; nothing is read here", async () => {
    const { pg, client, fx, calls } = await fixture();
    let detail = await detailOf(client, "room-weekly");
    const before = calls.length;
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail })); await settle(20);
    fx.emit("presence.changed", { roomId: "room-weekly", memberId: "exp-02", presence: "paused", presenceNote: "等待核准" }); await settle(10);
    expect(agentRows(pg).find(r => r[0] === "spec-writer")).toEqual(["spec-writer", "dot warn", "暫停 · 等待核准"]);
    expect(heads(pg)[1]).toBe("Agent · 12（線上 9）");
    fx.emit("presence.changed", { roomId: "room-rd", memberId: "exp-01", presence: "offline" }); await settle(10);
    expect(agentRows(pg)[0]).toEqual(["project-helper", "dot busy", "處理中"]);
    fx.emit("member.changed", { roomId: "room-weekly" }); await settle(20);
    expect(calls.slice(before).filter(c => c.path.startsWith("/hub/v1/rooms/"))).toEqual([]);   // the shell owns the detail
    detail = await detailOf(client, "room-weekly");
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail })); await settle(20);
    expect(agentRows(pg).find(r => r[0] === "spec-writer")).toEqual(["spec-writer", "dot ok", "待命"]);
  });

  it("no detail yet: an empty, busy rail", async () => {
    const { pg, client } = await fixture("en");
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly" })); await settle(10);
    expect(pg.root.querySelector(".hub-room-members").getAttribute("aria-busy")).toBe("true");
  });
});
