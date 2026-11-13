/**
 * M2 (Hub rooms, spec §2): hub-room-list-model.js against the seam-1 fixture.
 * Groups come out in the spec's order in EN and zh-TW; every row renders its
 * avatar, title, line2, mentioned flag and dot; a legacyRoom() item from an
 * old server gets no dot and no unread.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";
// @ts-expect-error browser module
import { legacyRoom } from "../src/ui/hub-client.js";

let M: any;
let i18n: any;
let hroom: (key: string, ...values: unknown[]) => string;

beforeAll(async () => {
  // @ts-expect-error browser module without types
  M = await import("../src/ui/hub-room-list-model.js");
  // @ts-expect-error browser module without types
  ({ hroom } = await import("../src/ui/hub-room-strings.js"));
  i18n = await import("/assets/app-i18n.js");
});
afterEach(() => { i18n.setLang("en", { store: false }); });

const listOf = (fx: any) => fx.handle({ method: "GET", path: "/hub/v1/rooms" }).body.rooms;
const byId = (fx: any, id: string) => listOf(fx).find((r: any) => r.id === id);
const roomsOf = (fx: any) => [
  ...M.groupRooms(listOf(fx))[0].rooms.map((r: any) => r.name),
  ...M.groupRooms(listOf(fx))[1].rooms.map((r: any) => r.name),
];

describe("groupRooms", () => {
  it("lists 房間 then Agent, unread first, then by lastAt, archived last", () => {
    const fx = createHubRoomsFixture();
    const [groups, agents] = M.groupRooms(listOf(fx));
    expect(groups.rooms.map((r: any) => r.name)).toEqual(["研一主管週會", "研發例會", "去年專案"]);
    expect(agents.rooms.map((r: any) => r.name)).toEqual(["project-helper", "report-bot", "Hub 助理"]);
  });
  it("labels both groups in each language", () => {
    const fx = createHubRoomsFixture();
    i18n.setLang("zh-TW", { store: false });
    expect(M.groupRooms(listOf(fx)).map((g: any) => g.label)).toEqual(["房間", "Agent"]);
    i18n.setLang("en", { store: false });
    expect(M.groupRooms(listOf(fx)).map((g: any) => g.label)).toEqual(["Rooms", "Agents"]);
  });
  it("orders the fixture's six rooms the way the spec lists them", () => {
    const fx = createHubRoomsFixture();
    i18n.setLang("en", { store: false });
    expect(roomsOf(fx)).toEqual(["研一主管週會", "研發例會", "去年專案", "project-helper", "report-bot", "Hub 助理"]);
    i18n.setLang("zh-TW", { store: false });
    expect(roomsOf(fx)).toEqual(["研一主管週會", "研發例會", "去年專案", "project-helper", "report-bot", "Hub 助理"]);
  });
});

describe("rowView", () => {
  it("a group row: square avatar, counts line, no dot", () => {
    const fx = createHubRoomsFixture();
    i18n.setLang("zh-TW", { store: false });
    const room = byId(fx, "room-weekly");
    expect(M.rowView(room)).toEqual({ avatar: { shape: "square", text: "研" }, title: "研一主管週會", line2: "3 人 · 12 個 Agent", mentioned: false, dot: null, unread: 2 });
    i18n.setLang("en", { store: false });
    expect(M.rowView(room).line2).toBe("3 people · 12 agents");
  });
  it("a direct row: round avatar, owner line, the agent's dot", () => {
    const fx = createHubRoomsFixture();
    const helper = byId(fx, "room-helper");
    expect(M.rowView(helper)).toEqual({ avatar: { shape: "round" }, title: "project-helper", line2: "林小華", mentioned: false, dot: "working", unread: 0 });
    const report = byId(fx, "room-report");
    expect(M.rowView(report).dot).toBe("offline");
  });
  it("the Hub assistant row names its provider", () => {
    const fx = createHubRoomsFixture();
    const hub = byId(fx, "room-assistant");
    i18n.setLang("zh-TW", { store: false });
    expect(M.rowView(hub)).toEqual({ avatar: { shape: "round" }, title: "Hub 助理", line2: "Hub 提供", mentioned: false, dot: null, unread: 0 });
    i18n.setLang("en", { store: false });
    expect(M.rowView(hub).line2).toBe("Provided by the Hub");
  });
  it("a legacyRoom() item renders with no dot and no unread", () => {
    const item = legacyRoom({ id: "x1", exposureName: "Old", ownerName: "Ann", lastAt: 5 });
    expect(M.rowView(item)).toEqual({ avatar: { shape: "round" }, title: "Old", line2: "Ann", mentioned: false, dot: null, unread: null });
  });
  it("mentioned flags pass through", () => {
    expect(M.rowView({ kind: "group", name: "R", people: 1, agents: 0, mentioned: true, unread: 3, lastAt: 1 }).mentioned).toBe(true);
  });
});
