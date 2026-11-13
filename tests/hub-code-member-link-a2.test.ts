/** Sealed Hub, synthetic LDAPS, real code join and pinned WSS. No daemon or real account. */
import { afterEach, expect, it, vi } from "vitest";
const dc = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:tls", async original => {
  const real = await original<typeof import("node:tls")>();
  return { ...real, connect: (options: import("node:tls").ConnectionOptions, callback?: () => void) => real.connect({ ...options,
    ...(options.host === "127.0.0.1" && options.port === 636 ? { port: dc.port } : {}),
    ...(options.host === "hub.example.test" ? { host: "127.0.0.1" } : {}) }, callback) };
});
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { companyJoinRig } from "./support/hub-company-join-rig.js";
import { issuerKeyId, sha256 } from "../src/hub/identity.js";
import { pkceChallenge, signJoinProof, type JoinPurpose } from "../src/hub/join/protocol.js";
import { HubMemberProfileStore } from "../src/hub/profile.js";
import { HubMemberClient, type HubMemberLink } from "../src/hub/client.js";
import { createMemberReceive } from "../src/hub/compose/member.js";
import { exposureSnapshotSender } from "../src/hub/member/exposures.js";
import type { HubExposureSnapshot, HubServerFrame } from "../src/hub/types.js";

