/**
 * M-3533 R2a: a room office draws each shared agent in its owner's look — the identity colour and persona emoji its
 * Fleet's agent catalog already sends (agent-catalog-model.ts row `avatar`), matched by the row's exposure. No look in
 * the catalog (or a Fleet whose catalog names no exposures): the agent stays as R1 drew it.
 */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { withLook } from "../src/hub/rooms/office.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });

async function world() {
  r = await s3bRig({ roomOffice: true });
  const alex = r.addPerson("alex", "Alex"), a = await r.signIn("alex"), admin = await r.signIn("admin");
  const fleetId = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, (state: any) => {
    state.fleets.push({ id: fleetId, owner: r!.admin, generation: 1, credentialHash: null, status: "active", label: "Admin fleet" }); });
  const link = r.link(fleetId, r.admin, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", "exposure-request-v1"]);
  const notes = randomUUID(), plan = randomUUID();
  const ex = (id: string, name: string) => ({ id, fleetId, owner: r!.admin, displayName: name, revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [ex(notes, "Notes"), ex(plan, "Planner")] }, link) as never, link);
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Room", people: [personKeyString(alex)], agents: [notes, plan] });
  return { a, link, notes, plan, id: made.json.room.id as string };
}
const catalog = (rows: Array<{ instance: string; id: string; avatar: unknown }>) => ({ revision: "c".repeat(64), enabled: true, requests: true,
  agents: rows.map((x) => ({ instance: x.instance, displayName: x.instance, description: "", avatar: x.avatar, kind: "agent", general: false, shareable: true, exposure: { id: x.id, revision: 1, state: "published" } })) });

it("draws a shared agent in its owner's colour and emoji; one with no look stays as before", async () => {
  const w = await world();
  const view = async () => (await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/office/state`)).json.instances;
  // Before any catalog: no look.
  expect((await view()).map((i: any) => [i.display_name, i.color ?? null, i.avatar ?? null]).sort()).toEqual([["Notes", null, null], ["Planner", null, null]]);
  const ack: any = await r!.http.receive(r!.frame("agent.catalog", catalog([{ instance: "notes", id: w.notes, avatar: { emoji: "🦊", color: "#D97757" } }, { instance: "plan", id: w.plan, avatar: null }]), w.link) as never, w.link);
  expect(ack?.payload?.ok ?? true).toBe(true);
  const after = await view();
  expect(after.find((i: any) => i.name === w.notes)).toMatchObject({ color: { person: "#d97757" }, avatar: { kind: "emoji", text: "🦊" } });
  const planner = after.find((i: any) => i.name === w.plan);
  expect([planner.color, planner.avatar]).toEqual([undefined, undefined]);
  // The room's other reads are unchanged.
  expect(Object.keys(after.find((i: any) => i.name === w.notes)).sort()).toEqual(["avatar", "color", "display_name", "execution_state", "name", "presence", "status"]);
});

it("withLook: only a #rrggbb colour and a non-blank emoji, nothing else", () => {
  const base = { name: "x", display_name: "X", status: "running" as const, execution_state: "idle" as const, presence: "idle" as const };
  expect(withLook(base, { color: "#ABCDEF", emoji: " 🦊 " })).toEqual({ ...base, color: { person: "#abcdef" }, avatar: { kind: "emoji", text: "🦊" } });
  expect(withLook(base, { color: "red", emoji: "  " })).toEqual(base);
  expect(withLook(base, null)).toEqual(base);
});
