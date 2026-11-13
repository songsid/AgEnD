/**
 * M-3092 (Hub rooms, track U, PR 1a): src/ui/hub-client.js's seam 1/3/5 calls against tests/support/hub-rooms-fixture.ts,
 * the contract's worked example (docs/design/hub-rooms-split.md; docs/design/hub-rooms-ux.md for the seed's words).
 * - before the Hub lists "rooms-v1": today's rooms come back in the list's shape (direct, limited), and nothing else is live;
 * - the fixture's seed: the spec's rooms, every presence state, an @all with late answers, the assistant, invitations;
 * - each call's path, method, CSRF and body; the event stream's names and data.
 */
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error browser module
import { createHubWebClient, legacyRoom, ROOMS_FEATURE, ROOM_EVENTS } from "../src/ui/hub-client.js";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";

const realEventSource = (globalThis as any).EventSource;
afterEach(() => { (globalThis as any).EventSource = realEventSource; });

async function live() {
  const fx = createHubRoomsFixture(), calls: Array<{ path: string; method: string; csrf?: string; body?: any }> = [];
  const fetchImpl = (path: string, init: any = {}) => { calls.push({ path, method: init.method, csrf: init.headers?.["X-AgEnD-Hub-CSRF"], body: init.body ? JSON.parse(init.body) : undefined }); return fx.fetch(path, init); };
  (globalThis as any).EventSource = fx.EventSource;
  const client: any = createHubWebClient({ fetchImpl: fetchImpl as any });
  expect((await client.session()).features).toContain(ROOMS_FEATURE);
  return { fx, client, calls };
}

describe("before the Hub has rooms (today's server)", () => {
  const OLD = { id: "r1", asker: {}, exposureId: "e1", ownerAtCreation: {}, grantId: "g1", state: "active", exposureName: "project-helper", exposureState: "published",
    ownerName: "林小華", grantExpiresAt: 9, lastAt: 1234, waiting: true, features: ["attachments-v1"] };
  it("the list is today's rooms in the rooms shape — direct, named after the agent, limited, the old item kept; nothing else is live", async () => {
    const fetchImpl = async (path: string) => ({ ok: true, status: 200, headers: { get: () => null },
      json: async () => path === "/hub/v1/session" ? { signedIn: true, csrf: "c", features: ["attachments-v1"] } : { rooms: [OLD, { nope: 1 }] } });
    const client: any = createHubWebClient({ fetchImpl: fetchImpl as any });
    await client.session();
    expect(client.roomsLive()).toBe(false);
    const r = await client.roomList();
    expect(r.rooms).toEqual([{ id: "r1", kind: "direct", name: "project-helper", people: 1, agents: 1, online: null, unread: 0, lastAt: 1234, lastText: "", lastAuthor: "",
      agent: { exposureId: "e1", owner: { name: "林小華" }, presence: null }, limited: true, legacy: OLD }]);
    (globalThis as any).EventSource = class { constructor() { throw Error("must not open"); } };
    expect(client.subscribeRooms({})()).toBeUndefined();                                                // no stream
    expect(legacyRoom(null)).toBeNull();
  });
});

