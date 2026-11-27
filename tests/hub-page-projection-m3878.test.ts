import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import * as validation from "../src/hub/validation.js";
import { initialGroupPolicy } from "../src/hub/group-policy/model.js";
import { parseCanonicalPolicy, resetCanonicalPolicyDecodeMemoForTest } from "../src/hub/roles/read.js";
import { HubFleetVersions } from "../src/hub/fleet-versions.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); resetCanonicalPolicyDecodeMemoForTest(); await r?.close(); r = undefined; });
async function world(count: number) {
  r = await s3bRig(); const admin = await r.signIn("admin"), owner = r.admin;
  const fleets = Array.from({ length: count }, () => randomUUID()), exposures = fleets.map(() => randomUUID());
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
    state.fleets.push(...fleets.map(id => ({ id, owner, generation: 1, credentialHash: "a".repeat(64), status: "active" as const })));
  });
  for (const [i, id] of exposures.entries()) r.db.prepare(`INSERT INTO hub_exposures
    (id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at)
    VALUES(?,?,?,?,1,'published',?,'[]',?,?)`).run(id, fleets[i], personKeyString(owner), "Synthetic agent", randomUUID(), "b".repeat(64), Date.now());
  const created = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Synthetic room" });
  expect(created.status).toBe(200); const room = created.json.room.id as string;
  for (const id of exposures) r.db.prepare("INSERT INTO hub_room_members(id,room_id,kind,subject,role,joined_sequence,owner_at_join) VALUES(?,?,'agent',?,'member',0,?)")
    .run(randomUUID(), room, id, personKeyString(owner));
  const current = r.httpDeps.current;
  r.httpDeps.current = () => { r!.store.read(); return current(); };
  return { admin, room };
}
async function cost(count: number, endpoint: string) {
  const w = await world(count), reads = vi.spyOn(r!.store, "read");
  const result = await r!.call(w.admin, "GET", endpoint.replace("ROOM", w.room));
  expect(result.status).toBe(200); const n = reads.mock.calls.length;
  vi.restoreAllMocks(); await r!.close(); r = undefined;
  return n;
}
it.each([
  "/hub/v1/rooms/ROOM",
  "/hub/v1/exposures",
  "/hub/v1/me/agents",
  "/hub/v1/admin/dashboard?range=7d&timeZone=UTC",
  "/hub/v1/admin/overview",
])("bounds shared-state reads while projecting eight items: %s", async endpoint => {
  const one = await cost(1, endpoint), eight = await cost(8, endpoint);
  expect(eight).toBeLessThanOrEqual(one + 4);
});
it("refuses the whole Fleet overview when its mount retires during projection", async () => {
  const w = await world(8), original = HubFleetVersions.prototype.view;
  let projected = 0;
  vi.spyOn(HubFleetVersions.prototype, "view").mockImplementation(function (this: HubFleetVersions, ...args) {
    const value = original.apply(this, args); if (++projected === 2) r!.disable(); return value;
  });
  const result = await r!.call(w.admin, "GET", "/hub/v1/admin/overview");
  expect(result.status).toBe(503); expect(result.json.fleets).toBeUndefined();
});

it("keeps strict state decoding bounded for the full eight-Fleet page", async () => {
  const w = await world(8), current = r!.httpDeps.current;
  r!.db.exec("CREATE TABLE fixture_policy(body TEXT NOT NULL)");
  r!.db.prepare("INSERT INTO fixture_policy VALUES(?)").run(JSON.stringify(initialGroupPolicy("corp", "g1")));
  resetCanonicalPolicyDecodeMemoForTest();
  r!.httpDeps.current = () => {
    const raw = (r!.db.prepare("SELECT body FROM fixture_policy").get() as { body: string }).body;
    parseCanonicalPolicy(raw); return current();
  };
  const decode = vi.spyOn(validation, "parseStrictJson");
  const result = await r!.call(w.admin, "GET", "/hub/v1/admin/overview");
  expect(result.status).toBe(200); expect(result.json.fleets).toHaveLength(8);
  expect(decode.mock.calls.length).toBeLessThanOrEqual(2);
});
