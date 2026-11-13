/** Owned TLS/WSS + SQLite factory integration. Delivery and state are inert Fleet-host callbacks. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { createHubMemberFactory, memberSet, type HubRepresentativeHost } from "../src/hub/compose/member.js";
import { MEMBER_COMPONENTS } from "../src/hub/runtime.js";
import { HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY } from "../src/hub/protocol.js";
import type { HubMountedService } from "../src/hub/mount.js";
import type { HubMemberExposureApi } from "../src/hub/member/exposure-api.js";
import type { HubRepresentativeDelivery } from "../src/hub/representative.js";
import type { HubRoomAsk } from "../src/hub/types.js";
import type { AgentStateInput } from "../src/hub/member/room-ask.js";
import { HubMemberProfileStore } from "../src/hub/profile.js";
import { beginHubPairing, claimHubPairing } from "../src/hub/pairing-client.js";
import { hubRig } from "./helpers/hub-rig.js";

const capabilities = [...HUB_OPTIONAL_CAPABILITIES, HUB_ROOM_ASK_CAPABILITY];
const rigs: Awaited<ReturnType<typeof hubRig>>[] = [], services: HubMountedService[] = [];
afterEach(async () => { for (const s of services.splice(0)) { s.fence(); await s.close(); } for (const r of rigs.splice(0)) await r.close(); });
async function harness(withState = true) {
  const r = await hubRig({ serverCapabilities: capabilities }); rigs.push(r); const profile = await r.pair();
  let epoch = 0;
  r.setReceive(async (frame, link) => {
    epoch = link.linkEpoch;
    if (frame.type === "reconcile") return { v: 1, type: "reconcile", requestId: frame.requestId, linkEpoch: link.linkEpoch,
      payload: { receipts: [], nextReceiptSequence: 0, more: false } };
  });
  let api: HubMemberExposureApi | null = null, reports: Parameters<HubRepresentativeHost["attachReports"]>[0] = null;
  let failed: Parameters<HubRepresentativeHost["attachReports"]>[1] = null;
  const inputs: HubRepresentativeDelivery[] = [];
  let token = "test-current-agent-token";
  const readState = vi.fn((): AgentStateInput => ({ process: "running", execution: "idle" }));
  const representative = {
    agentToken: () => token,
    deliver: async (input: HubRepresentativeDelivery) => { if (!input.stillCurrent() || !await input.beforeInput()) return false; inputs.push(input); return true; },
    attachReports: (handler: typeof reports, failure: typeof failed) => { reports = handler; failed = failure; },
    ...(withState ? { readState } : {}),
  };
  const create = createHubMemberFactory({ home: r.memberHome, components: MEMBER_COMPONENTS, boundHub: () => profile.hub.hubId,
    agents: () => [{ name: "general", display: "General" }], representative,
    attachExposures: value => { api = value; }, attachAttention: () => {}, pokeAttention: () => {}, report: () => {}, log: () => {} });
  const start = async () => { const service = await create({}, () => true); services.push(service); await service.start(); return service; };
  const send = (type: "room.ask" | "room.answer-ack", payload: any) => r.server.send(profile.fleetId,
    { v: 1, type, requestId: randomUUID(), linkEpoch: epoch, payload });
  const publish = () => api!.publish({ agent: "general", dataViewId: "agent", tools: [], expectedRevision: 0 });
  const ask = (id: string): HubRoomAsk => ({ messageId: randomUUID(), roomId: randomUUID(), roomName: "Weekly", exposureId: id,
    asker: { name: "Alex" }, text: "What changed?", context: [] });
  const row = (id: string) => { const db = new Database(join(r.memberHome, memberSet(profile.hub.hubId).database), { readonly: true });
    try { return db.prepare("SELECT state FROM hub_room_asks WHERE message_id=?").get(id); } finally { db.close(); } };
  return { r, profile, inputs, readState, start, publish, ask, send, row, representative, api: () => api!,
    replace: () => { token = "replacement-agent-token"; },
    report: (text: string) => reports!({ caller: "general", correlationId: inputs.at(-1)!.correlationId, text, callerCurrent: () => true }),
    failed: () => failed!(inputs.at(-1)!.correlationId, "general") };
}

it("composes negotiated room delivery, text reports, exact ACK and viewer-neutral presence", async () => {
  const h = await harness(); await h.start(); const exposure = h.publish();
  const ask = h.ask(exposure.exposureId!);
  await expect(h.send("room.ask", ask)).resolves.toBeUndefined();
  await vi.waitFor(() => expect(h.inputs).toHaveLength(1));
  expect(h.inputs[0]!.text).toContain("Weekly"); expect(h.row(ask.messageId)).toEqual({ state: "delivered" });
  expect(await h.report("Answer from the existing agent")).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(h.r.received.filter(f => f.type === "room.answer")).toHaveLength(1));
  const frame = h.r.received.find(f => f.type === "room.answer")!;
  if (frame.type !== "room.answer") throw Error("missing answer");
  await h.send("room.answer-ack", { messageId: ask.messageId, answerId: randomUUID() });
  expect(h.row(ask.messageId)).toEqual({ state: "answered" });
  await h.send("room.answer-ack", { messageId: frame.payload.messageId, answerId: frame.payload.answerId });
  await vi.waitFor(() => expect(h.row(ask.messageId)).toEqual({ state: "acked" }));
  await vi.waitFor(() => expect(h.r.received.filter(f => f.type === "agent.state")).toContainEqual(expect.objectContaining({ payload: { exposureId: ask.exposureId, state: "idle" } })));
  expect(h.readState).toHaveBeenCalledWith("general");
  await h.send("room.ask", ask); expect(h.inputs).toHaveLength(1);
});

it("keeps an uncomposed host off room-ask-v1 even when the Hub supports it", async () => {
  const h = await harness(false); await h.start(); const exposure = h.publish();
  await expect(h.send("room.ask", h.ask(exposure.exposureId!))).rejects.toThrow("incompatible");
  expect(h.inputs).toEqual([]); expect(h.readState).not.toHaveBeenCalled();
  expect(h.r.received.filter(f => f.type === "agent.state" || f.type === "room.answer")).toEqual([]);
});

it("flushes the same frozen answer after same-binding restart without replaying agent input", async () => {
  const h = await harness(); const first = await h.start(); const exposure = h.publish(), ask = h.ask(exposure.exposureId!);
  await h.send("room.ask", ask); await vi.waitFor(() => expect(h.inputs).toHaveLength(1)); await h.report("Frozen answer");
  await vi.waitFor(() => expect(h.r.received.filter(f => f.type === "room.answer")).toHaveLength(1));
  const original = h.r.received.find(f => f.type === "room.answer")!;
  first.fence(); await first.close(); services.splice(services.indexOf(first), 1);
  await h.start();
  await vi.waitFor(() => expect(h.r.received.filter(f => f.type === "room.answer")).toHaveLength(2));
  expect(h.r.received.filter(f => f.type === "room.answer").map(f => f.payload)).toEqual([original.payload, original.payload]);
  expect(h.inputs).toHaveLength(1);
  if (original.type !== "room.answer") throw Error("missing answer");
  await h.send("room.answer-ack", { messageId: original.payload.messageId, answerId: original.payload.answerId });
  await vi.waitFor(() => expect(h.row(ask.messageId)).toEqual({ state: "acked" }));
});

it("routes delayed IPC failure to the room intent and detaches reports on fence", async () => {
  const h = await harness(), service = await h.start(), exposure = h.publish(), ask = h.ask(exposure.exposureId!);
  await h.send("room.ask", ask); await vi.waitFor(() => expect(h.inputs).toHaveLength(1));
  h.failed(); expect(h.row(ask.messageId)).toEqual({ state: "held" });
  await h.send("room.ask", ask); expect(h.inputs).toHaveLength(1);
  service.fence(); await service.close();
  expect(h.r.received.filter(f => f.type === "room.answer")).toEqual([]);
});

it("polls current state on the link, deduplicates stable readings and stops after fencing", async () => {
  const h = await harness(), service = await h.start(), exposure = h.publish();
  await vi.waitFor(() => expect(h.r.received.filter(f => f.type === "agent.state")).toHaveLength(1));
  h.readState.mockReturnValue({ process: "crashed", execution: "working" });
  await vi.waitFor(() => expect(h.r.received.filter(f => f.type === "agent.state")).toContainEqual(expect.objectContaining({
    payload: { exposureId: exposure.exposureId, state: "paused", reason: "stopped" } })), { timeout: 7_000 });
  service.fence(); await service.close(); const calls = h.readState.mock.calls.length;
  await new Promise(resolve => setTimeout(resolve, 30)); expect(h.readState).toHaveBeenCalledTimes(calls);
  expect(h.r.received.filter(f => f.type === "agent.state")).toHaveLength(2);
}, 15_000);

it.each(["withdraw", "replace"] as const)("fences a held first input when the local consent becomes %s", async kind => {
  const h = await harness(); let release!: () => void; const held = new Promise<void>(r => { release = r; });
  const normal = h.representative.deliver; h.representative.deliver = async input => { await held; return normal(input); };
  await h.start(); const exposure = h.publish(), ask = h.ask(exposure.exposureId!); await h.send("room.ask", ask);
  await vi.waitFor(() => expect(h.row(ask.messageId)).toEqual({ state: "dispatching" }));
  if (kind === "withdraw") await h.api().withdraw(exposure.exposureId!, exposure.revision); else h.replace();
  release(); await vi.waitFor(() => expect(h.row(ask.messageId)).toEqual({ state: "queued" }));
  expect(h.inputs).toHaveLength(0);
});

it("holds corrupt room history before an unbound legacy set can adopt a pairing or advance its floor", async () => {
  const h = await harness(), first = await h.start(), exposure = h.publish(), ask = h.ask(exposure.exposureId!);
  await h.send("room.ask", ask); await vi.waitFor(() => expect(h.inputs).toHaveLength(1));
  first.fence(); await first.close(); services.splice(services.indexOf(first), 1);
  const set = memberSet(h.profile.hub.hubId), path = join(h.r.memberHome, set.database), floor = join(h.r.memberHome, set.floors[0]!);
  const db = new Database(path);
  db.prepare("UPDATE hub_member_meta SET binding=NULL").run(); db.prepare("UPDATE hub_room_asks SET value='corrupt'").run(); db.close();
  const before = readFileSync(floor, "utf8");
  await expect(h.start()).rejects.toThrow("uncertain");
  const after = new Database(path, { readonly: true });
  try { expect(after.prepare("SELECT binding FROM hub_member_meta").get()).toEqual({ binding: null });
    expect(after.prepare("SELECT value FROM hub_room_asks").get()).toEqual({ value: "corrupt" }); }
  finally { after.close(); }
  expect(readFileSync(floor, "utf8")).toBe(before);
});

it("opens a different complete room journal after re-pair and retains the old room input history", async () => {
  const h = await harness(), first = await h.start(), exposure = h.publish(), ask = h.ask(exposure.exposureId!);
  await h.send("room.ask", ask); await vi.waitFor(() => expect(h.inputs).toHaveLength(1));
  first.fence(); await first.close(); services.splice(services.indexOf(first), 1);
  const previous = h.row(ask.messageId), profiles = new HubMemberProfileStore(h.r.memberHome, h.profile.hub.hubId);
  const expectedProfileDigest = profiles.profileDigest(), offer = await h.r.pairing.create(h.r.ctx, h.r.owner);
  const pending = await beginHubPairing({ home: h.r.memberHome, memberOrigin: h.r.memberOrigin, code: offer.code, current: () => true });
  await h.r.pairing.confirmOwner(h.r.ctx, pending.pairingId, pending.fingerprint);
  await h.r.pairing.approve(h.r.ctx, pending.pairingId, pending.fingerprint);
  await claimHubPairing({ home: h.r.memberHome, hubId: h.profile.hub.hubId, approvedFingerprint: pending.fingerprint, expectedProfileDigest, current: () => true });
  const nextProfile = profiles.readProfile(); expect(nextProfile.fleetId).not.toBe(h.profile.fleetId);
  await h.start(); expect(h.inputs).toHaveLength(1); expect(h.row(ask.messageId)).toEqual(previous);
  const db = new Database(join(h.r.memberHome, memberSet(nextProfile.hub.hubId, nextProfile).database), { readonly: true });
  try { expect(db.prepare("SELECT COUNT(*) AS n FROM hub_room_asks").get()).toEqual({ n: 0 }); } finally { db.close(); }
});
