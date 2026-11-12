/** Actual sealed Hub/SQLite/HTTPS and owned synthetic LDAPS. No UI mock, account or backend CLI. */
import { afterEach, describe, expect, it, vi } from "vitest";
const dc = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:tls", async original => { const real = await original<typeof import("node:tls")>(); return { ...real,
  connect: (options: import("node:tls").ConnectionOptions) => real.connect({ ...options, ...(options.host === "127.0.0.1" && options.port === 636 ? { port: dc.port } : {}) }) }; });
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { companyJoinRig, type JoinBrowser } from "./support/hub-company-join-rig.js";
import { pkceChallenge, signJoinProof, type JoinPurpose } from "../src/hub/join/protocol.js";
import { personKeyString, sha256 } from "../src/hub/identity.js";
import { retireCompanyJoinForWebAddress } from "../src/hub/join/store.js";
let rig: Awaited<ReturnType<typeof companyJoinRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; vi.restoreAllMocks(); });
async function world(groups = false) {
  const r = rig = await companyJoinRig(port => { dc.port = port; }), admin = await r.signIn("alice"); if (groups) await r.enable(admin);
  expect((await r.call(admin, "PUT", "/hub/v1/admin/company-join", { enabled: true, expectedRevision: 1 })).status).toBe(200);
  return { r, admin };
}
async function make(r: Awaited<ReturnType<typeof companyJoinRig>>, admin: JoinBrowser, patch = {}) {
  const response = await r.call(admin, "POST", "/hub/v1/admin/enrolment-codes", { expires: "today", maxUses: 30, perPersonFleets: 1, scope: { kind: "directory" }, ...patch });
  expect(response.status, response.text).toBe(201); return response.body;
}
async function exclude(r: Awaited<ReturnType<typeof companyJoinRig>>, admin: JoinBrowser, login: string) {
  const path = "/hub/v1/admin/group-policy", current = (await r.call(admin, "GET", path)).body.policy;
  const policy = { ...current, denies: [{ person: { realm: "corp", objectId: r.people.find(p => p.login === login)!.id }, deny: ["pair_fleet"] }] };
  const preview = await r.call(admin, "POST", path + "/preview", { policy }); expect(preview.status, preview.text).toBe(200);
  const saved = await r.call(admin, "PUT", path, { policy, previewDigest: preview.body.previewDigest }); expect(saved.status, saved.text).toBe(200);
  return preview.body;
}
async function begin(r: Awaited<ReturnType<typeof companyJoinRig>>, code: string | null, invitation: string | null = null) {
  const meta = (await r.call(null, "GET", "/hub/v1/join/metadata")).body, keys = generateKeyPairSync("ed25519"), state = randomBytes(32).toString("hex"), verifier = randomBytes(32).toString("base64url");
  const binding = { hub: meta.hub, fleetOrigin: "http://127.0.0.1:4444", requestId: randomUUID(), operationId: randomUUID(), fleetId: randomUUID(),
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), verifierS256: pkceChallenge(verifier) };
  const command = async (purpose: JoinPurpose, payload = {}) => {
    const c = await r.call(null, "POST", "/hub/v1/join/challenge", { binding, purpose }, { Origin: undefined }); expect(c.status).toBe(200);
    return r.call(null, "POST", `/hub/v1/join/${purpose}`, { binding, payload, proof: signJoinProof(binding, purpose, c.body.nonce, c.body.expiresAt, payload, keys.privateKey) }, { Origin: undefined });
  };
  const pushed = await command("push", { label: "Code Fleet", invitation, code, stateHash: sha256(state) });
  const openBrowser = async (login: string) => {
    const open = await r.call(null, "POST", "/hub/join/open", new URLSearchParams({ requestId: binding.requestId, state }).toString(), { "Content-Type": "application/x-www-form-urlencoded", Origin: binding.fleetOrigin });
    expect(open.status).toBe(303); const browser = await r.signIn(login); browser.cookie += "; " + open.cookie;
    return browser;
  };
  const approve = async (login: string) => r.call(await openBrowser(login), "POST", "/hub/v1/join/approve", { requestId: binding.requestId });
  return { binding, command, pushed, approve, openBrowser, redeem: () => command("redeem", { verifier }) };
}
describe("B1 enrolment-code protected routes and actual join", () => {
  it("configured admin creates/reloads a sealed code; eligible outsider joins without turning group policy on", async () => {
    const { r, admin } = await world(), code = await make(r, admin);
    expect(code.freeFleetRows).toBe(256);
    expect((await r.call(admin, "GET", "/hub/v1/admin/enrolment-codes")).body.codes[0]).toMatchObject({ id: code.id, code: code.code, uses: 0, inFlight: 0 });
    expect((await r.call(null, "GET", "/hub/v1/join/metadata")).body.features).toContain("enrolment-code-v1");
    const a = await begin(r, code.code.toLowerCase()); expect(a.pushed.status).toBe(200);
    expect((await a.approve("dan")).status).toBe(200); expect(r.deps.companyJoin!.retained()).toBe(0); expect(r.deps.companyJoin!.records.retained(true)).toBe(1); const issued = await a.redeem(); expect(issued.status, issued.text).toBe(200);
    expect((await a.redeem()).body.credential).toBe(issued.body.credential);
    expect(r.db.prepare("SELECT uses FROM hub_enrolment_codes WHERE id=?").get(code.id)).toEqual({ uses: 1 });
    expect(r.db.prepare("SELECT count(*) n FROM hub_enrolment_code_uses").get()).toEqual({ n: 1 });
    const resource = r.db.prepare("SELECT body,source FROM hub_group_resources WHERE source='code'").get() as any;
    expect(resource).toMatchObject({ source: "code" }); expect(JSON.parse(resource.body)).toMatchObject({ codeId: code.id, approvedBy: expect.any(Object) });
    expect(r.deps.groups).toBeDefined(); expect(JSON.parse((r.db.prepare("SELECT body FROM hub_group_policy").get() as any).body).state).toBe("never-enabled");
    expect(r.db.prepare("SELECT count(*) n FROM hub_group_resources WHERE json_extract(body,'$.kind') IN('asker','exposure')").get()).toEqual({ n: 0 });
    expect(r.db.prepare("SELECT reason_code,code_id FROM hub_audit WHERE action='company-join.identity-approved'").get()).toEqual({ reason_code: "code", code_id: code.id });
    expect(r.deps.audit.verifyChain()).toMatchObject({ ok: true });
    const rows = (await r.call(admin, "GET", "/hub/v1/admin/enrolment-codes")).body.codes;
    expect(rows[0]).toMatchObject({ uses: 1, inFlight: 0, recent: [{ label: "Code Fleet", owner: { name: expect.any(String), login: expect.any(String) }, at: expect.any(Number) }] });
    const codeText = code.code.replace("-", "");
    for (const table of ["hub_company_join_requests", "hub_group_resources", "hub_group_resource_events", "hub_pairing_notices", "hub_audit"]) expect(JSON.stringify(r.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(codeText);
    expect(readFileSync(join(r.home, "hub/secrets/enrolment-code.key"), "utf8")).not.toContain(codeText);
  });
  it("non-admin/unauthenticated calls and code-plus-invitation refuse without creating an offer", async () => {
    const { r, admin } = await world(), carol = await r.signIn("carol"), path = "/hub/v1/admin/enrolment-codes";
    expect((await r.call(null, "POST", path, {})).status).toBeGreaterThanOrEqual(400);
    expect((await r.call(carol, "POST", path, {})).status).toBe(403);
    expect((await r.call(carol, "GET", path)).status).toBe(403);
    expect((await r.call(admin, "POST", path, {}, { "X-AgEnD-Hub-CSRF": undefined })).status).toBe(403);
    expect((await r.call(admin, "POST", path, {}, { Origin: "https://elsewhere.example.test" })).status).toBe(403);
    const code = await make(r, admin), invitation = (await r.call(admin, "POST", "/hub/v1/admin/company-join/invitations", { login: "dan" })).body.invitation;
    expect((await begin(r, code.code, invitation)).pushed.status).toBe(400);
    expect(r.db.prepare("SELECT count(*) n FROM hub_company_join_requests").get()).toEqual({ n: 0 });
  });
  it("maxUses includes unissued reservations, while per-person quota counts existing fleets of every source", async () => {
    const { r, admin } = await world(), code = await make(r, admin, { maxUses: 2 });
    const a = await begin(r, code.code); expect((await a.approve("carol")).status).toBe(200);
    const b = await begin(r, code.code); expect((await b.approve("dan")).status).toBe(200);
    const c = await begin(r, code.code); expect((await c.approve("alice")).status).toBe(403);
    expect((await a.redeem()).status).toBe(200); expect((await b.redeem()).status).toBe(200);
    expect(r.db.prepare("SELECT uses FROM hub_enrolment_codes WHERE id=?").get(code.id)).toEqual({ uses: 2 });
    const more = await make(r, admin), d = await begin(r, more.code); expect((await d.approve("carol")).status).toBe(429);
    expect((await d.command("status")).body).toMatchObject({ state: "pending", reason: "limit-reached" });
  });
  it("concurrent last-slot approvals and redemption issue exactly one Fleet and one use", async () => {
    const { r, admin } = await world(), code = await make(r, admin, { maxUses: 1 }), a = await begin(r, code.code), b = await begin(r, code.code);
    const approved = await Promise.all([a.approve("carol"), b.approve("dan")]);
    expect(approved.filter(x => x.status === 200)).toHaveLength(1);
    const issued = await Promise.all([a.redeem(), b.redeem()]); expect(issued.filter(x => x.status === 200)).toHaveLength(1);
    expect(r.deps.store.read().fleets).toHaveLength(1);
    expect(r.db.prepare("SELECT uses FROM hub_enrolment_codes WHERE id=?").get(code.id)).toEqual({ uses: 1 });
    expect(r.db.prepare("SELECT count(*) n FROM hub_enrolment_code_uses").get()).toEqual({ n: 1 });
  });
  it("revoking between approve/issue ends only unissued requests, and an issued receipt still redelivers", async () => {
    const { r, admin } = await world(), code = await make(r, admin), a = await begin(r, code.code), b = await begin(r, code.code);
    expect((await a.approve("carol")).status).toBe(200); const first = await a.redeem(); expect(first.status).toBe(200);
    expect((await b.approve("dan")).status).toBe(200);
    expect((await r.call(admin, "POST", `/hub/v1/admin/enrolment-codes/${code.id}/revoke`, {})).status).toBe(200);
    expect((await b.redeem()).status).toBeGreaterThanOrEqual(400);
    expect((await a.redeem()).body.credential).toBe(first.body.credential);
    expect(r.deps.store.read().fleets.filter(f => f.status === "active")).toHaveLength(1);
    expect(r.db.prepare("SELECT uses,sealed FROM hub_enrolment_codes WHERE id=?").get(code.id)).toEqual({ uses: 1, sealed: null });
  });
  it("eleven wrong codes pause even valid pushes for a minute, with no request rows and no group starvation", async () => {
    const { r, admin } = await world(true), code = await make(r, admin);
    for (let i = 0; i < 11; i++) expect((await begin(r, "WRNG2345")).pushed.status).toBe(403);
    expect((await begin(r, code.code)).pushed.status).toBe(403);
    expect(r.db.prepare("SELECT count(*) n FROM hub_company_join_requests").get()).toEqual({ n: 0 });
    const group = await begin(r, null); expect(group.pushed.status).toBe(200);
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 60001);
    expect((await begin(r, code.code)).pushed.status).toBe(200);
  });
  it("code admission uses its per-code and global 120 budgets independently of quick/group 48", async () => {
    const { r, admin } = await world(true), a = await make(r, admin), b = await make(r, admin);
    const seed = (buckets: Array<[string, number]>) => r.deps.store.mutate({ at: Date.now(), requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.budget", result: "completed" }, state => {
      state.buckets = buckets.map(([key, attempts]) => ({ key: sha256(key), since: Date.now(), attempts }));
    });
    seed([["quick:all", 48], [`code:${a.id}`, 120]]);
    const refused = await begin(r, a.code); expect((await refused.approve("dan")).status).toBe(429);
    const other = await begin(r, b.code); expect((await other.approve("dan")).status).toBe(200); expect((await other.redeem()).status).toBe(200);
    seed([["code:all", 120]]);
    const busy = await begin(r, b.code); expect((await busy.approve("carol")).status).toBe(429);
    const group = await begin(r, null); expect((await group.approve("carol")).status).toBe(200);
  });
  it("an exact resolved group scope admits members and refuses an eligible non-member", async () => {
    const { r, admin } = await world(true), policy = JSON.parse((r.db.prepare("SELECT body FROM hub_group_policy").get() as any).body), selected = policy.groups[0];
    const code = await make(r, admin, { scope: { kind: "group", ...selected.group, dn: selected.dn } });
    const member = await begin(r, code.code); expect((await member.approve("carol")).status).toBe(200); expect((await member.redeem()).status).toBe(200);
    const outsider = await begin(r, code.code), refused = await outsider.approve("dan"); expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "denied", reason: "code-scope" });
    expect(r.db.prepare("SELECT uses FROM hub_enrolment_codes WHERE id=?").get(code.id)).toEqual({ uses: 1 });
  });
  it("an expired code gives authenticated browser feedback without changing the generic machine answer", async () => {
    const { r, admin } = await world(), code = await make(r, admin, { expires: "1h" }), a = await begin(r, code.code);
    const now = Date.now(); r.db.prepare("UPDATE hub_enrolment_codes SET revoked_at=?,revoked_by=created_by,sealed=NULL WHERE id=?").run(now, code.id);
    expect((await a.approve("dan")).body).toMatchObject({ code: "denied", reason: "code-ended" });
    expect((await begin(r, code.code)).pushed.body).toEqual({ code: "denied" });
  });
  it("real revoke retires a pending code request and preserves its specific browser feedback", async () => {
    const { r, admin } = await world(), code = await make(r, admin), a = await begin(r, code.code);
    const browser = await a.openBrowser("dan");
    expect((await r.call(admin, "POST", "/hub/v1/admin/enrolment-codes/" + code.id + "/revoke", {})).status).toBe(200);
    expect((await r.call(browser, "POST", "/hub/v1/join/approve", { requestId: a.binding.requestId })).body).toEqual({ code: "denied", reason: "code-ended" });
    expect(r.db.prepare("SELECT uses FROM hub_enrolment_codes WHERE id=?").get(code.id)).toEqual({ uses: 0 });
    expect(r.deps.store.read().fleets).toHaveLength(0);
  });
  it("an issued code request keeps conflict/recovery even after its code ends", async () => {
    const { r, admin } = await world(), code = await make(r, admin), a = await begin(r, code.code), browser = await a.openBrowser("dan");
    expect((await r.call(browser, "POST", "/hub/v1/join/approve", { requestId: a.binding.requestId })).status).toBe(200);
    expect((await a.redeem()).status).toBe(200);
    expect((await r.call(admin, "POST", "/hub/v1/admin/enrolment-codes/" + code.id + "/revoke", {})).status).toBe(200);
    expect((await r.call(browser, "POST", "/hub/v1/join/approve", { requestId: a.binding.requestId })).body).toEqual({ code: "conflict" });
    expect(r.db.prepare("SELECT uses FROM hub_enrolment_codes WHERE id=?").get(code.id)).toEqual({ uses: 1 });
  });
  it("policy retirement with a live code keeps ordinary conflict", async () => {
    const { r, admin } = await world(), code = await make(r, admin), a = await begin(r, code.code), browser = await a.openBrowser("dan");
    expect((await r.call(browser, "POST", "/hub/v1/join/approve", { requestId: a.binding.requestId })).status).toBe(200);
    await exclude(r, admin, "dan"); expect(r.deps.companyJoin!.records.get(a.binding.requestId).stage).toBe("ended");
    expect((await r.call(browser, "POST", "/hub/v1/join/approve", { requestId: a.binding.requestId })).body).toEqual({ code: "conflict" });
    expect(r.db.prepare("SELECT uses FROM hub_enrolment_codes WHERE id=?").get(code.id)).toEqual({ uses: 0 });
  });
  it("a last required audit cannot revoke the code and still publish a credential", async () => {
    const { r, admin } = await world(), code = await make(r, admin), a = await begin(r, code.code); expect((await a.approve("dan")).status).toBe(200);
    const append = r.deps.audit.appendInTransaction.bind(r.deps.audit);
    vi.spyOn(r.deps.audit, "appendInTransaction").mockImplementation((event, db) => {
      const result = append(event, db);
      if (event.action === "company-join.code-approved") db.prepare("UPDATE hub_enrolment_codes SET revoked_at=?,revoked_by=created_by WHERE id=?").run(Date.now(), code.id);
      return result;
    });
    expect((await a.redeem()).status).toBeGreaterThanOrEqual(400);
    expect(JSON.parse((r.db.prepare("SELECT state FROM hub_transport_state").get() as any).state).fleets).toEqual([]);
    expect(r.db.prepare("SELECT uses FROM hub_enrolment_codes WHERE id=?").get(code.id)).toEqual({ uses: 0 });
    expect(r.db.prepare("SELECT count(*) n FROM hub_enrolment_code_uses").get()).toEqual({ n: 0 });
  });
  it("expired redemption reservations release code capacity without any Fleet status poll", async () => {
    const { r, admin } = await world(), code = await make(r, admin, { maxUses: 1 }), a = await begin(r, code.code);
    expect((await a.approve("carol")).status).toBe(200);
    const approved = Date.now(); vi.spyOn(Date, "now").mockReturnValue(approved + 60001);
    const b = await begin(r, code.code); expect((await b.approve("dan")).status).toBe(200);
    const old = JSON.parse((r.db.prepare("SELECT body FROM hub_company_join_requests WHERE id=?").get(a.binding.requestId) as any).body);
    expect(old).toMatchObject({ stage: "ended", reason: "expired" });
    expect((await b.redeem()).status).toBe(200);
    expect((await a.redeem()).status).toBeGreaterThanOrEqual(400);
    expect(r.db.prepare("SELECT uses FROM hub_enrolment_codes WHERE id=?").get(code.id)).toEqual({ uses: 1 });
  });
  it("the approval audit cannot retire the code and leave an approved reservation", async () => {
    const { r, admin } = await world(), code = await make(r, admin), a = await begin(r, code.code);
    const append = r.deps.audit.appendInTransaction.bind(r.deps.audit);
    vi.spyOn(r.deps.audit, "appendInTransaction").mockImplementation((event, db) => {
      const result = append(event, db);
      if (event.action === "company-join.identity-approved") db.prepare("UPDATE hub_enrolment_codes SET revoked_at=?,revoked_by=created_by WHERE id=?").run(Date.now(), code.id);
      return result;
    });
    expect((await a.approve("dan")).status).toBeGreaterThanOrEqual(400);
    const saved = JSON.parse((r.db.prepare("SELECT body FROM hub_company_join_requests WHERE id=?").get(a.binding.requestId) as any).body);
    expect(saved.stage).toBe("pending"); expect(saved.owner).toBeNull();
    expect(r.db.prepare("SELECT uses FROM hub_enrolment_codes WHERE id=?").get(code.id)).toEqual({ uses: 0 });
  });
  it("losing owner eligibility after approval issues no credential, code use or provenance", async () => {
    const { r, admin } = await world(), code = await make(r, admin), a = await begin(r, code.code); expect((await a.approve("dan")).status).toBe(200);
    r.people.find(p => p.login === "dan")!.eligible = false; expect((await a.redeem()).status).toBe(403);
    expect(r.deps.store.read().fleets).toEqual([]); expect(r.db.prepare("SELECT count(*) n FROM hub_group_resources").get()).toEqual({ n: 0 });
    expect(r.db.prepare("SELECT uses FROM hub_enrolment_codes WHERE id=?").get(code.id)).toEqual({ uses: 0 });
  });
  it("code notices are hidden from v2 browsers and visible to v3 without changing ownership", async () => {
    const { r, admin } = await world(), code = await make(r, admin), a = await begin(r, code.code);
    expect((await a.approve("dan")).status).toBe(200); expect((await a.redeem()).status).toBe(200);
    expect((await r.call(admin, "GET", "/hub/v1/notices?v=2")).body.notices).toEqual([]);
    expect((await r.call(admin, "GET", "/hub/v1/notices?v=3")).body.notices).toEqual([expect.objectContaining({ source: "code", codeId: code.id })]);
  });
  it("the merged web-address writer retires code reservations and protects the original issued window", async () => {
    const { r, admin } = await world(), code = await make(r, admin), a = await begin(r, code.code);
    expect((await a.approve("dan")).status).toBe(200);
    r.db.transaction(() => retireCompanyJoinForWebAddress(r.db, Date.now())).immediate();
    expect(r.deps.companyJoin!.records.get(a.binding.requestId)).toMatchObject({ stage: "ended", reason: "authority", browserHash: null });
    expect((await r.call(admin, "GET", "/hub/v1/admin/enrolment-codes")).body.codes[0]).toMatchObject({ uses: 0, inFlight: 0, state: "live" });
    const b = await begin(r, code.code); expect((await b.approve("dan")).status).toBe(200); expect((await b.redeem()).status).toBe(200);
    expect(() => r.db.transaction(() => retireCompanyJoinForWebAddress(r.db, Date.now())).immediate()).toThrow("backpressure");
    expect(r.deps.companyJoin!.records.get(b.binding.requestId).stage).toBe("issued");
  });
  it("a real admin exclusion saved before first enable blocks code admission", async () => {
    const { r, admin } = await world(), code = await make(r, admin); await exclude(r, admin, "dan");
    const a = await begin(r, code.code); expect((await a.approve("dan")).status).toBe(403);
    expect(r.deps.store.read().fleets).toEqual([]);
    const b = await begin(r, code.code); expect((await b.approve("carol")).status).toBe(200);
    expect((await b.redeem()).status).toBe(200);
  });
  it.each([false, true])("real policy preview/apply accepts retained code provenance after fleet revoked=%s", async revoked => {
    const { r, admin } = await world(), code = await make(r, admin), a = await begin(r, code.code);
    expect((await a.approve("dan")).status).toBe(200); expect((await a.redeem()).status).toBe(200);
    if (revoked) expect((await r.call(admin, "POST", `/hub/v1/admin/fleets/${a.binding.fleetId}/revoke`, {})).status).toBe(200);
    const path = "/hub/v1/admin/group-policy", policy = { ...(await r.call(admin, "GET", path)).body.policy, state: "enabled", groups: [] };
    const preview = await r.call(admin, "POST", path + "/preview", { policy }); expect(preview.status, preview.text).toBe(200);
    expect((await r.call(admin, "PUT", path, { policy, previewDigest: preview.body.previewDigest })).status).toBe(200);
    expect((await r.call(admin, "GET", path)).body.policy.state).toBe("enabled");
    expect((r.db.prepare("SELECT source FROM hub_group_resources WHERE source='code'").get() as any).source).toBe("code");
    expect(r.deps.store.read().fleets[0]!.status).toBe(revoked ? "revoked" : "active");
  });
  it("real never-enabled preview names and atomically suspends an excluded retained code Fleet", async () => {
    const { r, admin } = await world(), code = await make(r, admin), a = await begin(r, code.code);
    expect((await a.approve("dan")).status).toBe(200); expect((await a.redeem()).status).toBe(200);
    const preview = await exclude(r, admin, "dan");
    expect(preview.impact.suspendedOnSave).toEqual([expect.objectContaining({ kind: "fleet", id: a.binding.fleetId })]);
    expect(r.db.prepare("SELECT state FROM hub_group_resources WHERE source='code'").get()).toEqual({ state: "suspended" });
    expect((await r.call(admin, "GET", "/hub/v1/admin/group-policy")).body.policy.state).toBe("never-enabled");
  });
  it("real never-enabled admin resume recovers a code Fleet after removing its exclusion", async () => {
    const { r, admin } = await world(), code = await make(r, admin), a = await begin(r, code.code);
    expect((await a.approve("dan")).status).toBe(200); expect((await a.redeem()).status).toBe(200);
    await exclude(r, admin, "dan");
    const path = "/hub/v1/admin/group-policy", policy = { ...(await r.call(admin, "GET", path)).body.policy, denies: [] };
    const preview = await r.call(admin, "POST", path + "/preview", { policy }); expect(preview.status, preview.text).toBe(200);
    expect((await r.call(admin, "PUT", path, { policy, previewDigest: preview.body.previewDigest })).status).toBe(200);
    const view = (await r.call(admin, "GET", path)).body, paused = view.paused.find((row: any) => row.resource.id === a.binding.fleetId);
    expect(view.policy.state).toBe("never-enabled"); expect(paused).toBeDefined();
    const request = { resource: paused.resource, expectedPolicyRevision: view.policy.revision, expectedLifecycleRevision: paused.lifecycleRevision };
    expect((await r.call(admin, "POST", path + "/resources/resume", { ...request, expectedLifecycleRevision: paused.lifecycleRevision + 1 })).status).toBe(409);
    const resumed = await r.call(admin, "POST", path + "/resources/resume", request); expect(resumed.status, resumed.text).toBe(200);
    expect(resumed.body).toMatchObject({ ok: true, state: "active", lifecycleRevision: paused.lifecycleRevision + 1 });
    expect((await r.call(admin, "GET", path)).body.paused).toEqual([]);
    expect(r.db.prepare("SELECT source,state FROM hub_group_resources WHERE source='code'").get()).toEqual({ source: "code", state: "active" });
    expect(r.db.prepare("SELECT action FROM hub_audit WHERE action='group-resource.resumed'").all()).toHaveLength(1);
  });
});
