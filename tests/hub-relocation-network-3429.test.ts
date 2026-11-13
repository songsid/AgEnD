/**
 * #3429 option B over the real pinned TLS/WSS link (hub rig): the Hub's `relocate` and the member's `relocate.ack`.
 * - A member listing member-relocation-v1 keeps the signed relocation durably, then acks it on the same link; the Hub's
 *   proof names that exact link, epoch, digest and revision, and stops being current once the link is replaced.
 * - An older member (no capability): nothing sent, null at once. A mismatched ack is ignored (null at the deadline).
 *   A link that closes while waiting: null at once, not at the deadline.
 * - The member dials a pending `to` first and, when nothing answers there, the anchor in the same attempt; the link's
 *   endpoint is the address it actually reached.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateKey } from "node:crypto";
import { hubRig, freeHubPort } from "./helpers/hub-rig.js";
import { readPrivateFile } from "../src/hub/private-files.js";
import { issuerKeyId } from "../src/hub/identity.js";
import { HubMemberProfileStore, type HubMemberProfile } from "../src/hub/profile.js";
import { HUB_OPTIONAL_CAPABILITIES } from "../src/hub/protocol.js";
import { HUB_MEMBER_RELOCATION_CAPABILITY, HubMemberRelocationStore, acceptHubRelocation, relocationDigest, signHubRelocation } from "../src/hub/member-origin.js";

const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const r of rigs.splice(0)) await r.close(); });
const B = "https://hub-b.example.test:9443";

async function setup(opts: { dial?: () => string[] } = {}) {
  const r = await hubRig(opts.dial ? { clientDial: opts.dial } : {}); rigs.push(r);
  const p = await r.pair(), digest = new HubMemberProfileStore(r.memberHome, p.hub.hubId).profileDigest()!;
  const key = createPrivateKey(readPrivateFile(r.root, "hub/keys/issuer-key.pem"));
  const st = (to: string, revision: number) => signHubRelocation({ hubId: p.hub.hubId, issuerKeyId: issuerKeyId(key), fleetId: p.fleetId },
    { from: p.hub.memberOrigin, to, spkiSha256: p.hub.spkiSha256, revision }, key);
  /** The member's handler, as compose/member.ts wires it: keep durably, then ack on the same link. */
  const onFrame = (ackDigest?: (d: string) => string) => async (frame: any, link: any) => {
    if (frame.type !== "relocate") return;
    const out = acceptHubRelocation({ home: r.memberHome, profile: p as HubMemberProfile, profileDigest: digest, webOrigins: [], current: () => link.current(),
      log: () => {}, record: () => {} }, frame.payload);
    if ("ack" in out) await link.send({ v: 1, type: "relocate.ack", requestId: frame.requestId, linkEpoch: link.linkEpoch,
      payload: { ...out.ack, digest: ackDigest ? ackDigest(out.ack.digest) : out.ack.digest } });
  };
  return { r, p, digest, st, onFrame, store: new HubMemberRelocationStore(r.memberHome, p.hub.hubId) };
}

describe("#3429 B — relocate and its ack over the pinned link", () => {
  it("kept durably, acked on the same link; the proof names that link and is no longer current once the link is replaced", async () => {
    const { r, p, digest, st, onFrame, store } = await setup();
    const c = r.client(onFrame()); await c.value.start();
    expect(c.state.link!.features.has(HUB_MEMBER_RELOCATION_CAPABILITY)).toBe(true);
    const s = st(B, 1);
    const proof = await r.server.relocate(p.fleetId, s, relocationDigest(s), Date.now() + 5_000);
    expect(proof).toMatchObject({ fleetId: p.fleetId, linkEpoch: c.state.link!.linkEpoch, digest: relocationDigest(s), revision: 1 });
    expect(store.dialOrder(p, digest)).toEqual([B, p.hub.memberOrigin]);                              // stored before the ack
    expect(r.server.relocationLinkCurrent(proof!)).toBe(true);
    const other = r.client(onFrame()); await other.value.start();                                       // a new link replaces it
    await vi.waitFor(() => expect(c.state.holds).toContain("replaced"));
    expect(r.server.relocationLinkCurrent(proof!)).toBe(false);
  });
  it("an older member (no capability): nothing sent, null at once", async () => {
    const { r, p, st, onFrame } = await setup();
    const c = r.client(onFrame(), undefined, HUB_OPTIONAL_CAPABILITIES.filter(x => x !== HUB_MEMBER_RELOCATION_CAPABILITY)); await c.value.start();
    const s = st(B, 1), t = Date.now();
    expect(await r.server.relocate(p.fleetId, s, relocationDigest(s), Date.now() + 5_000)).toBeNull();
    expect(Date.now() - t).toBeLessThan(500);
    await new Promise(res => setTimeout(res, 300));
    expect(c.state.holds).toEqual([]);                                                                   // never sent: its link stays up
    expect(r.server.features(p.fleetId)).not.toBeNull();
  });
  it("an ack that names another digest is ignored: null at the shared deadline", async () => {
    const { r, p, st, onFrame } = await setup();
    const c = r.client(onFrame(() => "0".repeat(64))); await c.value.start();
    const s = st(B, 1), t = Date.now();
    expect(await r.server.relocate(p.fleetId, s, relocationDigest(s), Date.now() + 600)).toBeNull();
    expect(Date.now() - t).toBeGreaterThanOrEqual(550);
  });
  it("the link closes while waiting: null at once, not at the deadline", async () => {
    const { r, p, st } = await setup();
    const c = r.client(async (frame: any) => { if (frame.type === "relocate") r.server.fenceFleet(p.fleetId); }); await c.value.start();
    const s = st(B, 1), t = Date.now();
    expect(await r.server.relocate(p.fleetId, s, relocationDigest(s), Date.now() + 5_000)).toBeNull();
    expect(Date.now() - t).toBeLessThan(2_000);
  });
});

describe("#3429 B — the member's dial order", () => {
  it("a pending `to` that nothing answers is tried first, then the anchor in the same attempt; the link's endpoint is what it reached", async () => {
    const closed = `https://127.0.0.1:${await freeHubPort()}`;
    let anchor = "";
    const { r, p } = await setup({ dial: () => [closed, anchor] });
    anchor = p.hub.memberOrigin;
    const c = r.client(); await c.value.start();
    expect(c.state.link!.endpoint).toBe(p.hub.memberOrigin);
  });
  it("a relocation state that does not verify: nothing is dialled, the link holds", async () => {
    const { r } = await setup({ dial: () => [] });
    const c = r.client();
    await expect(c.value.start()).rejects.toThrow();
    expect(c.state.holds).toContain("key-changed");
  });
});