describe("rooms (seam 1) against the fixture", () => {
  it("the list: the spec's rooms, unread first then by last message; my permission to open rooms; invitations waiting", async () => {
    const { client, calls } = await live();
    expect(client.roomsLive()).toBe(true);
    const r = await client.roomList();
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/hub/v1/rooms?v=2" });              // Ridge #3858: /rooms stays direct-only for old tabs
    expect(r.me).toEqual({ canCreateRooms: true }); expect(r.invitations).toBe(1);
    expect(r.rooms.map((x: any) => x.name)).toEqual(["研一主管週會", "project-helper", "研發例會", "report-bot", "去年專案", "Hub 助理"].filter(n => r.rooms.some((x: any) => x.name === n)).sort((a, b) =>
      r.rooms.findIndex((x: any) => x.name === a) - r.rooms.findIndex((x: any) => x.name === b)));
    const weekly = r.rooms.find((x: any) => x.name === "研一主管週會");
    expect(weekly).toMatchObject({ kind: "group", people: 3, agents: 12, unread: 2 });
    expect(r.rooms[0].id).toBe("room-weekly");                                                          // the only one with unread
    expect(r.rooms.find((x: any) => x.name === "去年專案")).toMatchObject({ archived: true });
    expect(r.rooms.find((x: any) => x.name === "Hub 助理")).toMatchObject({ kind: "direct", assistant: true });
    expect(r.rooms.find((x: any) => x.name === "report-bot")).toMatchObject({ kind: "direct", agent: { owner: { name: "吳小安" }, presence: "offline" } });
  });
  it("a room: every presence state, both notes, the assistant, my role and its settings; members only @all where allowed", async () => {
    const { client } = await live();
    const weekly = await client.room("room-weekly");
    expect(weekly.me).toEqual({ id: FIXTURE_ME.id, role: "manager" });
    expect(weekly.members.filter((m: any) => m.canAsk).map((m: any) => m.name)).toEqual(["project-helper", "test-runner", "design-review", "report-bot", "old-helper"]);
    expect(new Set(weekly.members.map((m: any) => m.presence))).toEqual(new Set(["online", "offline", "idle", "working", "paused", "later"]));
    expect(weekly.members.map((m: any) => m.presenceNote).filter(Boolean)).toEqual(["額度用完", "等待登入", "需要更新 AgEnD"]);
    expect(weekly.members.filter((m: any) => m.kind === "assistant")).toHaveLength(1);
    expect(weekly.invited).toHaveLength(1);
    const rd = await client.room("room-rd");
    expect(rd).toMatchObject({ me: { id: FIXTURE_ME.id, role: "member" }, settings: { allMention: false } });
  });
  it("messages: a page newest last; the @all's counts, its answers as replies, the late ones queued; the assistant's summary", async () => {
    const { client, calls } = await live();
    const page = await client.roomMessages("room-weekly", { limit: 100 });
    const all = page.messages.find((m: any) => m.mentions.includes("all"));
    expect(all.ask).toEqual({ total: 12, answered: 6, working: 1, later: 5 });                       // 「已回答 6 · 處理中 1 · 稍後回覆 5」
    const replies = page.messages.filter((m: any) => m.answerTo === all.id);
    expect(replies.filter((m: any) => m.stage === "answered")).toHaveLength(6);
    expect(replies.filter((m: any) => m.stage === "queued")).toHaveLength(5);                          // paused agents answer later, as on send
    expect(page.messages.some((m: any) => m.author.kind === "assistant" && m.stage === "answered")).toBe(true);
    const older = await client.roomMessages("room-weekly", { before: page.messages[5].id, limit: 3 });
    expect(older.messages.map((m: any) => m.id)).toEqual(page.messages.slice(2, 5).map((m: any) => m.id));
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: `/hub/v1/rooms/room-weekly/messages?before=${page.messages[5].id}&limit=3` });
  });
  it("send: CSRF, mentions and idempotency; an @all counts who answers now and later; the stream hears it; a retry is the same message", async () => {
    const { client, calls } = await live();
    const heard: any[] = [];
    const stop = client.subscribeRooms(Object.fromEntries(ROOM_EVENTS.map((n: string) => [n, (d: any) => heard.push([n, d])])));
    const sent = await client.sendRoomMessage("room-weekly", { text: "@所有 Agent 再確認一次", mentions: ["all"], idempotencyKey: "k-1", replyTo: "msg-0001" });
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/hub/v1/rooms/room-weekly/messages", csrf: "fixture-csrf",
      body: { text: "@所有 Agent 再確認一次", mentions: ["all"], idempotencyKey: "k-1", replyTo: "msg-0001" } });
    expect(sent.message).toMatchObject({ idempotencyKey: "k-1", ask: { total: 12, answered: 0, working: 7, later: 5 } });   // 2 paused, 2 offline, 1 later
    expect(heard).toEqual([["message.added", { roomId: "room-weekly", message: sent.message }]]);
    expect((await client.sendRoomMessage("room-weekly", { text: "again", idempotencyKey: "k-1" })).message.id).toBe(sent.message.id);
    stop();
    await client.sendRoomMessage("room-weekly", { text: "after", idempotencyKey: "k-2" });
    expect(heard).toHaveLength(1);                                                                       // unsubscribed
  });
  it("refusals are codes the composer words: members may not @all here; an archived room; the stream says why a late answer changed the count", async () => {
    const { client, fx } = await live();
    expect(await client.sendRoomMessage("room-rd", { text: "@所有 Agent", mentions: ["all"], idempotencyKey: "k" })).toMatchObject({ ok: false, status: 403, code: "all-mention-off" });
    expect(await client.sendRoomMessage("room-archived", { text: "hi", idempotencyKey: "k" })).toMatchObject({ ok: false, status: 409, code: "archived" });
    fx.setAssistant("paused");                                                                           // Ridge: stored, with a soft warning
    expect(await client.sendRoomMessage("room-weekly", { text: "@房間助理 整理", mentions: ["assistant"], idempotencyKey: "k-a" }))
      .toMatchObject({ ok: true, message: { text: "@房間助理 整理", warning: "assistant-unavailable" } });
    const heard: any[] = []; client.subscribeRooms({ "message.updated": (d: any) => heard.push(d), "presence.changed": (d: any) => heard.push(d) });
    const late = fx.answerLater();
    expect(heard[0]).toMatchObject({ roomId: "room-weekly", presence: "idle" });
    expect(heard[1]).toMatchObject({ roomId: "room-weekly", message: { id: late!.id, stage: "answered" }, parent: { ask: { answered: 7, later: 4 } } });
  });
  it("read, room changes and members: each call's path and body; leaving drops the room from the list", async () => {
    const { client, calls } = await live();
    const heard: any[] = []; client.subscribeRooms({ "unread.changed": (d: any) => heard.push(d), "room.changed": (d: any) => heard.push(d), "member.changed": (d: any) => heard.push(d) });
    const page = await client.roomMessages("room-weekly");
    await client.markRoomRead("room-weekly", page.messages.at(-1).id);
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/hub/v1/rooms/room-weekly/read", body: { upTo: page.messages.at(-1).id } });
    expect(heard.at(-1)).toEqual({ roomId: "room-weekly", unread: 0 });
    await client.updateRoom("room-weekly", { allMention: false });
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/hub/v1/rooms/room-weekly", body: { allMention: false } });
    await client.addRoomMember("room-weekly", { kind: "agent", id: "exp-05" });
    expect(heard.at(-1)).toEqual({ roomId: "room-weekly" });
    await client.removeRoomMember("room-weekly", FIXTURE_ME.id);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: `/hub/v1/rooms/room-weekly/members/${FIXTURE_ME.id}` });
    expect(heard.at(-1)).toEqual({ roomId: "room-weekly", removed: true });
    const created = await client.createRoom({ name: "新的房間", people: [], teams: [], groups: [], agents: [], assistant: true });
    expect(created.room).toMatchObject({ kind: "group", name: "新的房間" });
    expect(await client.createRoom({ name: "" })).toMatchObject({ ok: false, code: "invalid" });
  });
  it("invitations, teams, creators and the administrator's rooms (seams 3 and 5)", async () => {
    const { client, calls } = await live();
    const inv = await client.invitations();
    expect(inv.invitations[0]).toMatchObject({ room: { name: "產品規劃" }, agent: { name: "my-notes" }, by: { name: "陳主任" } });
    await client.acceptInvitation(inv.invitations[0].id);
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: `/hub/v1/invitations/${inv.invitations[0].id}/accept` });
    expect((await client.invitations()).invitations).toEqual([]);
    await client.inviteToRoom("room-weekly", { agents: ["exp-99"] });
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/hub/v1/rooms/room-weekly/invitations", body: { agents: ["exp-99"] } });
    expect((await client.teams()).teams[0]).toMatchObject({ name: "研一" });
    await client.saveRoomCreators({ people: ["person-chen"], teams: ["team-1"] });
    expect(await client.roomCreators()).toMatchObject({ people: ["person-chen"], teams: ["team-1"] });
    const admin = await client.adminRooms();
    expect(admin.rooms.map((r: any) => r.name)).toEqual(["研一主管週會", "研發例會", "去年專案"]);
    expect(JSON.stringify(admin)).not.toContain("整理");                                                  // names and members, no content
  });
  it("one stream per tab (#1580): the notices ride the rooms stream; it stays while either listens and closes with the last", async () => {
    const { client, fx } = await live();
    let made = 0; const Real = fx.EventSource;
    (globalThis as any).EventSource = class extends Real { constructor(url: string) { super(url); made++; } };
    const notices: any[] = [], added: any[] = [];
    const stopNotices = client.subscribePairingNotices((n: any) => notices.push(n), () => {}, 3);
    const stopRooms = client.subscribeRooms({ "message.added": (d: any) => added.push(d) });
    expect(made).toBe(1);
    fx.emit("notices", { notices: [{ id: "n1" }] }); fx.emit("message.added", { roomId: "r", message: { id: "m" } });
    expect(notices).toEqual([[{ id: "n1" }]]); expect(added).toEqual([{ roomId: "r", message: { id: "m" } }]);
    stopNotices();
    fx.emit("message.added", { roomId: "r", message: { id: "m2" } }); fx.emit("notices", { notices: [] });
    expect(added).toHaveLength(2); expect(notices).toHaveLength(1);                                       // still open for the rooms
    stopRooms();
    fx.emit("message.added", { roomId: "r", message: { id: "m3" } });
    expect(added).toHaveLength(2); expect(made).toBe(1);                                                  // closed with the last
  });
  it("the notices ride the rooms stream at the session's notice version — the contract the rooms server honours (#3858)", async () => {
    const { client, fx } = await live();
    const urls: string[] = [], Real = fx.EventSource;
    (globalThis as any).EventSource = class extends Real { constructor(url: string) { super(url); urls.push(url); } };
    const got: any[] = [];
    const off = client.subscribePairingNotices((n: any) => got.push(n), () => {}, 3);
    expect(urls).toEqual(["/hub/v1/rooms/events?notices=2"]);                                           // this session has no enrolment-code-v1: v2
    fx.emit("notices", { notices: [{ id: "n1" }] });
    expect(got).toEqual([[{ id: "n1" }]]);
    off();
  });
  it("a name that listens again while the stream stays open is heard once, however often (Fable on #3848)", async () => {
    const { client, fx } = await live();
    const stopRooms = client.subscribeRooms({ "message.added": () => {} });                              // keeps the stream open
    let n = 0;
    for (let cycle = 0; cycle < 3; cycle++) { const off = client.subscribePairingNotices(() => {}, () => {}, 3); off(); }
    const off = client.subscribePairingNotices(() => { n++; }, () => {}, 3);
    fx.emit("notices", { notices: [{ id: "n1" }] });
    expect(n).toBe(1);
    // A room view that remounts: its handler again, once.
    let added = 0; stopRooms();
    const keep = client.subscribePairingNotices(() => {}, () => {}, 3);
    for (let cycle = 0; cycle < 2; cycle++) client.subscribeRooms({ "message.added": () => {} })();
    const stop = client.subscribeRooms({ "message.added": () => { added++; } });
    fx.emit("message.added", { roomId: "r", message: { id: "m" } });
    expect(added).toBe(1);
    off(); keep(); stop();
  });
  it("a write without the session's CSRF is refused by the fixture as by the Hub", async () => {
    const fx = createHubRoomsFixture();
    expect(await (await fx.fetch("/hub/v1/rooms/room-weekly/read", { method: "POST", body: "{}" })).json()).toEqual({ code: "csrf" });
  });
});
