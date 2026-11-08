/** Real local TLS/WSS and production member inbox; no native/model execution. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { hubRig } from "./helpers/hub-rig.js";
import { HubSocket } from "../src/hub/socket.js";
import { createHubPairingNoticeInbox, HUB_PAIRING_INBOX_MIGRATION } from "../src/hub/member/pairing-notices.js";
import type { HubPairingNotice } from "../src/hub/types.js";

const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const r of rigs.splice(0)) await r.close(); });
const notice = (): HubPairingNotice => ({ id: randomUUID(), fleetId: randomUUID(), generation: 1, label: "My laptop", at: Date.now(), source: "group", revoked: false });
describe("pairing notices negotiate before any new wire frame", () => {
  it("new/new retains a real delivered notice before the matching ACK travels back", async () => {
    const r = await hubRig(); rigs.push(r); const profile = await r.pair(); HUB_PAIRING_INBOX_MIGRATION.up(r.db);
    const inbox = createHubPairingNoticeInbox({ db: r.db, current: () => true, now: Date.now,
      audit: { appendInTransaction: () => { expect(r.db.inTransaction).toBe(true); } } });
    const c = r.client(async (frame, link) => { if (frame.type === "pairing.notice") await inbox.receive(frame.payload, link); });
    await c.value.start(); const n = notice();
    await r.server.send(profile.fleetId, { v: 1, type: "pairing.notice", requestId: n.id, linkEpoch: c.state.link!.linkEpoch, payload: n });
    await vi.waitFor(() => expect(r.received.some(f => f.type === "pairing.notice-ack" && f.payload.id === n.id)).toBe(true));
    expect(inbox.list()).toEqual([n]); expect(c.state.link!.features.has("pairing-notices-v1")).toBe(true);
  });
  it.each(["old-member", "old-hub"] as const)("%s stays usable, with no notice or ACK on the wire", async version => {
    const sent: unknown[] = [], original = HubSocket.prototype.send;
    vi.spyOn(HubSocket.prototype, "send").mockImplementation(function(this: HubSocket<any, any>, frame: unknown) { sent.push(frame); return original.call(this, frame); });
    const r = await hubRig(version === "old-hub" ? { serverCapabilities: [] } : {}); rigs.push(r);
    const profile = await r.pair(), c = r.client(undefined, undefined, version === "old-member" ? [] : undefined); await c.value.start();
    const n = notice();
    await expect(r.server.send(profile.fleetId, { v: 1, type: "pairing.notice", requestId: n.id, linkEpoch: c.state.link!.linkEpoch, payload: n })).rejects.toThrow("incompatible");
    expect(c.state.link!.features.has("pairing-notices-v1")).toBe(false);
    const operationId = randomUUID();
    await expect(c.value.authorize({ messageId: randomUUID(), operationId, exposureRevision: 1, phase: "begin" })).resolves.toMatchObject({ operationId });
    expect(sent.filter((f: any) => f.type === "pairing.notice" || f.type === "pairing.notice-ack")).toEqual([]);
  });
});
