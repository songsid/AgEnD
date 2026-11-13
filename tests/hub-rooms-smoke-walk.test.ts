/**
 * Hub rooms smoke walk (hub-rooms-ux.md §13) against the seam-1 fixture.
 * Last-manager 409 and PATCH /members/:id {role} come from #3854 (fixture ~226 / ~315).
 * One live fixture; steps run in order. §13.8 (viewport / theme / Fleet chat) is screens, not this file.
 */
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error browser module
import { createHubWebClient, ROOMS_FEATURE, ROOM_EVENTS } from "../src/ui/hub-client.js";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";

const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;
afterEach(() => { (globalThis as { EventSource?: unknown }).EventSource = realEventSource; });

async function live() {
  const fx = createHubRoomsFixture();
  const fetchImpl = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => fx.fetch(path, init);
  (globalThis as { EventSource?: unknown }).EventSource = fx.EventSource;
  const client: any = createHubWebClient({ fetchImpl: fetchImpl as never });
  expect((await client.session()).features).toContain(ROOMS_FEATURE);
  return { fx, client };
}

describe("§13 smoke walk (one fixture)", () => {
  it("walks the spec's path: open the weekly room, @all, later answer, assistant, unread, all-mention off, archive and leave", async () => {
    const { fx, client } = await live();
    const heard: Array<[string, unknown]> = [];
    const stop = client.subscribeRooms(Object.fromEntries(ROOM_EVENTS.map((n: string) => [n, (d: unknown) => heard.push([n, d])])));

    // 1. 王經理 may open rooms; 研一主管週會 has two other people, own agents, a waiting invite, and the assistant.
    const creators = await client.roomCreators();
    expect(creators.people.map((p: { id: string }) => p.id)).toContain(FIXTURE_ME.id);
    const list = await client.roomList();
    expect(list.me).toMatchObject({ canCreateRooms: true });
    const weeklyRow = list.rooms.find((r: { name: string }) => r.name === "研一主管週會");
    expect(weeklyRow).toMatchObject({ kind: "group", people: 3, unread: 2 });
    const weekly = await client.room("room-weekly");
    expect(weekly.me).toEqual({ id: FIXTURE_ME.id, role: "manager" });
    expect(weekly.members.filter((m: { kind: string }) => m.kind === "person").map((m: { name: string }) => m.name))
      .toEqual(["王經理", "陳主任", "吳小安"]);
    expect(weekly.members.some((m: { kind: string }) => m.kind === "assistant")).toBe(true);
    expect(weekly.invited.some((i: { name: string; state?: string }) => i.name === "audit-helper" && i.state === "pending")).toBe(true);
    expect(weekly.settings.allMention).toBe(true);

    // 2. A team's agent is still waiting; two other owners already have agents in the room.
    expect(weekly.invited.find((i: { name: string }) => i.name === "audit-helper"))
      .toMatchObject({ name: "audit-helper", owner: { name: "周小明" } });
    const agentsIn = weekly.members.filter((m: { kind: string }) => m.kind === "agent" || m.kind === "later");
    expect(agentsIn.length).toBeGreaterThanOrEqual(2);

    // 3. @all: one online answers in the seed, later-agents are queued; answerLater() brings one in.
    const page = await client.roomMessages("room-weekly", { limit: 100 });
    const all = page.messages.find((m: { mentions?: string[] }) => m.mentions?.includes("all"));
    expect(all.ask).toEqual({ total: 12, answered: 6, working: 1, later: 5 });   // paused, offline and reply-later answer later (one rule with send)
    expect(page.messages.filter((m: { answerTo?: string; stage?: string }) => m.answerTo === all.id && m.stage === "queued")).toHaveLength(5);
    const late = fx.answerLater();
    expect(late).toMatchObject({ stage: "answered", answerTo: all.id });
    expect(heard.some(([n, d]) => n === "message.updated" && (d as { message: { id: string } }).message.id === late!.id)).toBe(true);

    // 4. 請房間助理整理 is already in the seed as an assistant answer; a reply to one agent is a send with replyTo.
    expect(page.messages.some((m: { author?: { kind: string }; mentions?: string[] }) => m.author?.kind === "assistant" && m.mentions?.includes("assistant") === false)).toBe(true);
    const agentReply = page.messages.find((m: { answerTo?: string; stage?: string }) => m.answerTo === all.id && m.stage === "answered");
    const follow = await client.sendRoomMessage("room-weekly", { text: "這個數字再看一下", mentions: [agentReply.author.id], replyTo: agentReply.id, idempotencyKey: "walk-follow" });
    expect(follow.ok).toBe(true);
    expect(follow.message).toMatchObject({ replyTo: agentReply.id, idempotencyKey: "walk-follow" });

    // 5. A seeded 陳主任 @ to me is unread and marks mentioned (list computes both; not a self-emitted event).
    const beforeMention = (await client.roomList()).rooms.find((r: { id: string }) => r.id === "room-weekly");
    const weeklyRoom = fx.rooms.find((r: { id: string }) => r.id === "room-weekly")!;
    weeklyRoom.messages.push({
      id: "msg-chen-at", roomId: "room-weekly", at: (weeklyRoom.messages.at(-1)?.at ?? 0) + 60_000,
      author: { kind: "person", id: "person-chen", name: "陳主任" }, text: "@王經理 看一下", mentions: [FIXTURE_ME.id],
    });
    const afterMention = (await client.roomList()).rooms.find((r: { id: string }) => r.id === "room-weekly");
    expect(afterMention.unread).toBe(beforeMention.unread + 1);
    expect(afterMention.mentioned).toBe(true);

    // 6. Turn off @all on the weekly room. 房間管理 still may @all there; a member (研發例會, already off) is refused.
    await client.updateRoom("room-weekly", { allMention: false });
    expect((await client.room("room-weekly")).settings.allMention).toBe(false);
    expect(await client.sendRoomMessage("room-weekly", { text: "@所有 Agent", mentions: ["all"], idempotencyKey: "walk-mgr-all" }))
      .toMatchObject({ ok: true });
    expect(await client.sendRoomMessage("room-rd", { text: "@所有 Agent", mentions: ["all"], idempotencyKey: "walk-all" }))
      .toMatchObject({ ok: false, status: 403, code: "all-mention-off" });

    // 7. Direct, Hub assistant, archive; last manager cannot leave; promote 陳主任 then leave.
    const after = await client.roomList();
    expect(after.rooms.some((r: { kind: string; name: string }) => r.kind === "direct" && r.name === "project-helper")).toBe(true);
    expect(after.rooms.some((r: { assistant?: boolean }) => r.assistant === true)).toBe(true);
    await client.updateRoom("room-archived", { archived: true });
    expect(await client.sendRoomMessage("room-archived", { text: "hi", idempotencyKey: "walk-arch" }))
      .toMatchObject({ ok: false, status: 409, code: "archived" });
    expect(await client.removeRoomMember("room-weekly", FIXTURE_ME.id))
      .toMatchObject({ ok: false, status: 409, code: "last-manager" });
    expect(await client.setRoomMemberRole("room-weekly", "person-chen", "manager")).toMatchObject({ ok: true });
    expect((await client.room("room-weekly")).members.find((m: { id: string }) => m.id === "person-chen").role).toBe("manager");
    expect(await client.removeRoomMember("room-weekly", FIXTURE_ME.id)).toMatchObject({ ok: true });
    expect(heard.some(([n, d]) => n === "room.changed" && (d as { roomId: string; removed?: boolean }).removed === true && (d as { roomId: string }).roomId === "room-weekly")).toBe(true);
    stop();
  });
});
