/** Real R dispatcher + C durable adapter over pinned TLS/WSS; physical agent input is inert. */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { hubRig } from "./helpers/hub-rig.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY } from "../src/hub/protocol.js";
import { HubRoomAskAdapter, migrateRoomAsks, type RoomAskLink, type RoomAnswer } from "../src/hub/member/room-ask.js";
import type { HubRepresentativeDelivery } from "../src/hub/representative.js";
import type { HubMemberLink } from "../src/hub/client.js";

it("delivers once through C and retains its exact answer across a lost Hub ACK and current-link reconnect", async () => {
  const capabilities = [...HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY], net = await hubRig({ serverCapabilities: capabilities }), web = await s3bRig({ administrator: net.owner }), db = new Database(":memory:");
  let adapter: HubRoomAskAdapter | undefined;
  try {
    web.httpDeps.transport = () => net.server; web.httpDeps.store = net.store; web.httpDeps.pairing = net.pairing; await web.restartHttp();
    let drop = true;
    net.setReceive(async (frame, link) => { const response = await web.http.receive(frame, link); if (frame.type === "room.answer" && drop) { drop = false; return; } return response; });
    const profile = await net.pair(), admin = await web.signIn("admin"), exposure = randomUUID(), inputs: HubRepresentativeDelivery[] = [], sent: RoomAnswer[] = [];
    migrateRoomAsks(db);
    adapter = new HubRoomAskAdapter({ db, bindingKey: `${profile.fleetId}:owned-test-issuer`, encryptionKey: randomBytes(32), current: () => true,
      localExposure: id => id === exposure ? { agent: "owned-agent", consentId: exposure, revision: 1, token: "owned-lifecycle" } : null,
      deliver: async input => { if (!input.stillCurrent() || !await input.beforeInput()) return false; inputs.push(input); return true; },
    });
    const bridges = new WeakMap<HubMemberLink, RoomAskLink>();
    const bridge = (link: HubMemberLink) => {
      let value = bridges.get(link); if (value) return value;
      value = { current: () => link.current(), features: link.features, sendAnswer: async answer => { sent.push(structuredClone(answer)); await link.send({ v: 1, type: "room.answer", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: answer }); } };
      bridges.set(link, value); return value;
    };
    const member = net.client(async (frame, link) => {
      const source = bridge(link); adapter!.connected(source);
      if (frame.type === "room.ask") adapter!.accept(frame.payload, source);
      if (frame.type === "room.answer-ack") adapter!.acknowledge(frame.payload, source);
    }, undefined, capabilities);
    await member.value.start(); adapter.connected(bridge(member.state.link!));
    await member.state.link!.send({ v: 1, type: "exposure.snapshot", requestId: randomUUID(), linkEpoch: member.state.link!.linkEpoch,
      payload: { revision: 1, exposures: [{ id: exposure, fleetId: profile.fleetId, owner: net.owner, displayName: "Owned agent", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "a".repeat(64) }] } });
    await vi.waitFor(() => expect(web.db.prepare("SELECT id FROM hub_exposures").get()).toEqual({ id: exposure }));
    const made = await web.call(admin, "POST", "/hub/v1/rooms", { name: "Actual RC", agents: [exposure] }), id = made.json.room.id;
    expect((await web.call(admin, "POST", `/hub/v1/rooms/${id}/messages`, { text: "Owned input", mentions: ["all"], idempotencyKey: randomUUID() })).status).toBe(200);
    await vi.waitFor(() => expect(inputs).toHaveLength(1)); await adapter.settled();
    await adapter.report({ correlationId: inputs[0]!.correlationId!, caller: "owned-agent", text: "Durable C answer" });
    await vi.waitFor(() => expect(web.db.prepare("SELECT state FROM hub_room_deliveries").get()).toEqual({ state: "answered" }));
    expect(db.prepare("SELECT state FROM hub_room_asks").get()).toEqual({ state: "answered" });
    const previous = member.state.syncs; net.server.refreshAuthorization();
    await vi.waitFor(() => expect(member.state.syncs).toBeGreaterThan(previous)); await vi.waitFor(() => expect(member.state.link?.current()).toBe(true));
    adapter.connected(bridge(member.state.link!)); await adapter.flush();
    await vi.waitFor(() => expect(db.prepare("SELECT state FROM hub_room_asks").get()).toEqual({ state: "acked" }));
    expect(inputs).toHaveLength(1); expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
    const messages = await web.call(admin, "GET", `/hub/v1/rooms/${id}/messages`);
    expect(messages.json.messages.filter((m: any) => m.text === "Durable C answer")).toHaveLength(1);
  } finally { await adapter?.close(); await web.close(); await net.close(); db.close(); }
});
