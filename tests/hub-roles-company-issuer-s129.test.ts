/** Actual company service, receipt encryption, sessions and SQL; no HTTP/listener/real directory claim. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { createHubGroupAuthorization } from "../src/hub/group-policy/authorization.js";
import { inspectHubGroupPolicyBinding } from "../src/hub/group-policy/store.js";
import { HubCompanyJoin } from "../src/hub/join/service.js";
import { HUB_COMPANY_JOIN_MIGRATION } from "../src/hub/join/store.js";
import { signCompanyDescriptor } from "../src/hub/join/descriptor.js";
import { signCompanyInvitation } from "../src/hub/join/invitation.js";
import { pkceChallenge, signJoinProof, type JoinPurpose } from "../src/hub/join/protocol.js";
import { HUB_ENROLMENT_CODE_MIGRATION } from "../src/hub/enrolment-code.js";
import { HUB_PAIRING_NOTICES_MIGRATION, HubPairingNotices } from "../src/hub/pairing-notices.js";
import { sha256 } from "../src/hub/identity.js";
const homes: string[] = [];
afterEach(() => { for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true }); });
async function world() {
  const w = await roleAuthorityWorld(), home = mkdtempSync(join(tmpdir(), "agend-roles-company-")); homes.push(home);
  for (const m of [HUB_COMPANY_JOIN_MIGRATION, HUB_ENROLMENT_CODE_MIGRATION, HUB_PAIRING_NOTICES_MIGRATION]) m.up(w.db);
  w.policy.roles.push({ id: "join-only", kind: "custom", name: "Join", permissions: ["join.manage"], defaultMaxFleets: 0 });
  w.policy.assignments[0]!.roleId = "join-only"; w.save(w.policy);
  const groups = createHubGroupAuthorization({ db: w.db, administrator: w.root, directory: w.directory, policy: () => w.pool,
    binding: () => inspectHubGroupPolicyBinding(w.db, w.hubId, "corp", "g1"), audit: w.audit, current: w.options.current, now: w.options.now,
    version: w.options.version, advanceAuthorization: w.advance, refreshAuthorization() {}, management: w.authority });
  const key = generateKeyPairSync("ed25519"), identity = { hubId: w.hubId, webOrigin: "https://hub.example.test", memberOrigin: "https://member.example.test",
    spkiSha256: "a".repeat(64), issuerPublicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const notices = new HubPairingNotices({ db: w.db, store: w.store, administrator: w.root, directory: w.directory, audit: w.audit,
    current: w.options.current, now: w.options.now, transport: () => null });
  const serviceOptions: ConstructorParameters<typeof HubCompanyJoin>[0] = { home, db: w.db, store: w.store, audit: w.audit, groups, notices, identity, certificatePem: "synthetic",
    administrator: w.root, eventDays: 30, current: w.options.current, now: w.options.now, management: w.authority,
    descriptor: signCompanyDescriptor(identity, key.privateKey), signInvitation: claims => signCompanyInvitation(claims, key.privateKey) };
  const service = new HubCompanyJoin(serviceOptions);
  await service.configure(w.ctx.ctx, { enabled: true, expectedRevision: 1 });
  const make = () => service.createCode(w.ctx.ctx, { expires: "1h", maxUses: 5, perPersonFleets: 2, scope: { kind: "directory" } });
  const begin = async (code: string | null, invitation: string | null) => {
    const machine = generateKeyPairSync("ed25519"), verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("hex");
    const binding = { hub: identity, fleetOrigin: "http://127.0.0.1:4444", requestId: randomUUID(), operationId: randomUUID(), fleetId: randomUUID(),
      publicKey: machine.publicKey.export({ type: "spki", format: "pem" }).toString(), verifierS256: pkceChallenge(verifier) };
    const proof = (purpose: JoinPurpose, payload: unknown) => {
      const c = service.challenge(binding, purpose); return signJoinProof(binding, purpose, c.nonce, c.expiresAt, payload, machine.privateKey);
    };
    const payload = { label: "Synthetic code Fleet", code, invitation, stateHash: sha256(state) };
    service.push(binding, payload, proof("push", payload));
    const cookie = service.browserOpen(binding.requestId, state, binding.fleetOrigin), browser = await w.browser(w.other);
    const approve = () => service.approve(browser.ctx, cookie, binding.requestId);
    const redeem = () => { const payload = { verifier }; return service.redeem(binding, proof("redeem", payload), payload); };
    return { binding, approve, redeem };
  };
  return { ...w, groups, service, notices, make, begin, legacy: () => new HubCompanyJoin({ ...serviceOptions, management: undefined }) };
}
describe("S129 company issuer and exact committed recovery", () => {
  it.each(["createCode", "revokeCode", "configure", "createInvitation", "listCodes"] as const)(
    "keeps legacy company administration root-only for %s even when requireAdmin accepts a non-root person", async action => {
      const w = await world(), code = await w.make(), service = w.legacy();
      const requireAdmin = vi.fn(async () => w.ctx.ctx.current()), ctx = { ...w.ctx.ctx, requireAdmin };
      const attempt = (caller: typeof ctx) => {
        if (action === "createCode") return service.createCode(caller, { expires: "1h", maxUses: 5, perPersonFleets: 2, scope: { kind: "directory" } });
        if (action === "revokeCode") return service.revokeCode(caller, code.id);
        if (action === "configure") return service.configure(caller, { enabled: false, expectedRevision: service.control().revision });
        if (action === "createInvitation") return service.createInvitation(caller, w.other);
        return service.listCodes(caller);
      };
      expect(await requireAdmin()).toMatchObject({ kind: "directory", person: w.admin }); requireAdmin.mockClear();
      const before = w.db.serialize();
      await expect(attempt(ctx)).rejects.toMatchObject({ code: "denied" });
      expect(requireAdmin).toHaveBeenCalledOnce(); expect(w.db.serialize()).toEqual(before);
      // The configured root can perform the same valid operation through this legacy service.
      const root = await w.browser(w.root);
      await expect(attempt({ ...root.ctx, requireAdmin: vi.fn(() => root.ctx.requireAdmin()) })).resolves.toBeDefined();
    });
  it.each(["code", "invitation"] as const)("retains an auxiliary issuer and recovers an already issued %s after role loss while refusing a new issuance", async source => {
    const w = await world(), code = source === "code" ? await w.make() : null;
    const invitation = source === "invitation" ? (await w.service.createInvitation(w.ctx.ctx, w.other)).invitation : null;
    const a = await w.begin(code?.code ?? null, invitation); await a.approve(); const issued = await a.redeem();
    const bInvite = source === "invitation" ? (await w.service.createInvitation(w.ctx.ctx, w.other)).invitation : null;
    const b = await w.begin(code?.code ?? null, bInvite); await b.approve();
    const priorFleets = w.store.read().fleets;
    w.policy.assignments = []; w.save(w.policy);
    await expect(b.redeem()).rejects.toMatchObject({ code: "denied" });
    expect(w.store.read().fleets).toEqual(priorFleets);
    const issuer = vi.spyOn(w.authority, "requireJoinIssuer").mockRejectedValue(Error("committed receipt must not reacquire issuer"));
    const recovered = await a.redeem(); expect(recovered.credential).toBe(issued.credential); expect(issuer).not.toHaveBeenCalled();
    const resource = w.db.prepare("SELECT body FROM hub_group_resources WHERE resource_key=?").get(JSON.stringify(["fleet", a.binding.fleetId, 1])) as { body: string };
    if (source === "code") {
      expect(JSON.parse(resource.body)).toMatchObject({ codeId: code!.id, approvedBy: w.admin });
      expect(w.db.prepare("SELECT uses,created_by FROM hub_enrolment_codes WHERE id=?").get(code!.id))
        .toEqual({ uses: 1, created_by: `${w.admin.realm}/${w.admin.objectId}` });
    }
    const action = source === "code" ? "enrolment-code.created" : "company-join.invitation-issued";
    const actor = w.db.prepare("SELECT actor FROM hub_audit WHERE action=? LIMIT 1").get(action) as { actor: string };
    expect(JSON.parse(actor.actor)).toEqual({ kind: "person", person: w.admin });
    expect(w.audit.verifyChain()).toMatchObject({ ok: true });
  });
  it("keeps root self-use denied independently from their management and a join manager cannot read audit content", async () => {
    const w = await world();
    expect(await w.pool.check(w.root, "pair_fleet", { requestId: "root-self", current: () => true })).toMatchObject({ outcome: "deny" });
    await expect(w.authority.require(w.ctx.ctx, "audit.view")).rejects.toMatchObject({ code: "denied" });
    expect(w.db.prepare("SELECT * FROM hub_auditors").all()).toEqual([]);
  });
});
