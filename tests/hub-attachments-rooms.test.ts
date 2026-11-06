/** #3226 D at the room level (createHubHttp + member receiver): a link that loses attachments-v1, and room scoping. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import type { HubExposure, PersonKey } from "../src/hub/types.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
let rig: Rig | null = null;
afterEach(async () => { await rig?.close(); rig = null; });
const exposure = (fleetId: string, owner: PersonKey, name: string): HubExposure => ({ id: randomUUID(), fleetId, owner, displayName: name, revision: 1, state: "published",
  dataViewId: "v", allowedTools: [], policyDigest: "b".repeat(64) });
async function world(r: Rig, names = ["Sales"]) {
  const owner = r.addPerson("olivia", "Olivia"); r.addPerson("alex", "Alex");
  const fleetId = randomUUID(), link = r.link(fleetId, owner, 1, ["attachments-v1"]), es = names.map(n => exposure(fleetId, owner, n));
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: es }, link) as never, link);
  const o = await r.signIn("olivia"), a = await r.signIn("alex"), rooms: string[] = [];
  for (const e of es) {
    const g = await r.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login: "alex", days: 7 });
    rooms.push((await r.call(a, "POST", "/hub/v1/rooms", { exposureId: e.id, grantId: g.json.grant.id })).json.room.id);
  }
  const upload = async (roomId: string, name: string, body: string) => {
    const res = await fetch(`${r.base}/hub/v1/rooms/${roomId}/files`, { method: "POST", body, headers: { Origin: "https://hub.example.test", Cookie: a.cookie, "X-AgEnD-Hub-CSRF": a.csrf, "X-File-Name": name } });
    return { status: res.status, json: await res.json() as any };
  };
  return { owner, fleetId, link, es, o, a, rooms, upload };
}

it("a link that loses attachments-v1: a new question with files is refused, and a queued one fails visibly instead of being sent without them", async () => {
  rig = await s3bRig({ attachments: true }); const w = await world(rig);
  rig.setTransport(false);
  const one = await w.upload(w.rooms[0]!, "one.txt", "first"), two = await w.upload(w.rooms[0]!, "two.txt", "second");
  expect([one.status, two.status]).toEqual([200, 200]);
  const asked = await rig.call(w.a, "POST", `/hub/v1/rooms/${w.rooms[0]}/messages`, { idempotencyKey: randomUUID(), text: "with a file", files: [one.json.file.id] });
  expect(asked.status).toBe(200);
  // The member reconnects as an older build: its new link has no optional features.
  w.link.alive = false;
  const older = rig.link(w.fleetId, w.owner, 2);
  await rig.http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: w.es }, older) as never, older);
  expect((await rig.call(w.a, "GET", "/hub/v1/rooms")).json.rooms[0].features).toEqual([]);
  const refused = await rig.call(w.a, "POST", `/hub/v1/rooms/${w.rooms[0]}/messages`, { idempotencyKey: randomUUID(), text: "another", files: [two.json.file.id] });
  expect(refused.status).toBe(400); expect(refused.json.code).toBe("incompatible");
  rig.setTransport(true);
  await rig.http.receive(rig.frame("reconcile", { afterReceiptSequence: 0, messages: [] }, older) as never, older);
  await vi.waitFor(() => expect(rig!.db.prepare("SELECT stage, reason_code FROM hub_messages").get()).toEqual({ stage: "failed", reason_code: "incompatible" }));
  expect(rig.sent.filter(s => s.frame.type === "question")).toHaveLength(0);
  expect(rig.audits.some(x => x.action === "question.failed" && x.reasonCode === "incompatible")).toBe(true);
});

it("a file belongs to its room: another room of the same asker cannot serve or attach it", async () => {
  rig = await s3bRig({ attachments: true }); const w = await world(rig, ["Sales", "Support"]);
  const f = await w.upload(w.rooms[0]!, "a.txt", "room one");
  expect((await rig.call(w.a, "GET", f.json.file.url)).status).toBe(200);
  expect((await rig.call(w.a, "GET", `/hub/v1/rooms/${w.rooms[1]}/files/${f.json.file.id}`)).status).toBe(404);
  expect((await rig.call(w.a, "POST", `/hub/v1/rooms/${w.rooms[1]}/messages`, { idempotencyKey: randomUUID(), text: "x", files: [f.json.file.id] })).status).toBe(404);
});