let rig: Awaited<ReturnType<typeof companyJoinRig>> | undefined;
const clients: HubMemberClient[] = [];
afterEach(async () => { for (const c of clients.splice(0)) await c.close(); await rig?.close(); rig = undefined; vi.restoreAllMocks(); });
async function bounded<T>(promise: Promise<T>): Promise<T | string> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise.catch(e => `rejected:${e.message}`), new Promise<string>(r => { timer = setTimeout(() => r("no response"), 1500); })]); }
  finally { clearTimeout(timer!); }
}
async function joined() {
  const r = rig = await companyJoinRig(port => { dc.port = port; }), admin = await r.signIn("alice");
  expect((await r.call(admin, "PUT", "/hub/v1/admin/company-join", { enabled: true, expectedRevision: 1 })).status).toBe(200);
  const code = await r.call(admin, "POST", "/hub/v1/admin/enrolment-codes", { expires: "today", maxUses: 30, perPersonFleets: 1, scope: { kind: "directory" } });
  expect(code.status).toBe(201);
  const meta = (await r.call(null, "GET", "/hub/v1/join/metadata")).body;
  const key = generateKeyPairSync("ed25519"), state = randomBytes(32).toString("hex"), verifier = randomBytes(32).toString("base64url");
  const binding = { hub: meta.hub, fleetOrigin: "http://127.0.0.1:4444", requestId: randomUUID(), operationId: randomUUID(), fleetId: randomUUID(),
    publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), verifierS256: pkceChallenge(verifier) };
  const command = async (purpose: JoinPurpose, payload = {}) => {
    const challenge = await r.call(null, "POST", "/hub/v1/join/challenge", { binding, purpose }, { Origin: undefined });
    expect(challenge.status).toBe(200);
    return r.call(null, "POST", `/hub/v1/join/${purpose}`, { binding, payload,
      proof: signJoinProof(binding, purpose, challenge.body.nonce, challenge.body.expiresAt, payload, key.privateKey) }, { Origin: undefined });
  };
  expect((await command("push", { label: "F1", invitation: null, code: code.body.code, stateHash: sha256(state) })).status).toBe(200);
  const opened = await r.call(null, "POST", "/hub/join/open", new URLSearchParams({ requestId: binding.requestId, state }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded", Origin: binding.fleetOrigin });
  const browser = await r.signIn("carol"); browser.cookie += "; " + opened.cookie;
  expect((await r.call(browser, "POST", "/hub/v1/join/approve", { requestId: binding.requestId })).status).toBe(200);
  const issued = await command("redeem", { verifier }); expect(issued.status, issued.text).toBe(200);
  const home = join(r.home, "fleet"); mkdirSync(home, { mode: 0o700 });
  const profile = { v: 1 as const, hub: issued.body.hub, fleetId: binding.fleetId, owner: issued.body.owner, credential: issued.body.credential,
    certificatePem: issued.body.certificatePem, issuerKeyId: issuerKeyId(createPublicKey(issued.body.hub.issuerPublicKey)) };
  new HubMemberProfileStore(home, profile.hub.hubId).saveProfile(profile, null, () => true);
  return { r, admin, profile, home };
}

it("code join → refused share → reconnect keeps the member online without granting publication", async () => {
  const { r, admin, profile, home } = await joined();
  let snapshot: HubExposureSnapshot = { revision: 0, exposures: [] };
  const sender = exposureSnapshotSender({ snapshot: () => snapshot });
  const frames: HubServerFrame[] = [], logs = vi.fn(), holds = vi.fn();
  // M-3007: the refusal is recorded on the sender (what the owner's Settings shows), as member.ts wires it.
  const receive = createMemberReceive({ admission: { admit: vi.fn(), fence: vi.fn() }, journal: { acknowledge: vi.fn() }, live: () => true, log: logs,
    publicationRefused: (requestId, code) => sender.refused(requestId, code) });
  let link!: HubMemberLink;
  const barrier = (l: HubMemberLink) => l.exchange({ v: 1, type: "reconcile", requestId: randomUUID(), linkEpoch: l.linkEpoch,
    payload: { afterReceiptSequence: 0, messages: [] } }, "reconcile");
  const connect = () => {
    const client = new HubMemberClient({ home, hubId: profile.hub.hubId, memberOrigin: profile.hub.memberOrigin, current: () => true,
      reconcile: async l => { link = l; await sender.publishSnapshot(l); await barrier(l); },
      receive: async (f, l) => { frames.push(f); await receive(f, l); }, hold: holds });
    clients.push(client); return client;
  };
  const first = connect(); await first.start();
  snapshot = { revision: 1, exposures: [{ id: randomUUID(), fleetId: profile.fleetId, owner: profile.owner, displayName: "probe", revision: 1,
    state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] };
  await sender.afterCommit();
  expect.soft(await bounded(barrier(link))).toMatchObject({ type: "reconcile" });
  expect.soft(link.current()).toBe(true);
  expect.soft(frames).toContainEqual(expect.objectContaining({ type: "error", payload: { code: "denied", retryable: false } }));
  expect(r.db.prepare("SELECT * FROM hub_exposures").all()).toEqual([]);
  expect(sender.isRefused()).toBe(true);                                   // M-3007: the owner's row says "not allowed"
  expect(r.deps.store.read().fleets).toMatchObject([{ status: "active", generation: 1 }]);
  await first.close(); holds.mockClear();
  const second = connect();
  expect.soft(await bounded(second.start())).toBeUndefined();
  expect(sender.isRefused()).toBe(true);                                   // the reconnect's resend is refused again
  expect.soft(link.current()).toBe(true);
  expect.soft(holds).not.toHaveBeenCalled();
  expect(r.db.prepare("SELECT count(*) n FROM hub_group_resources WHERE source='code'").get()).toEqual({ n: 1 });
  expect(r.db.prepare("SELECT count(*) n FROM hub_group_resources WHERE json_extract(body,'$.kind')='exposure'").get()).toEqual({ n: 0 });
  // A fresh, independent group allowance can publish the same retained consent; the code grants no such right.
  await second.close();
  await r.enable(admin);
  const path = "/hub/v1/admin/group-policy", policy = (await r.call(admin, "GET", path)).body.policy;
  policy.groups[0].allow.push("publish_agents");
  const preview = await r.call(admin, "POST", path + "/preview", { policy }); expect(preview.status).toBe(200);
  expect((await r.call(admin, "PUT", path, { policy, previewDigest: preview.body.previewDigest })).status).toBe(200);
  holds.mockClear(); frames.length = 0;
  const third = connect(); expect(await bounded(third.start())).toBeUndefined();
  expect(link.current()).toBe(true); expect(holds).not.toHaveBeenCalled(); expect(frames).toEqual([]);
  expect(r.db.prepare("SELECT state,display_name FROM hub_exposures").all()).toEqual([{ state: "published", display_name: "probe" }]);
  expect(sender.isRefused()).toBe(false);                                  // allowed: the next accepted snapshot clears it
  expect(r.db.prepare("SELECT source FROM hub_group_resources WHERE json_extract(body,'$.kind')='exposure'").get()).toEqual({ source: "group" });
  expect(r.db.prepare("SELECT uses FROM hub_enrolment_codes").get()).toEqual({ uses: 1 });
  // Membership uncertainty is retryable feedback, with no replacement of previously accepted material.
  r.wire.state.mode = "unsupported";
  snapshot = { revision: 2, exposures: [{ ...snapshot.exposures[0]!, revision: 2 }] };
  await sender.afterCommit(); expect(await bounded(barrier(link))).toMatchObject({ type: "reconcile" });
  expect(frames).toContainEqual(expect.objectContaining({ type: "error", payload: { code: "unavailable", retryable: true } }));
  expect(sender.isRefused()).toBe(false);                                  // retryable uncertainty is not a policy refusal
  expect(link.current()).toBe(true);
  expect(r.db.prepare("SELECT revision FROM hub_exposures").all()).toEqual([{ revision: 1 }]);
  expect(r.db.prepare("SELECT revision FROM hub_catalog_cursor").get()).toEqual({ revision: 1 });
  r.wire.state.mode = "ok";
  // Duplicate consent passes the link's owner check but must still fail inside the catalog, without soft feedback.
  snapshot = { ...snapshot, exposures: [snapshot.exposures[0]!, snapshot.exposures[0]!] };
  await sender.afterCommit(); expect(await bounded(barrier(link))).toEqual(expect.stringContaining("rejected:"));
  expect(link.current()).toBe(false);
  expect(r.db.prepare("SELECT state,display_name FROM hub_exposures").all()).toEqual([{ state: "published", display_name: "probe" }]);
  expect(r.deps.audit.verifyChain()).toMatchObject({ ok: true });
});

it.each(["denied", "unavailable"] as const)("only current bounded %s feedback is handled without admitting work", async code => {
  const log = vi.fn(), admission = { admit: vi.fn(), fence: vi.fn() }, journal = { acknowledge: vi.fn() };
  const receive = createMemberReceive({ admission, journal, live: () => true, log });
  const link = { current: () => true } as HubMemberLink;
  const frame = { v: 1 as const, type: "error" as const, requestId: randomUUID(), linkEpoch: 1, payload: { code, retryable: code === "unavailable" } };
  await receive(frame, link);
  expect(log).toHaveBeenCalledExactlyOnceWith("warn", "Hub publication not accepted", { code });
  expect(admission.admit).not.toHaveBeenCalled(); expect(admission.fence).not.toHaveBeenCalled(); expect(journal.acknowledge).not.toHaveBeenCalled();
  log.mockClear(); await receive(frame, { ...link, current: () => false }); expect(log).not.toHaveBeenCalled();
  await expect(receive({ ...frame, payload: { code: "invalid", retryable: false } }, link)).rejects.toThrow(/unexpected error/);
});
