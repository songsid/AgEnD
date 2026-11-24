/**
 * M-3533 R1b (§2.1b): a room office's style — managers only, one of the room styles (largest first, no desks style),
 * and one line per saved change: "{name} changed the room office's style to "{style}"" (the reader's page words it).
 */
import { afterEach, expect, it } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { ROOM_OFFICE_STYLES } from "../src/hub/rooms/office.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });

async function room(office = true) {
  r = await s3bRig({ realAudit: true, ...(office ? { roomOffice: true } : {}) });
  const alex = r.addPerson("alex", "Alex"), a = await r.signIn("alex"), admin = await r.signIn("admin");
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alex)] });
  return { a, admin, id: made.json.room.id as string };
}
const lines = async (w: { a: unknown; id: string }) => ((await r!.call(w.a as never, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages as any[]).filter(m => m.system?.kind === "office-style-changed");

it("the room styles, largest first (the page's ROOM_STYLES: hub-room-office-style-m3533.test.ts)", () => {
  expect([...ROOM_OFFICE_STYLES]).toEqual(["studio-large", "studio", "cozy", "guild", "school"]);
});

it("a manager saves a style: one line per real change, none for the same one; detail and the office follow", async () => {
  const w = await room();
  expect((await r!.call(w.admin, "GET", `/hub/v1/rooms/${w.id}`)).json.settings.office).toEqual({ enabled: true, style: "studio" });
  const saved = await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { office: { style: "studio-large" } });
  expect(saved.status).toBe(200); expect(saved.json.settings.office).toEqual({ enabled: true, style: "studio-large" });
  await r!.restartHttp();
  expect((await lines(w)).map(m => [m.system, m.text])).toEqual([[{ kind: "office-style-changed", name: "Hub Admin", style: "studio-large" }, "Hub Admin changed the room office's style to \"studio-large\""]]);
  expect((await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/office/state`)).json.offices.offices[0].skin).toBe("studio-large");
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { office: { style: "studio-large" } });
  expect(await lines(w)).toHaveLength(1);
  // Turning it off and choosing a style in one save: both lines, the switch's first.
  await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { office: { enabled: false, style: "cozy" } });
  const all = ((await r!.call(w.a, "GET", `/hub/v1/rooms/${w.id}/messages`)).json.messages as any[]).filter(m => /^office-/.test(m.system?.kind ?? ""));
  expect(all.map(m => m.system.kind)).toEqual(["office-style-changed", "office-changed", "office-style-changed"]);
  expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_audit WHERE action='room.office-style-changed'").get()).toEqual({ n: 2 });
});

it("refuses a style that is not a room style, a member's change, and a style while the Hub does not serve the office", async () => {
  const w = await room();
  for (const style of ["pixel", "no-such", "__proto__", "", "STUDIO"]) expect((await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { office: { style } })).status, style).toBe(400);
  expect((await r!.call(w.admin, "PATCH", `/hub/v1/rooms/${w.id}`, { office: { style: "cozy", seats: 3 } })).status).toBe(400);
  expect((await r!.call(w.a, "PATCH", `/hub/v1/rooms/${w.id}`, { office: { style: "cozy" } })).status).toBe(403);
  expect(await lines(w)).toEqual([]);
  await r!.close();
  const off = await room(false);
  expect((await r!.call(off.admin, "PATCH", `/hub/v1/rooms/${off.id}`, { office: { style: "cozy" } })).status).toBe(400);
});
