/**
 * Hub rooms, track U2 (dev-claude2): the client calls the dialogs and side pages use beyond seams 1/3/5 (agreed with Ridge
 * and web-claude, hub-rooms-u2-gaps), against the fixture's marked U2 block: pickers, member roles, cancelling an
 * invitation, the agent's rooms, and the administrator's join / archive. Each call's path, method, CSRF and body.
 */
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error browser module
import { createHubWebClient } from "../src/ui/hub-client.js";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";

const realEventSource = (globalThis as any).EventSource;
afterEach(() => { (globalThis as any).EventSource = realEventSource; });

async function live() {
  const fx = createHubRoomsFixture(), calls: Array<{ path: string; method: string; csrf?: string; body?: any }> = [];
  const fetchImpl = (path: string, init: any = {}) => { calls.push({ path, method: init.method ?? "GET", csrf: init.headers?.["X-AgEnD-Hub-CSRF"], body: init.body ? JSON.parse(init.body) : undefined }); return fx.fetch(path, init); };
  (globalThis as any).EventSource = fx.EventSource;
  const client: any = createHubWebClient({ fetchImpl: fetchImpl as any });
  await client.session(); calls.length = 0;
  return { fx, client, calls };
}

describe("rooms client, track U2", () => {
  it("roomCandidates: a GET with q and an optional kind; people, teams and groups carry counts; agents say whether they are mine", async () => {
    const { client, calls } = await live();
    const all = await client.roomCandidates("");
    expect(new Set(all.candidates.map((c: any) => c.kind))).toEqual(new Set(["person", "team", "group", "agent"]));
    expect(all.candidates.find((c: any) => c.kind === "team")).toEqual({ kind: "team", id: "team-1", name: "研一", people: 2 });
    const mine = await client.roomCandidates("MY-", "agent");
    expect(mine.candidates).toEqual([{ kind: "agent", id: "exp-mine-1", name: "my-notes", owner: { name: FIXTURE_ME.name }, mine: true }]);
    expect(calls.map(c => [c.method, c.path])).toEqual([["GET", "/hub/v1/rooms/candidates?q="], ["GET", "/hub/v1/rooms/candidates?q=MY-&kind=agent"]]);
  });

  it("setRoomMemberRole: a PATCH with the role and CSRF; the last manager cannot step down (409 last-manager)", async () => {
    const { client, calls } = await live();
    expect((await client.setRoomMemberRole("room-weekly", "person-chen", "manager")).ok).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/hub/v1/rooms/room-weekly/members/person-chen", csrf: "fixture-csrf", body: { role: "manager" } });
    expect((await client.setRoomMemberRole("room-weekly", FIXTURE_ME.id, "member")).ok).toBe(true);
    const last = await client.setRoomMemberRole("room-weekly", "person-chen", "member");
    expect(last).toMatchObject({ ok: false, status: 409, code: "last-manager" });
  });

  it("cancelRoomInvitation: a DELETE of that invitation; the room's list loses it; an unknown one is 404", async () => {
    const { client, calls } = await live();
    expect((await client.cancelRoomInvitation("room-weekly", "inv-0001")).ok).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/hub/v1/rooms/room-weekly/invitations/inv-0001", csrf: "fixture-csrf" });
    expect((await client.room("room-weekly")).invited).toEqual([]);
    expect((await client.cancelRoomInvitation("room-weekly", "inv-0001")).status).toBe(404);
  });

  it("agentRooms: the group rooms an agent is in, with the member id to remove it by", async () => {
    const { client, calls } = await live();
    const r = await client.agentRooms("exp-02");
    expect(r.rooms).toEqual([{ id: "room-weekly", name: "研一主管週會", people: 3, memberId: "exp-02" }, { id: "room-rd", name: "研發例會", people: 2, memberId: "exp-02" }]);
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/hub/v1/exposures/exp-02/rooms" });
  });

  it("joinRoomAsAdmin / archiveRoomAsAdmin: POST …/join and PATCH { archived } under the admin path", async () => {
    const { client, calls } = await live();
    await client.joinRoomAsAdmin("room-rd");
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/hub/v1/admin/rooms/room-rd/join", csrf: "fixture-csrf" });
    expect((await client.room("room-rd")).me.role).toBe("manager");
    await client.archiveRoomAsAdmin("room-rd");
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/hub/v1/admin/rooms/room-rd", body: { archived: true } });
    expect((await client.adminRooms()).rooms.find((r: any) => r.id === "room-rd").archived).toBe(true);
  });
});
