/** Room transport over owned TLS/WSS; no agent/CLI input. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { hubRig } from "./helpers/hub-rig.js";
import { parseMemberFrame, HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY } from "../src/hub/protocol.js";
import type { HubRoomAsk } from "../src/hub/types.js";

const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
const capabilities = [...HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY];
const ask = (): HubRoomAsk => ({ messageId: randomUUID(), roomId: randomUUID(), roomName: "Weekly", exposureId: randomUUID(), asker: { name: "Alex" }, text: "Progress?", context: [] });

it.each(["old-member", "old-hub"] as const)("%s keeps the room frames off its link", async version => {
  const r = await hubRig({ serverCapabilities: version === "old-hub" ? HUB_OPTIONAL_CAPABILITIES : capabilities }); rigs.push(r);
  const profile = await r.pair(), client = r.client(undefined, undefined, version === "old-member" ? undefined : capabilities);
  await client.value.start();
  expect(client.state.link!.features.has(HUB_ROOM_ASK_CAPABILITY)).toBe(false);
  await expect(r.server.send(profile.fleetId, { v: 1, type: "room.ask", requestId: randomUUID(), linkEpoch: client.state.link!.linkEpoch, payload: ask() })).rejects.toThrow("incompatible");
  await expect(client.state.link!.send({ v: 1, type: "agent.state", requestId: randomUUID(), linkEpoch: client.state.link!.linkEpoch,
    payload: { exposureId: randomUUID(), state: "idle" } })).rejects.toThrow("incompatible");
});

it("keeps an answer ACK independent of a held room ask receiver", async () => {
  const r = await hubRig({ serverCapabilities: capabilities }); rigs.push(r); const profile = await r.pair();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const client = r.client(async frame => { calls.push(frame.type); if (frame.type === "room.ask") await held; }, undefined, capabilities);
  try {
    await client.value.start(); const linkEpoch = client.state.link!.linkEpoch, input = ask();
    await r.server.send(profile.fleetId, { v: 1, type: "room.ask", requestId: randomUUID(), linkEpoch, payload: input });
    await vi.waitFor(() => expect(calls).toContain("room.ask"));
    await r.server.send(profile.fleetId, { v: 1, type: "room.answer-ack", requestId: randomUUID(), linkEpoch,
      payload: { messageId: input.messageId, answerId: randomUUID() } });
    await vi.waitFor(() => expect(calls).toContain("room.answer-ack"));
    expect(client.state.link!.current()).toBe(true);
  } finally { release(); }
});

it("keeps presence reasons portable and rejects arbitrary reason codes", () => {
  const frame = { v: 1, type: "agent.state", requestId: randomUUID(), linkEpoch: 1,
    payload: { exposureId: randomUUID(), state: "paused", reason: "auth" } };
  expect(parseMemberFrame(JSON.stringify(frame))).toEqual(frame);
  expect(() => parseMemberFrame(JSON.stringify({ ...frame, payload: { ...frame.payload, reason: "private detail" } }))).toThrow();
});
