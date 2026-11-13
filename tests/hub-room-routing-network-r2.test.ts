/** Actual Hub HTTP/SQLite dispatcher + pinned TLS/WSS member. Agent delivery is inert. */
import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { hubRig } from "./helpers/hub-rig.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY } from "../src/hub/protocol.js";
import type { HubExposure, HubRoomAnswer, HubRoomAsk } from "../src/hub/types.js";

it("routes a real room ask, loses an ACK, and replays the exact ask/answer on a new pinned link", async () => {
  const capabilities = [...HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY], net = await hubRig({ serverCapabilities: capabilities });
  const web = await s3bRig({ administrator: net.owner });
  try {
    web.httpDeps.transport = () => net.server; web.httpDeps.store = net.store; web.httpDeps.pairing = net.pairing;
    await web.restartHttp();
    let drop = true;
    net.setReceive(async (frame, link) => {
      const response = await web.http.receive(frame, link);
      if (frame.type === "room.answer" && drop) { drop = false; return; } // persisted answer, lost ACK
      return response;
    });
    const profile = await net.pair(), admin = await web.signIn("admin"); expect(admin.status).toBe(200);
    const publication: HubExposure = { id: randomUUID(), fleetId: profile.fleetId, owner: net.owner, displayName: "Notes", revision: 1,
      state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "a".repeat(64) };
    const seen: HubRoomAsk[] = [], answers = new Map<string, HubRoomAnswer>(), acks: string[] = [];
    const member = net.client(async (frame, link) => {
      if (frame.type === "room.answer-ack") { acks.push(frame.payload.answerId); return; }
      if (frame.type !== "room.ask") return;
      seen.push(frame.payload);
      if (!answers.has(frame.payload.messageId)) answers.set(frame.payload.messageId, { messageId: frame.payload.messageId,
        roomId: frame.payload.roomId, exposureId: frame.payload.exposureId, answerId: randomUUID(), text: "Synthetic answer" });
      if (seen.length === 1) return; // first input retained; output waits for a current-link replay
      await link.send({ v: 1, type: "room.answer", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: answers.get(frame.payload.messageId)! });
    }, undefined, capabilities);
    await member.value.start();
    await member.state.link!.send({ v: 1, type: "exposure.snapshot", requestId: randomUUID(), linkEpoch: member.state.link!.linkEpoch,
      payload: { revision: 1, exposures: [publication] } });
    await vi.waitFor(() => expect(web.db.prepare("SELECT id FROM hub_exposures").get()).toEqual({ id: publication.id }));
    const made = await web.call(admin, "POST", "/hub/v1/rooms", { name: "Network room", agents: [publication.id] }); expect(made.status).toBe(200);
    const roomId = made.json.room.id;
    const post = await web.call(admin, "POST", `/hub/v1/rooms/${roomId}/messages`, { text: "Status?", mentions: ["all"], idempotencyKey: randomUUID() }); expect(post.status).toBe(200);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const firstEpoch = member.state.syncs; net.server.refreshAuthorization();
    await vi.waitFor(() => expect(member.state.syncs).toBeGreaterThan(firstEpoch));
    await vi.waitFor(() => expect(seen).toHaveLength(2)); expect(seen[1]).toEqual(seen[0]);
    await vi.waitFor(() => expect(web.db.prepare("SELECT state FROM hub_room_deliveries").get()).toEqual({ state: "answered" }));
    expect(acks).toHaveLength(0); expect(answers.size).toBe(1);
    // The Fleet retains its frozen answer until ACK, even though the Hub already committed it.
    const before = member.state.syncs; net.server.refreshAuthorization();
    await vi.waitFor(() => expect(member.state.syncs).toBeGreaterThan(before));
    await vi.waitFor(() => expect(net.server.features(profile.fleetId)?.has(HUB_ROOM_ASK_CAPABILITY)).toBe(true));
    const answer = [...answers.values()][0]!;
    await member.state.link!.send({ v: 1, type: "room.answer", requestId: randomUUID(), linkEpoch: member.state.link!.linkEpoch, payload: answer });
    await vi.waitFor(() => expect(acks).toEqual([answer.answerId]));
    const page = await web.call(admin, "GET", `/hub/v1/rooms/${roomId}/messages`);
    expect(page.json.messages.filter((m: any) => m.text === answer.text)).toHaveLength(1);
    expect(page.json.messages.find((m: any) => m.id === post.json.id).ask).toEqual({ total: 1, answered: 1, working: 0, later: 0 });
    expect(seen).toHaveLength(2); // completed Hub tasks are not replayed as new inputs
  } finally { await web.close(); await net.close(); }
});
