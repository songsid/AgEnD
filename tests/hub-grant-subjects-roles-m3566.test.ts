/** M-3566: owner grant search and AD-group grant checks keep working once a roles policy is the stored canonical policy. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { createHubGroupPolicyStore, groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { initialGroupPolicy } from "../src/hub/group-policy/model.js";
import { convertGroupPolicy } from "../src/hub/roles/convert.js";
import { parseCanonicalPolicy } from "../src/hub/roles/read.js";
import type { PersonKey } from "../src/hub/types.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
const rigs: Rig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); vi.restoreAllMocks(); });

async function world() {
  const at = Date.now();
  const r = await s3bRig({ now: () => at }); rigs.push(r);
  const owner = r.addPerson("olivia"), recipient = r.addPerson("alex", "Alex Chen");
  const group = { realm: "corp", objectId: randomUUID() }, dn = "CN=Engineering,DC=example,DC=test";
  Object.assign(r.directory, {
    groupPolicy: "ad-direct-guid",
    resolvePolicyGroup: vi.fn(async (input: string) => input === dn ? { ok: true, group: { key: group, dn } } : { ok: false, reason: "not-found" }),
    readPolicyGroups: vi.fn(async (key: PersonKey) => ({ kind: "complete", person: { ...key },
      groups: key.objectId === recipient.objectId ? [group.objectId] : [], observedAt: at })),
    searchPolicyGroups: vi.fn(async () => ({ ok: true, groups: [{ objectId: group.objectId, cn: "Engineering", dn }], truncated: false })),
    searchGrantPeople: vi.fn(async () => ({ ok: true, people: [{ person: recipient, login: "alex", displayName: "Alex Chen" }], truncated: false })),
  });
  groupPolicyMigration(r.hubId, "corp", "directory-v1").up(r.db);
  const policy = createHubGroupPolicyStore({ db: r.db, hubId: r.hubId, realm: "corp", generation: "directory-v1", directory: r.directory,
    audit: { appendInTransaction() {} } as never, current: () => true, now: () => at });
  (r.httpDeps as any).grantDirectory = { policy: () => policy, binding: () => ({ kind: "ready" }) };
  /** The stored policy becomes the converted roles document, as the roles cutover leaves it on a real Hub. */
  const activateRoles = () => {
    const roles = convertGroupPolicy(initialGroupPolicy("corp", "directory-v1"), { root: owner, now: at, rolesActive: true });
    r.db.prepare("UPDATE hub_group_policy SET body=? WHERE singleton=1").run(JSON.stringify(roles));
    expect(policy.canonical!().kind).toBe("roles");
    expect(() => policy.read()).toThrow(); // the legacy group-only reader refuses it: the trap this card fixes
  };
  const browser = await r.signIn("olivia"), asker = await r.signIn("alex");
  const exposureId = randomUUID(), link = r.link(randomUUID(), owner);
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId: link.fleetId, owner,
    displayName: "Shared agent", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
  const grant = () => r.call(browser, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, days: 90, subject: { kind: "group", group, dn } });
  const search = (kind: "person" | "group") => r.call(browser, "POST", `/hub/v1/exposures/${exposureId}/grant-subjects/search`, { exposureRevision: 1, kind, q: "Al" });
  return { r, recipient, group, dn, asker, grant, search, activateRoles };
}

describe("M-3566 owner grants with an active roles policy", () => {
  it("person search in the grant dialog answers the directory's people", async () => {
    const w = await world(); w.activateRoles();
    const out = await w.search("person");
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ ok: true, people: [{ person: w.recipient, login: "alex", displayName: "Alex Chen" }], truncated: false });
  });
  it("group search in the grant dialog answers the directory's groups", async () => {
    const w = await world(); w.activateRoles();
    const out = await w.search("group");
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ ok: true, groups: [{ objectId: w.group.objectId, cn: "Engineering", dn: w.dn }], truncated: false });
  });
  it("an AD-group grant can be created and the member's agent list still loads and shows it", async () => {
    const w = await world(); w.activateRoles();
    const created = await w.grant();
    expect(created.status).toBe(200);
    const view = await w.r.call(w.asker, "GET", "/hub/v1/exposures");
    expect(view.status).toBe(200);
    expect(view.json.askable.map((x: any) => x.grant.id)).toEqual([created.json.grant.id]);
  });
  it("a group grant made before roles were on still reaches the member's agent list afterwards", async () => {
    const w = await world();
    const created = await w.grant(); expect(created.status).toBe(200);
    w.activateRoles();
    const view = await w.r.call(w.asker, "GET", "/hub/v1/exposures");
    expect(view.status).toBe(200);
    expect(view.json.askable.map((x: any) => x.grant.id)).toEqual([created.json.grant.id]);
  });
  it("a roles policy change between the read and its fence still refuses the result", async () => {
    const w = await world(); w.activateRoles();
    const lookup = (w.r.directory as any).searchGrantPeople as ReturnType<typeof vi.fn>;
    lookup.mockImplementationOnce(async () => {
      const row = w.r.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string };
      const doc = parseCanonicalPolicy(row.body);
      w.r.db.prepare("UPDATE hub_group_policy SET body=? WHERE singleton=1").run(JSON.stringify({ ...doc.policy, revision: doc.policy.revision + 1 }));
      return { ok: true, people: [{ person: w.recipient, login: "alex", displayName: "Alex Chen" }], truncated: false };
    });
    const out = await w.search("person");
    expect(out.status).toBe(503);
    expect(out.json.ok).not.toBe(true);
  });
});
