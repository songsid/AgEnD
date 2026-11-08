/** Invitation v2 preserves exact configured-admin attribution, recipient identity and local key/Origin proof. */
import { afterEach, describe, expect, it, vi } from "vitest";
const dc = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:tls", async original => { const real = await original<typeof import("node:tls")>(); return { ...real,
  connect: (options: import("node:tls").ConnectionOptions) => real.connect({ ...options, ...(options.host === "127.0.0.1" && options.port === 636 ? { port: dc.port } : {}) }) }; });
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { companyJoinRig, type JoinBrowser } from "./support/hub-company-join-rig.js";
import { parseCompanyAddress } from "../src/hub/join/descriptor.js";
import { pkceChallenge, signJoinProof, type JoinPurpose } from "../src/hub/join/protocol.js";
import { sha256 } from "../src/hub/identity.js";
let rig: Awaited<ReturnType<typeof companyJoinRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; vi.restoreAllMocks(); });
async function world(enableGroups = true) {
  const r = rig = await companyJoinRig(port => { dc.port = port; }), admin = await r.signIn("alice"); if (enableGroups) await r.enable(admin);
  expect((await r.call(admin, "PUT", "/hub/v1/admin/company-join", { enabled: true, expectedRevision: 1 })).status).toBe(200);
  return { r, admin };
}
async function begin(r: Awaited<ReturnType<typeof companyJoinRig>>, invitation: string | null) {
  const meta = (await r.call(null, "GET", "/hub/v1/join/metadata")).body, key = generateKeyPairSync("ed25519"), state = randomBytes(32).toString("hex"), verifier = randomBytes(32).toString("base64url");
  const binding = { hub: meta.hub, fleetOrigin: "http://127.0.0.1:4444", requestId: randomUUID(), operationId: randomUUID(), fleetId: randomUUID(),
    publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), verifierS256: pkceChallenge(verifier) };
  const command = async (purpose: JoinPurpose, payload = {}) => {
    const c = await r.call(null, "POST", "/hub/v1/join/challenge", { binding, purpose }, { Origin: undefined }); expect(c.status).toBe(200);
    return r.call(null, "POST", `/hub/v1/join/${purpose}`, { binding, payload, proof: signJoinProof(binding, purpose, c.body.nonce, c.body.expiresAt, payload, key.privateKey) }, { Origin: undefined });
  };
  const pushed = await command("push", { label: "Invited Fleet", invitation, stateHash: sha256(state) });
  const approve = async (login: string, beforeSubmit?: () => void) => {
    const open = await r.call(null, "POST", "/hub/join/open", new URLSearchParams({ requestId: binding.requestId, state }).toString(), { "Content-Type": "application/x-www-form-urlencoded", Origin: binding.fleetOrigin });
    expect(open.status).toBe(303); const browser = await r.signIn(login); browser.cookie += "; " + open.cookie; beforeSubmit?.();
    return r.call(browser, "POST", "/hub/v1/join/approve", { requestId: binding.requestId });
  };
  return { binding, command, pushed, approve, redeem: () => command("redeem", { verifier }) };
}
const invite = async (r: Awaited<ReturnType<typeof companyJoinRig>>, admin: JoinBrowser, login: string) => {
  const made = await r.call(admin, "POST", "/hub/v1/admin/company-join/invitations", { login }); expect(made.status).toBe(200); return made.body;
};
describe("company invitation exceptions", () => {
  it("admin-issued exception works for an eligible colleague without pair_fleet, before first sign-in; no extra approval or person row is manufactured", async () => {
    const { r, admin } = await world(), before = r.db.prepare("SELECT COUNT(*) n FROM hub_people").get();
    const code = await invite(r, admin, "dan");
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_people").get()).toEqual(before);
    expect(parseCompanyAddress(code.url)).toMatchObject({ webOrigin: r.webOrigin, invitation: code.invitation });
    const a = await begin(r, code.invitation); expect(a.pushed.status).toBe(200); expect((await a.approve("dan")).status).toBe(200);
    expect((await a.redeem()).status).toBe(200);
    const source = r.db.prepare("SELECT source FROM hub_group_resources WHERE resource_key=?").get(JSON.stringify(["fleet", a.binding.fleetId, 1])); expect(source).toEqual({ source: "manual" });
    expect((r.db.prepare("SELECT body FROM hub_pairing_notices").get() as { body: string }).body).toContain('"source":"manual"');
  });
  it("a copied invitation cannot select another AD person or bind a second Fleet key", async () => {
    const { r, admin } = await world(), code = await invite(r, admin, "dan"), a = await begin(r, code.invitation);
    expect(a.pushed.status).toBe(200); expect((await a.approve("carol")).status).toBe(403);
    expect((await begin(r, code.invitation)).pushed.status).toBe(409); expect(r.deps.store.read().fleets).toEqual([]);
  });
  it("manual approval may exceed maxFleets, but both retained Fleets count against a later automatic connection", async () => {
    const { r, admin } = await world();
    for (let i = 0; i < 2; i++) { const code = await invite(r, admin, "carol"), a = await begin(r, code.invitation); expect((await a.approve("carol")).status).toBe(200); expect((await a.redeem()).status).toBe(200); }
    const automatic = await begin(r, null), refusal = await automatic.approve("carol"); expect(refusal.status).toBe(429); expect(refusal.body.code).toBe("limit-reached");
    expect(r.deps.store.read().fleets).toHaveLength(2);
  });
  it("unknown/ineligible recipients and nonadmins get a bounded refusal before an invitation is issued", async () => {
    const { r, admin } = await world(), carol = await r.signIn("carol"), path = "/hub/v1/admin/company-join/invitations";
    const before = r.wire.searches.length; expect((await r.call(carol, "POST", path, { login: "dan" })).status).toBe(403); const selectedDan = (f: any): boolean => f?.attribute === "sAMAccountName" && Buffer.from(f.value).toString() === "dan" || f?.children?.some(selectedDan);
    expect(r.wire.searches.slice(before).some(q => selectedDan(q.filter))).toBe(false);
    expect((await r.call(admin, "POST", path, { login: "unknown" })).status).toBe(404);
    expect((r.db.prepare("SELECT COUNT(*) n FROM hub_company_join_invites").get() as { n: number }).n).toBe(0);
  });
  it("an invited owner's lost directory eligibility after approval refuses before any credential or provenance is committed", async () => {
    const { r, admin } = await world(), code = await invite(r, admin, "dan"), a = await begin(r, code.invitation);
    expect((await a.approve("dan")).status).toBe(200);
    r.people.find(p => p.login === "dan")!.eligible = false;
    expect((await a.redeem()).status).toBe(403);
    expect(r.deps.store.read().fleets).toEqual([]);
    expect((r.db.prepare("SELECT COUNT(*) n FROM hub_group_resources WHERE json_extract(body,'$.kind')='fleet'").get() as { n: number }).n).toBe(0);
    expect((r.db.prepare("SELECT COUNT(*) n FROM hub_pairing_notices").get() as { n: number }).n).toBe(0);
    expect(JSON.parse((r.db.prepare("SELECT body FROM hub_company_join_invites").get() as { body: string }).body).consumed).toBe(false);
  });
  it("a previously signed-in invited owner must still be eligible at the explicit identity-submit", async () => {
    const { r, admin } = await world(), code = await invite(r, admin, "dan"), a = await begin(r, code.invitation);
    expect((await a.approve("dan", () => { r.people.find(p => p.login === "dan")!.eligible = false; })).status).toBe(403);
    expect(r.deps.store.read().fleets).toEqual([]);
    expect(JSON.parse((r.db.prepare("SELECT body FROM hub_company_join_invites").get() as { body: string }).body).consumed).toBe(false);
  });
  it("directory unavailability before manual issuance holds the same invitation without consuming or creating it", async () => {
    const { r, admin } = await world(), code = await invite(r, admin, "dan"), a = await begin(r, code.invitation);
    expect((await a.approve("dan")).status).toBe(200);
    const read = vi.spyOn(r.directory, "checkEligibility").mockResolvedValue({ eligible: false, reason: "unavailable" });
    expect((await a.redeem()).status).toBe(503); expect(r.deps.store.read().fleets).toEqual([]);
    expect(JSON.parse((r.db.prepare("SELECT body FROM hub_company_join_invites").get() as { body: string }).body).consumed).toBe(false);
    read.mockRestore(); expect((await a.redeem()).status).toBe(200); expect(r.deps.store.read().fleets).toHaveLength(1);
  });
  it("the admin exception works with never-enabled group policy and retains exact manual provenance", async () => {
    const { r, admin } = await world(false), code = await invite(r, admin, "dan"), a = await begin(r, code.invitation);
    expect((await a.approve("dan")).status).toBe(200); const issued = await a.redeem(); expect(issued.status).toBe(200);
    const replay = await a.redeem(); expect(replay.body.credential).toBe(issued.body.credential);
    expect(r.deps.store.read().fleets).toHaveLength(1);
    expect(r.db.prepare("SELECT source FROM hub_group_resources WHERE resource_key=?").get(JSON.stringify(["fleet", a.binding.fleetId, 1]))).toEqual({ source: "manual" });
  });
  it("an invitation outbox failure rolls back its consumption with the Fleet and manual provenance", async () => {
    const { r, admin } = await world(), code = await invite(r, admin, "dan"), a = await begin(r, code.invitation);
    expect((await a.approve("dan")).status).toBe(200);
    vi.spyOn(r.deps.pairingNotices!, "enqueue").mockImplementation(() => { throw Error("Owned outbox failure"); });
    expect((await a.redeem()).status).toBeGreaterThanOrEqual(400);
    expect(JSON.parse((r.db.prepare("SELECT state FROM hub_transport_state").get() as { state: string }).state).fleets).toEqual([]);
    expect(JSON.parse((r.db.prepare("SELECT body FROM hub_company_join_invites").get() as { body: string }).body).consumed).toBe(false);
  });
});
