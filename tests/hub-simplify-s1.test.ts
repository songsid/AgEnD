/** Phase A server acceptance: real HTTPS, sealed Hub, fake LDAPS, key-proved join. */
import { afterEach, describe, expect, it, vi } from "vitest";
const dc = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:tls", async original => {
  const real = await original<typeof import("node:tls")>();
  return { ...real, connect: (options: import("node:tls").ConnectionOptions) => real.connect({ ...options,
    ...(options.host === "127.0.0.1" && options.port === 636 ? { port: dc.port } : {}) }) };
});
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { companyJoinRig } from "./support/hub-company-join-rig.js";
import { pkceChallenge, signJoinProof, type JoinPurpose } from "../src/hub/join/protocol.js";
import { personKeyString, sha256 } from "../src/hub/identity.js";
let rig: Awaited<ReturnType<typeof companyJoinRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; vi.restoreAllMocks(); });
async function world() {
  const r = rig = await companyJoinRig(port => { dc.port = port; }), admin = await r.signIn("alice");
  await r.enable(admin);
  expect((await r.call(admin, "PUT", "/hub/v1/admin/company-join", { enabled: true, expectedRevision: 1 })).status).toBe(200);
  return { r, admin };
}
async function attempt(r: Awaited<ReturnType<typeof companyJoinRig>>, supersedes?: { fleetId: string; credential: string }) {
  const metadata = (await r.call(null, "GET", "/hub/v1/join/metadata")).body;
  const key = generateKeyPairSync("ed25519"), verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("hex");
  const binding = { hub: metadata.hub, fleetOrigin: "http://127.0.0.1:43210", requestId: randomUUID(), operationId: randomUUID(),
    fleetId: randomUUID(), publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), verifierS256: pkceChallenge(verifier) };
  const command = async (purpose: JoinPurpose, payload: unknown = {}, display = false) => {
    const nonce = await r.call(null, "POST", "/hub/v1/join/challenge", { binding, purpose }, { Origin: undefined });
    expect(nonce.status).toBe(200);
    return r.call(null, "POST", `/hub/v1/join/${purpose}`, { binding, payload,
      proof: signJoinProof(binding, purpose, nonce.body.nonce, nonce.body.expiresAt, payload, key.privateKey) },
    { Origin: undefined, ...(display ? { "X-AgEnD-Join-Display": "1" } : {}) });
  };
  expect((await command("push", { label: "Carol's laptop", stateHash: sha256(state), invitation: null,
    ...(supersedes ? { supersedes } : {}) })).status).toBe(200);
  const approve = async (login = "carol") => {
    const opened = await r.call(null, "POST", "/hub/join/open", new URLSearchParams({ requestId: binding.requestId, state }).toString(),
      { "Content-Type": "application/x-www-form-urlencoded", Origin: binding.fleetOrigin });
    expect(opened.status).toBe(303);
    const browser = await r.signIn(login); browser.cookie += "; " + opened.cookie;
    const again = () => r.call(browser, "POST", "/hub/v1/join/approve", { requestId: binding.requestId });
    return { response: await again(), again, browser };
  };
  return { binding, command, approve, redeem: (display = false) => command("redeem", { verifier }, display) };
}

