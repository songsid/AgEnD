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
const agentRows = (pg: AppPage) => [...pg.root.querySelectorAll(".hub-member-agent .hub-member-open")].map((b: any) => [b.querySelector(".hub-member-name").textContent, b.querySelector(".dot").className, b.querySelector(".hub-member-state > span:not(.dot):not(.hub-member-owner)").textContent]);
const owners = (pg: AppPage) => [...pg.root.querySelectorAll(".hub-member-agent .hub-member-open")].map((b: any) => [b.querySelector(".hub-member-name").textContent, b.querySelector(".hub-member-owner")?.textContent ?? null]);
const openAgent = (pg: AppPage, name: string) => fire([...pg.root.querySelectorAll(".hub-member-agent .hub-member-open")].find((b: any) => b.querySelector(".hub-member-name").textContent === name), "click");
const button = (pg: AppPage, label: string) => [...pg.root.querySelectorAll("button")].find((b: any) => b.textContent === label);

describe("Hub room members panel (section 5)", () => {
  it("counts people and agents online (paused is not online); me and the manager are marked; agents in presence order, by name within one, with the Fleet dots; 8 then a fold", async () => {
    const { pg, client } = await fixture();
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail: await detailOf(client, "room-weekly") })); await settle(20);
    expect(heads(pg)).toEqual(["成員 · 3（線上 2）", "Agent · 12（線上 7）", "誰看得到"]);   // hub-room-presence headerCounts: online/idle/working
    const people = [...pg.root.querySelectorAll(".hub-member:not(.hub-member-agent):not(.hub-member-assistant)")].map((li: any) => li.textContent);
    expect(people).toEqual(["王經理 你 管理線上", "陳主任線上", "吳小安離線"]);
    expect(agentRows(pg)).toEqual([
      ["budget-check", "dot busy", "處理中"], ["project-helper", "dot busy", "處理中"],
      ["design-review", "dot ok", "待命"], ["doc-search", "dot ok", "待命"], ["release-notes", "dot ok", "待命"], ["spec-writer", "dot ok", "待命"], ["test-runner", "dot ok", "待命"],
      ["infra-watch", "dot warn", "暫停 · 等待登入"],
    ]);
    fire(button(pg, "… 其餘 4 個"), "click"); await settle(5);
    expect(agentRows(pg).slice(8)).toEqual([["schedule-bot", "dot warn", "暫停 · 額度用完"], ["old-helper", "dot off", "需要更新 AgEnD"], ["report-bot", "dot off", "離線"], ["desk-notes", "dot off", "上線時回答"]]);
    expect(button(pg, "收合")).toBeTruthy();
    expect(pg.root.querySelector(".hub-member-assistant").textContent).toBe("房間助理待命 · Hub 提供");
    expect(pg.root.querySelector(".hub-room-who p").textContent).toBe("房間裡的每個人都看得到所有訊息與回答。Agent 被 @ 時會讀到最近的對話。");
    expect(pg.root.querySelector(".hub-member-agent .hub-member-open").getAttribute("title")).toBe("擁有者：吳小安");
  });

  it("a manager sees Room settings and may remove an agent; the card offers one-to-one only when I may ask it", async () => {
    const { pg, client, calls } = await fixture("en");
    let settings = 0; const mentioned: string[] = [], direct: string[] = [];
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail: await detailOf(client, "room-weekly", ["exp-01"]),
      onSettings: () => { settings++; }, onMention: (m: any) => mentioned.push(m.id), onOpenChat: (m: any) => direct.push(m.id) })); await settle(20);
    fire(button(pg, "Room settings"), "click"); expect(settings).toBe(1);
    openAgent(pg, "project-helper"); await settle(5);
    const card = pg.root.querySelector(".hub-member-card");
    expect(card.textContent).toContain("Owner: 林小華"); expect(card.textContent).toContain("Working");
    fire(button(pg, "@ it here"), "click"); expect(mentioned).toEqual(["exp-01"]); await settle(5);
    openAgent(pg, "project-helper"); await settle(5);
    fire(button(pg, "Chat with it one-to-one"), "click"); expect(direct).toEqual(["exp-01"]); await settle(5);
    openAgent(pg, "budget-check"); await settle(5);
    expect(button(pg, "Chat with it one-to-one")).toBeUndefined();                     // budget-check: not mine to ask
    fire(button(pg, "Remove from room"), "click"); await settle(20);
    expect(calls.filter(c => c.method === "DELETE").map(c => c.path)).toEqual(["/hub/v1/rooms/room-weekly/members/exp-06"]);
    expect(agentRows(pg).map(r => r[0])).not.toContain("budget-check");
    expect(heads(pg)[1]).toBe("Agents · 11 (online 6)");
  });

  it("a plain member: no Room settings, no remove", async () => {
    const { pg, client } = await fixture("en");
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-rd", detail: await detailOf(client, "room-rd") })); await settle(20);
    expect(button(pg, "Room settings")).toBeUndefined();
    expect(pg.root.querySelector(".hub-member").textContent).toBe("王經理 YouOnline");
    fire(pg.root.querySelector(".hub-member-agent .hub-member-open"), "click"); await settle(5);
    expect(button(pg, "Remove from room")).toBeUndefined();
    expect(pg.root.querySelector(".hub-member-assistant")).toBeNull();
  });

  it("presence.changed moves one agent in place until the shell's next detail; another room's events are ignored; nothing is read here", async () => {
    const { pg, client, fx, calls } = await fixture();
    let detail = await detailOf(client, "room-weekly");
    const before = calls.length;
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail })); await settle(20);
    fx.emit("presence.changed", { roomId: "room-weekly", memberId: "exp-02", presence: "paused", presenceNote: "等待核准" }); await settle(10);
    fire(button(pg, "… 其餘 4 個"), "click"); await settle(5);                          // paused now: past the first 8
    expect(agentRows(pg).find(r => r[0] === "spec-writer")).toEqual(["spec-writer", "dot warn", "暫停 · 等待核准"]);
    expect(heads(pg)[1]).toBe("Agent · 12（線上 6）");
    fx.emit("presence.changed", { roomId: "room-rd", memberId: "exp-01", presence: "offline" }); await settle(10);
    expect(agentRows(pg)[1]).toEqual(["project-helper", "dot busy", "處理中"]);
    fx.emit("member.changed", { roomId: "room-weekly" }); await settle(20);
    expect(calls.slice(before).filter(c => c.path.startsWith("/hub/v1/rooms/"))).toEqual([]);   // the shell owns the detail
    detail = await detailOf(client, "room-weekly");
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail })); await settle(20);
    expect(agentRows(pg).find(r => r[0] === "spec-writer")).toEqual(["spec-writer", "dot ok", "待命"]);
  });

  it("a person added before their first Hub sign-in reads 還沒登入過 Hub (grey), not 離線", async () => {
    const { pg, client } = await fixture();
    const d = await detailOf(client, "room-weekly");
    d.members = d.members.map((m: any) => m.id === "person-wu" ? { ...m, signedIn: false } : m);
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail: d })); await settle(20);
    const wu = [...pg.root.querySelectorAll(".hub-member")].find((li: any) => li.textContent.startsWith("吳小安"));
    expect(wu.textContent).toBe("吳小安還沒登入過 Hub");
    expect(wu.querySelector(".dot").className).toBe("dot off");
  });

  it("people: me first, then online, then offline and never signed in; no agents: 「還沒有 Agent。…」 instead of a zero count", async () => {
    const { pg, client } = await fixture();
    const d = await detailOf(client, "room-weekly");
    const byId = (id: string) => d.members.find((m: any) => m.id === id);
    d.members = [{ ...byId("person-wu") }, { id: "person-new", kind: "person", name: "張新人", role: "member", presence: "offline", signedIn: false },
      { ...byId("person-chen") }, { ...byId(FIXTURE_ME.id), presence: "offline" }];
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail: d })); await settle(20);
    const people = [...pg.root.querySelectorAll(".hub-member")].map((li: any) => li.querySelector(".hub-member-name").textContent);
    expect(people).toEqual(["王經理 你 管理", "陳主任", "吳小安", "張新人"]);
    expect(heads(pg)).toEqual(["成員 · 4（線上 1）", "Agent", "誰看得到"]);
    expect(pg.root.querySelector(".hub-room-no-agents .note").textContent).toBe("還沒有 Agent。房間管理可以在房間設定加入或邀請。");
    expect(pg.root.textContent).not.toContain("線上 0");
  });

  it("reason codes and known notes read in the viewer's language (never the Fleet's note text); an unknown code shows the plain state", async () => {
    const { pg, client } = await fixture("en");
    const d = await detailOf(client, "room-weekly");
    const set = (id: string, patch: any) => { d.members = d.members.map((m: any) => m.id === id ? { ...m, ...patch } : m); };
    set("exp-01", { presence: "paused", presenceReason: "approval", presenceNote: "等待核准" });
    set("exp-06", { presence: "paused", presenceReason: "bogus-code", presenceNote: undefined });
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail: d })); await settle(20);
    fire(button(pg, "… 4 more"), "click"); await settle(5);
    const rows = agentRows(pg);
    expect(rows.find(r => r[0] === "project-helper")).toEqual(["project-helper", "dot warn", "Paused · Waiting for approval"]);
    expect(rows.find(r => r[0] === "schedule-bot")).toEqual(["schedule-bot", "dot warn", "Paused · Out of quota"]);   // the fixture's 「額度用完」 note
    expect(rows.find(r => r[0] === "budget-check")).toEqual(["budget-check", "dot warn", "Paused"]);
    expect(rows.find(r => r[0] === "old-helper")).toEqual(["old-helper", "dot off", "Needs an AgEnD update"]);
  });

  it("presence.changed carries the reason code: a reason-only event reads in the viewer's language; an event without one clears it", async () => {
    const { pg, client, fx } = await fixture("en");
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail: await detailOf(client, "room-weekly") })); await settle(20);
    const row = (name: string) => agentRows(pg).find(r => r[0] === name);
    fx.emit("presence.changed", { roomId: "room-weekly", memberId: "exp-01", presence: "paused", presenceReason: "quota" }); await settle(10);   // no note
    fire(button(pg, "… 4 more"), "click"); await settle(5);
    expect(row("project-helper")).toEqual(["project-helper", "dot warn", "Paused · Out of quota"]);
    fx.emit("presence.changed", { roomId: "room-weekly", memberId: "exp-01", presence: "paused" }); await settle(10);   // reason omitted: cleared
    expect(row("project-helper")).toEqual(["project-helper", "dot warn", "Paused"]);
    fx.emit("presence.changed", { roomId: "room-weekly", memberId: "exp-08", presence: "idle" }); await settle(10);   // schedule-bot's seeded note goes too
    expect(row("schedule-bot")).toEqual(["schedule-bot", "dot ok", "Idle"]);
  });

  it("every agent row's second line says whose agent it is beside its state, in the viewer's language; people and the assistant have none", async () => {
    const { pg, client } = await fixture();
    const d = await detailOf(client, "room-weekly");
    // The fixture's membership contract: every agent member carries owner { name } (the panel never reads it elsewhere).
    expect(d.members.filter((m: any) => m.kind === "agent" || m.kind === "later").every((m: any) => typeof m.owner?.name === "string" && m.owner.name)).toBe(true);
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail: d })); await settle(20);
    expect(owners(pg).slice(0, 3)).toEqual([["budget-check", "· 吳小安的 Agent"], ["project-helper", "· 林小華的 Agent"], ["design-review", "· 林小華的 Agent"]]);
    expect(pg.root.querySelector(".hub-member-agent .hub-member-state").textContent).toBe("處理中· 吳小安的 Agent");
    expect(pg.root.querySelectorAll(".hub-member:not(.hub-member-agent) .hub-member-owner")).toHaveLength(0);
    i18n.setLang("en", { store: false }); await pg.unmount();
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly", detail: d })); await settle(20);
    expect(owners(pg)[1]).toEqual(["project-helper", "· 林小華's agent"]);
  });

  it("no detail yet: an empty, busy rail", async () => {
    const { pg, client } = await fixture("en");
    await pg.mount(h(panel.RoomMembersPanel, { client, roomId: "room-weekly" })); await settle(10);
    expect(pg.root.querySelector(".hub-room-members").getAttribute("aria-busy")).toBe("true");
  });
});
