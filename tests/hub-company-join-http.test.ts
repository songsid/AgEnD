/** #3423 fail-first actual HTTPS/AD-wire admission, browser-origin, quota and replay controls. */
import { afterEach, describe, expect, it, vi } from "vitest";
const dc = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:tls", async original => {
  const real = await original<typeof import("node:tls")>();
  return { ...real, connect: (options: import("node:tls").ConnectionOptions) => real.connect({ ...options,
    ...(options.host === "127.0.0.1" && options.port === 636 ? { port: dc.port } : {}) }) };
});
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { companyJoinRig, type JoinBrowser } from "./support/hub-company-join-rig.js";
import { pkceChallenge, signJoinProof, type JoinBinding, type JoinPurpose } from "../src/hub/join/protocol.js";
import { sha256 } from "../src/hub/identity.js";
import { advanceHubSessionEpoch, readHubSessionEpoch } from "../src/hub/session-epoch.js";
let rig: Awaited<ReturnType<typeof companyJoinRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; vi.restoreAllMocks(); });
async function world() {
  const r = rig = await companyJoinRig(port => { dc.port = port; });
  const admin = await r.signIn("alice"); await r.enable(admin);
  expect((await r.call(admin, "PUT", "/hub/v1/admin/company-join", { enabled: true, expectedRevision: 1 })).status).toBe(200);
  return { r, admin };
}
async function attempt(r: Awaited<ReturnType<typeof companyJoinRig>>) {
  const metadata = await r.call(null, "GET", "/hub/v1/join/metadata"); expect(metadata.status).toBe(200);
  const key = generateKeyPairSync("ed25519"), verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("hex");
  const binding: JoinBinding = { hub: metadata.body.hub, fleetOrigin: "http://127.0.0.1:43210", requestId: randomUUID(), operationId: randomUUID(),
    fleetId: randomUUID(), publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), verifierS256: pkceChallenge(verifier) };
  const packet = async (purpose: JoinPurpose, payload: unknown) => {
    const nonce = await r.call(null, "POST", "/hub/v1/join/challenge", { binding, purpose }, { Origin: undefined }); expect(nonce.status).toBe(200);
    return { binding, payload, proof: signJoinProof(binding, purpose, nonce.body.nonce, nonce.body.expiresAt, payload, key.privateKey) };
  };
  const command = async (purpose: JoinPurpose, payload: unknown = {}) => r.call(null, "POST", `/hub/v1/join/${purpose}`, await packet(purpose, payload), { Origin: undefined });
  expect((await command("push", { label: "Carol's laptop", stateHash: sha256(state), invitation: null })).status).toBe(200);
  const open = (origin = binding.fleetOrigin) => r.call(null, "POST", "/hub/join/open", new URLSearchParams({ requestId: binding.requestId, state }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded", Origin: origin });
  const browser = async (login = "carol") => {
    const opened = await open(); expect(opened.status).toBe(303); const session = await r.signIn(login);
    return { ...session, cookie: session.cookie + "; " + opened.cookie };
  };
  const approve = (session: JoinBrowser) => r.call(session, "POST", "/hub/v1/join/approve", { requestId: binding.requestId });
  return { binding, verifier, state, command, packet, open, browser, approve };
}

describe("company-join actual Hub boundary", () => {
  it("Hub admission independently refuses a key binding that shares the Fleet browser hostname", async () => {
    const { r } = await world(), metadata = (await r.call(null, "GET", "/hub/v1/join/metadata")).body;
    const key = generateKeyPairSync("ed25519"), fleet = new URL(metadata.hub.webOrigin); fleet.port = "7443";
    const binding = { hub: metadata.hub, fleetOrigin: fleet.origin, requestId: randomUUID(), operationId: randomUUID(), fleetId: randomUUID(),
      publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), verifierS256: pkceChallenge(randomBytes(32).toString("base64url")) };
    expect((await r.call(null, "POST", "/hub/v1/join/challenge", { binding, purpose: "push" }, { Origin: undefined })).status).toBe(400);
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_company_join_nonces").get()).toEqual({ n: 0 });
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_company_join_requests").get()).toEqual({ n: 0 });
  });
  it.each(["cancel", "expiry"])("issued %s keeps mixed legacy/company admission headroom until its original outer deadline", async reason => {
    const { r, admin } = await world(); await r.enable(admin, 8); let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
    const a = await attempt(r), carol = await a.browser(); expect((await a.approve(carol)).status).toBe(200);
    expect((await a.command("redeem", { verifier: a.verifier })).status).toBe(200);
    const b = await attempt(r), second = await b.browser();
    r.deps.store.mutate({ at: clock, requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.claims", result: "completed" }, state => {
      for (let n = 0; n < 47; n++) state.pairings.push({ id: randomUUID(), owner: { realm: "corp", objectId: randomUUID() },
        codeHash: null, expiresAt: clock + 600_000, fleetId: null, claimHash: null, fingerprint: null, ownerConfirmed: true, adminApproved: true, state: "claimed" });
    });
    expect((await b.approve(second)).status).toBe(429);
    if (reason === "cancel") expect((await a.command("cancel")).body.state).toBe("undeliverable");
    else { clock += 120_000; expect((await a.command("tombstone")).body.state).toBe("undeliverable"); }
    expect(r.deps.store.read().fleets).toHaveLength(1);
    expect((await b.approve(second)).status).toBe(429);
    clock += 600_001;
    expect(r.deps.companyJoin!.retained()).toBe(0);
    const fresh = await attempt(r); expect((await fresh.approve(await fresh.browser())).status).toBe(200);
  });
  it("a directory epoch change fences the held browser authority and pinned redemption before any new credential", async () => {
    const { r } = await world(), a = await attempt(r), browser = await a.browser(); expect((await a.approve(browser)).status).toBe(200);
    r.db.transaction(() => advanceHubSessionEpoch(r.db, readHubSessionEpoch(r.db))).immediate();
    const challenge = await r.call(null, "POST", "/hub/v1/join/challenge", { binding: a.binding, purpose: "redeem" }, { Origin: undefined });
    expect(challenge.status).toBe(503); expect(JSON.stringify(challenge.body)).not.toContain("credential");
    expect(r.deps.store.read().fleets).toEqual([]);
  });
  it("is off by default and only the exact configured admin can enable it with Origin/CSRF and current revision", async () => {
    const r = rig = await companyJoinRig(port => { dc.port = port; });
    expect((await r.call(null, "GET", "/hub/v1/join/metadata")).body.features).not.toContain("company-join-v1");
    const carol = await r.signIn("carol"), admin = await r.signIn("alice");
    expect((await r.call(admin, "GET", "/hub/v1/session")).body.features).toContain("company-join-v1");
    const path = "/hub/v1/admin/company-join", body = { enabled: true, expectedRevision: 1 };
    expect((await r.call(null, "PUT", path, body)).status).toBe(401);
    expect((await r.call(carol, "PUT", path, body)).status).toBe(403);
    expect((await r.call(admin, "PUT", path, body, { Origin: "https://attacker.invalid" })).status).toBe(403);
    expect((await r.call(admin, "PUT", path, body, { "X-AgEnD-Hub-CSRF": "" })).status).toBe(403);
    expect((await r.call(admin, "PUT", path, body)).status).toBe(200);
    expect((await r.call(admin, "PUT", path, body)).status).toBe(409);
  });
  it("refuses an attacker key advertising another Fleet origin before cookie/state/AD, without broadening Hub session CSRF", async () => {
    const { r } = await world(), a = await attempt(r), before = r.wire.searches.length;
    for (const origin of ["https://attacker.invalid", "null", ""]) {
      const refused = await a.open(origin); expect(refused.status).toBe(403); expect(refused.cookie).toBe("");
    }
    expect(r.wire.searches).toHaveLength(before);
    const opened = await a.open(); expect(opened.status).toBe(303); expect(opened.headers.location).toBe(`/ui/hub?join=${a.binding.requestId}`);
    expect((await a.open()).status).toBe(409);
    expect((await r.call(null, "POST", "/hub/v1/session", { login: "carol", password: "Dummy-carol-only" }, { Origin: a.binding.fleetOrigin })).status).toBe(403);
    expect(r.deps.store.read().fleets).toEqual([]);
  });
  it("issues once after one identity-submit, recovers exactly the same result, and refuses replay/wrong verifier", async () => {
    const { r } = await world(), a = await attempt(r), browser = await a.browser();
    expect((await a.approve(browser)).status).toBe(200);
    expect((await a.command("status")).body.state).toBe("identity-approved");
    expect((await a.command("redeem", { verifier: randomBytes(32).toString("base64url") })).status).toBe(403);
    expect(r.deps.store.read().fleets).toEqual([]);
    const packet = await a.packet("redeem", { verifier: a.verifier });
    const issued = await r.call(null, "POST", "/hub/v1/join/redeem", packet, { Origin: undefined }); expect(issued.status).toBe(200);
    expect(issued.body.credential).toMatch(/^[a-f0-9]{64}$/);
    expect((await r.call(null, "POST", "/hub/v1/join/redeem", packet, { Origin: undefined })).status).toBe(409);
    const recovered = await a.command("redeem", { verifier: a.verifier }); expect(recovered.status).toBe(200);
    expect(recovered.body.credential).toBe(issued.body.credential);
    expect(r.deps.store.read().fleets).toHaveLength(1); expect(r.deps.store.read().pairings).toEqual([]);
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_group_resources WHERE source='group'").get()).toEqual({ n: 1 });
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_pairing_notices").get()).toEqual({ n: 1 });
    const status = await a.command("status"); expect(JSON.stringify(status.body)).not.toContain(issued.body.credential);
    expect((await a.command("ack", { verifier: a.verifier, credentialHash: sha256(issued.body.credential), profileDigest: "a".repeat(64), journalCommitId: randomUUID() })).status).toBe(200);
    expect((await a.command("tombstone")).body.state).toBe("acknowledged");
    expect(JSON.stringify((await a.command("redeem", { verifier: a.verifier })).body)).not.toContain(issued.body.credential);
  });
  it("outsider and unknown membership cannot borrow manual fallback or create a Fleet", async () => {
    const { r } = await world(), a = await attempt(r), outsider = await a.browser("dan");
    expect((await a.approve(outsider)).status).toBe(403);
    expect(r.deps.store.read().fleets).toEqual([]);
    const b = await attempt(r), carol = await b.browser(); r.wire.state.mode = "unsupported";
    expect((await b.approve(carol)).status).toBe(503);
    expect(r.deps.store.read().fleets).toEqual([]);
  });
  it("an exact retained manual Fleet consumes the later automatic quota with a limit-specific refusal", async () => {
    const { r, admin } = await world(), a = await attempt(r), carol = await a.browser();
    const manual = await r.call(admin, "POST", "/hub/v1/admin/pairings", { login: "carol" }); expect(manual.status).toBe(200);
    const pending = r.deps.pairing.pair({ code: manual.body.code });
    expect((await r.call(carol, "POST", `/hub/v1/pairings/${pending.pairingId}/confirm`, { fingerprint: pending.fingerprint })).status).toBe(200);
    expect((await r.call(admin, "POST", `/hub/v1/admin/pairings/${pending.pairingId}/approve`, { fingerprint: pending.fingerprint })).status).toBe(200);
    expect((await r.deps.pairing.claim({ pairingId: pending.pairingId, fleetId: pending.fleetId, claimSecret: pending.claimSecret })).status).toBe("approved");
    const denied = await a.approve(carol); expect(denied.status).toBe(429); expect(denied.body.code).toBe("limit-reached");
    expect(r.deps.store.read().fleets).toHaveLength(1);
  });
  it("legacy quick pairing and a company browser wait share the same one-person reservation", async () => {
    const { r } = await world(), a = await attempt(r), carol = await a.browser();
    expect((await a.approve(carol)).status).toBe(200);
    expect((await r.call(carol, "POST", "/hub/v1/quick-pairing", { label: "Second reservation" })).status).toBe(409);
    const b = await attempt(r), second = await b.browser();
    expect((await b.approve(second)).status).toBe(409);
    expect((await a.command("redeem", { verifier: a.verifier })).status).toBe(200);
    expect(r.deps.store.read().fleets).toHaveLength(1);
  });
  it("first redemption expires at60s without issuance and never restarts the operation clock", async () => {
    const { r } = await world(); let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
    const a = await attempt(r), carol = await a.browser(); expect((await a.approve(carol)).status).toBe(200);
    clock += 60_000;
    expect((await a.command("redeem", { verifier: a.verifier })).status).toBe(410);
    expect((await a.command("tombstone")).body).toMatchObject({ state: "ended", issued: false, reason: "expired" });
    expect(r.deps.store.read().fleets).toEqual([]);
    clock += 600_000;
    expect((await a.command("redeem", { verifier: a.verifier })).status).toBe(410);
    expect(r.deps.store.read().fleets).toEqual([]);
  });
  it("same-result retrieval outlives the old60s redeem window but stops at exactly2min delivery", async () => {
    const { r } = await world(); let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
    const a = await attempt(r), carol = await a.browser(); expect((await a.approve(carol)).status).toBe(200);
    const first = await a.command("redeem", { verifier: a.verifier }); expect(first.status).toBe(200);
    clock += 60_000;
    expect((await a.command("redeem", { verifier: a.verifier })).body.credential).toBe(first.body.credential);
    clock += 60_000;
    const expired = await a.command("redeem", { verifier: a.verifier }); expect(expired.status).toBe(410);
    expect(JSON.stringify(expired.body)).not.toContain(first.body.credential);
    expect((await a.command("tombstone")).body).toMatchObject({ state: "undeliverable", issued: true, reason: "expired", fleetId: a.binding.fleetId });
    expect(r.deps.store.read().fleets).toHaveLength(1);
  });
  it("the10min outer deadline truncates both a late first redemption and its delivery window", async () => {
    const { r } = await world(); let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
    const a = await attempt(r), carol = await a.browser(); clock += 590_000;
    expect((await a.approve(carol)).status).toBe(200); clock += 9_000;
    const first = await a.command("redeem", { verifier: a.verifier }); expect(first.status).toBe(200);
    expect(first.body.deliveryDeadline).toBe(first.body.outerDeadline);
    clock += 1000;
    expect((await a.command("redeem", { verifier: a.verifier })).status).toBe(410);
    expect((await a.command("tombstone")).body.issued).toBe(true);
    expect(r.deps.store.read().fleets).toHaveLength(1);
  });
  it("post-commit cancellation erases delivery, keeps the exact retained result and cannot issue again", async () => {
    const { r } = await world(), a = await attempt(r), carol = await a.browser(); expect((await a.approve(carol)).status).toBe(200);
    const first = await a.command("redeem", { verifier: a.verifier }); expect(first.status).toBe(200);
    expect((await a.command("cancel")).body).toMatchObject({ state: "undeliverable", reason: "cancelled", issued: true });
    expect((await a.command("redeem", { verifier: a.verifier })).status).toBe(410);
    expect(r.db.prepare("SELECT json_extract(body,'$.receipt') r FROM hub_company_join_requests WHERE id=?").get(a.binding.requestId)).toEqual({ r: null });
    expect(r.deps.store.read().fleets).toHaveLength(1);
  });
  it("revocation and group suspension refuse recovery even while a transport row still looks active", async () => {
    const { r, admin } = await world(), a = await attempt(r), carol = await a.browser(); expect((await a.approve(carol)).status).toBe(200);
    expect((await a.command("redeem", { verifier: a.verifier })).status).toBe(200);
    const policyPath = "/hub/v1/admin/group-policy", policy = (await r.call(admin, "GET", policyPath)).body.policy;
    const owner = r.deps.store.read().fleets[0]!.owner;
    const denied = { ...policy, denies: [{ person: owner, deny: ["pair_fleet"] }] };
    const preview = await r.call(admin, "POST", `${policyPath}/preview`, { policy: denied }); expect(preview.status).toBe(200);
    expect((await r.call(admin, "PUT", policyPath, { policy: denied, previewDigest: preview.body.previewDigest })).status).toBe(200);
    expect(r.deps.store.read().fleets[0]!.status).toBe("active");
    expect((await a.command("redeem", { verifier: a.verifier })).status).not.toBe(200);
    expect((await r.call(admin, "POST", `/hub/v1/admin/fleets/${a.binding.fleetId}/revoke`, {})).status).toBe(200);
    expect((await a.command("tombstone")).body.state).toBe("revoked");
  });
  it("fresh AD membership loss closes delivery despite an unchanged active transport row", async () => {
    const { r } = await world(), a = await attempt(r), carol = await a.browser(); expect((await a.approve(carol)).status).toBe(200);
    const issued = await a.command("redeem", { verifier: a.verifier }); expect(issued.status).toBe(200);
    r.people.find(p => p.login === "carol")!.groups = ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
    const denied = await a.command("redeem", { verifier: a.verifier }); expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain(issued.body.credential);
    expect(r.deps.store.read().fleets[0]!.status).toBe("active");
    expect((await a.command("tombstone")).body).toMatchObject({ state: "undeliverable", reason: "authority", issued: true });
    expect(r.db.prepare("SELECT json_extract(body,'$.receipt') r FROM hub_company_join_requests WHERE id=?").get(a.binding.requestId)).toEqual({ r: null });
  });
  it("sign-out of the exact identity-submit session fences a later key-authenticated redemption", async () => {
    const { r } = await world(), a = await attempt(r), carol = await a.browser(); expect((await a.approve(carol)).status).toBe(200);
    expect((await r.call(carol, "DELETE", "/hub/v1/session")).status).toBe(200);
    expect((await a.command("redeem", { verifier: a.verifier })).status).toBe(403);
    expect(r.deps.store.read().fleets).toEqual([]);
  });
  it("an outbox failure rolls back credentials, provenance and receipt rather than publishing a partial grant", async () => {
    const { r } = await world(), a = await attempt(r), carol = await a.browser(); expect((await a.approve(carol)).status).toBe(200);
    vi.spyOn(r.deps.pairingNotices!, "enqueue").mockImplementation(() => { throw Error("Owned injected outbox failure"); });
    expect((await a.command("redeem", { verifier: a.verifier })).status).toBe(503);
    const state = JSON.parse((r.db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }).state);
    expect(state.fleets).toEqual([]);
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_group_resources").get()).toEqual({ n: 0 });
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_pairing_notices").get()).toEqual({ n: 0 });
    expect(r.db.prepare("SELECT json_extract(body,'$.receipt') r FROM hub_company_join_requests WHERE id=?").get(a.binding.requestId)).toEqual({ r: null });
  });
  it("two browser tabs cannot approve a different request than the Fleet shown in that tab", async () => {
    const { r } = await world(), a = await attempt(r), first = await a.browser(), b = await attempt(r), second = await b.browser();
    expect((await a.approve(second)).status).toBe(403);
    expect((await r.call(second, "GET", `/hub/v1/join/browser?request=${a.binding.requestId}`)).status).toBe(403);
    expect((await r.call(first, "GET", `/hub/v1/join/browser?request=${a.binding.requestId}`)).body.requestId).toBe(a.binding.requestId);
    expect((await a.approve(first)).status).toBe(200);
    expect((await b.command("status")).body.state).toBe("pending");
  });
});