describe("S1 additive display and connection cleanup", () => {
  it("negotiates optional Hub name without breaking an older Fleet's strict metadata", async () => {
    const { r } = await world();
    const old = (await r.call(null, "GET", "/hub/v1/join/metadata")).body;
    expect(Object.keys(old).sort()).toEqual(["v", "hub", "identityDigest", "certificatePem", "features"].sort());
    const next = (await r.call(null, "GET", "/hub/v1/join/metadata", undefined, { "X-AgEnD-Join-Display": "1" })).body;
    expect(next.name).toBe("Company-join test Hub"); expect(next.hub).toEqual(old.hub);
  });
  it("adds display labels only to negotiated redeem; same credential and identity recover", async () => {
    const { r } = await world(), a = await attempt(r); expect((await a.approve()).response.status).toBe(200);
    const old = await a.redeem(); expect(old.status).toBe(200);
    expect(old.body).not.toHaveProperty("ownerLabel"); expect(old.body).not.toHaveProperty("hubName");
    const next = await a.redeem(true); expect(next.status).toBe(200);
    expect(next.body).toMatchObject({ credential: old.body.credential, ownerLabel: expect.any(String), hubName: "Company-join test Hub" });
    expect(next.body.ownerLabel.length).toBeGreaterThan(0);
  });
  it("overview reports label, real source and issuance time without credentials", async () => {
    const { r, admin } = await world(), a = await attempt(r); expect((await a.approve()).response.status).toBe(200);
    const issued = await a.redeem(); expect(issued.status).toBe(200);
    const view = await r.call(admin, "GET", "/hub/v1/admin/overview");
    expect(view.body.fleets).toEqual([expect.objectContaining({ id: a.binding.fleetId, label: "Carol's laptop", source: "group", createdAt: expect.any(Number) })]);
    expect(view.text).not.toContain(issued.body.credential);
  });
  it("answers offer-pending and lets the same browser request continue after stopping its quick offer", async () => {
    const { r } = await world(), carol = await r.signIn("carol");
    const offer = await r.call(carol, "POST", "/hub/v1/quick-pairing", { label: "Other computer" }); expect(offer.status).toBe(200);
    const a = await attempt(r), approval = await a.approve();
    expect(approval.response).toMatchObject({ status: 409, body: { code: "offer-pending" } });
    expect((await a.command("status")).body).toMatchObject({ state: "pending", reason: "offer-pending", issued: false });
    expect(r.deps.store.read().fleets).toHaveLength(0);
    expect((await r.call(carol, "POST", `/hub/v1/quick-pairing/${offer.body.pairingId}/stop`, {})).status).toBe(200);
    expect((await approval.again()).status).toBe(200);
    expect((await a.command("status")).body).toMatchObject({ state: "identity-approved", reason: null });
    expect((await a.redeem()).status).toBe(200);
  });
  it("answers offer-pending for another approved reservation and releases it on cancel", async () => {
    const { r } = await world(), a = await attempt(r); expect((await a.approve()).response.status).toBe(200);
    const b = await attempt(r), approval = await b.approve();
    expect(approval.response).toMatchObject({ status: 409, body: { code: "offer-pending" } });
    expect((await a.command("cancel")).status).toBe(200);
    expect((await approval.again()).status).toBe(200);
  });
  it("supersedes its authenticated old row atomically at the one-Fleet limit; delivery retries never repeat it", async () => {
    const { r } = await world(), a = await attempt(r); expect((await a.approve()).response.status).toBe(200);
    const first = await a.redeem(); expect(first.status).toBe(200);
    const b = await attempt(r, { fleetId: a.binding.fleetId, credential: first.body.credential });
    expect(JSON.stringify(r.db.prepare("SELECT body FROM hub_company_join_requests WHERE id=?").get(b.binding.requestId))).not.toContain(first.body.credential);
    expect((await b.approve()).response.status).toBe(200);
    expect(r.deps.store.read().fleets.filter(f => f.status === "active")).toHaveLength(1); // no early revoke
    const second = await b.redeem(); expect(second.status).toBe(200);
    expect(r.deps.store.read().fleets).toEqual([expect.objectContaining({ id: a.binding.fleetId, status: "revoked", credentialHash: null, generation: 2 }),
      expect.objectContaining({ id: b.binding.fleetId, status: "active", generation: 1 })]);
    expect((await b.redeem()).body.credential).toBe(second.body.credential);
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_audit WHERE action='member.superseded'").get()).toEqual({ n: 1 });
  });
  it("a wrong old credential cannot free a quota slot or revoke anything", async () => {
    const { r } = await world(), a = await attempt(r); expect((await a.approve()).response.status).toBe(200); expect((await a.redeem()).status).toBe(200);
    const b = await attempt(r, { fleetId: a.binding.fleetId, credential: "f".repeat(64) });
    expect((await b.approve()).response).toMatchObject({ status: 429, body: { code: "limit-reached" } });
    expect((await b.command("status")).body).toMatchObject({ state: "pending", reason: "limit-reached", issued: false });
    expect(r.deps.store.read().fleets).toEqual([expect.objectContaining({ id: a.binding.fleetId, status: "active", generation: 1 })]);
  });
  it("valid proof of another person's Fleet never confers ownership to the new AD sign-in", async () => {
    const { r } = await world(), a = await attempt(r); expect((await a.approve()).response.status).toBe(200);
    const first = await a.redeem(); expect(first.status).toBe(200);
    const b = await attempt(r, { fleetId: a.binding.fleetId, credential: first.body.credential });
    expect((await b.approve("alice")).response.status).toBe(403);
    expect(r.deps.store.read().fleets).toEqual([expect.objectContaining({ id: a.binding.fleetId, status: "active" })]);
  });
  it("an old stored request without the additive field still passes its exact save CAS", async () => {
    const { r } = await world(), a = await attempt(r);
    const row = r.db.prepare("SELECT body FROM hub_company_join_requests WHERE id=?").get(a.binding.requestId) as { body: string };
    const old = JSON.parse(row.body); delete old.supersedesFleetId;
    r.db.prepare("UPDATE hub_company_join_requests SET body=? WHERE id=?").run(JSON.stringify(old), a.binding.requestId);
    expect(r.deps.companyJoin!.records.get(a.binding.requestId).supersedesFleetId).toBeNull();
    expect((await a.approve()).response.status).toBe(200); expect((await a.redeem()).status).toBe(200);
  });
  it("a failed supersession audit rolls back BOTH issuance and the old-row revoke", async () => {
    const { r } = await world(), a = await attempt(r); expect((await a.approve()).response.status).toBe(200);
    const first = await a.redeem(), b = await attempt(r, { fleetId: a.binding.fleetId, credential: first.body.credential });
    expect((await b.approve()).response.status).toBe(200);
    const original = r.deps.audit.appendInTransaction.bind(r.deps.audit);
    vi.spyOn(r.deps.audit, "appendInTransaction").mockImplementation((event, db) => {
      if (event.action === "member.superseded") throw Error("owned audit failure");
      return original(event, db);
    });
    expect((await b.redeem()).status).toBeGreaterThanOrEqual(400);
    const raw = r.db.prepare("SELECT state FROM hub_transport_state WHERE singleton=1").get() as { state: string };
    expect(JSON.parse(raw.state).fleets).toEqual([expect.objectContaining({ id: a.binding.fleetId, status: "active", credentialHash: sha256(first.body.credential) })]);
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_company_join_requests WHERE id=? AND stage='issued'").get(b.binding.requestId)).toEqual({ n: 0 });
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_audit WHERE action='member.superseded'").get()).toEqual({ n: 0 });
  });
  it("the last supersession audit cannot outlive the approving browser's session", async () => {
    const { r } = await world(), a = await attempt(r); expect((await a.approve()).response.status).toBe(200);
    const first = await a.redeem(), b = await attempt(r, { fleetId: a.binding.fleetId, credential: first.body.credential });
    expect((await b.approve()).response.status).toBe(200);
    const original = r.deps.audit.appendInTransaction.bind(r.deps.audit);
    vi.spyOn(r.deps.audit, "appendInTransaction").mockImplementation((event, db) => {
      const result = original(event, db);
      if (event.action === "member.superseded") db.prepare("UPDATE hub_sessions SET state='ended' WHERE person=?")
        .run(personKeyString({ realm: "corp", objectId: r.people[1]!.id }));
      return result;
    });
    expect((await b.redeem()).status).toBeGreaterThanOrEqual(400);
    const raw = r.db.prepare("SELECT state FROM hub_transport_state WHERE singleton=1").get() as { state: string };
    expect(JSON.parse(raw.state).fleets).toEqual([expect.objectContaining({ id: a.binding.fleetId, status: "active", credentialHash: sha256(first.body.credential) })]);
  });
  it("fresh global authorization after a held issue is required, even when the old Fleet was revoked", async () => {
    const { r, admin } = await world(), a = await attempt(r); expect((await a.approve()).response.status).toBe(200);
    const first = await a.redeem(), b = await attempt(r, { fleetId: a.binding.fleetId, credential: first.body.credential });
    expect((await b.approve()).response.status).toBe(200);
    let release!: () => void, enter!: () => void;
    const gate = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { enter = r; });
    const original = r.deps.groups!.prepareEnrollment.bind(r.deps.groups!);
    vi.spyOn(r.deps.groups!, "prepareEnrollment").mockImplementationOnce(async (...args) => {
      const permit = await original(...args); enter(); await gate; return permit;
    });
    const pending = b.redeem(); await entered;
    try { expect((await r.call(admin, "POST", `/hub/v1/admin/fleets/${a.binding.fleetId}/revoke`, {})).status).toBe(200); }
    finally { release(); }
    expect((await pending).status).toBeGreaterThanOrEqual(400);
    expect(r.deps.store.read().fleets).toHaveLength(1);
    expect((await b.redeem()).status).toBe(200);
    expect(r.deps.store.read().fleets.filter(f => f.status === "active")).toHaveLength(1);
  });
});
