/**
 * #3226 C (the user's choice): the owner's "Recent questions" — GET /hub/v1/exposures/:id/activity on the real Hub
 * listener (the s3b rig). Who asked one of the owner's agents, when, and how it went; never what was asked or answered;
 * the owner only (anyone else: not-found, nothing named); the latest first; the read audited as a metadata read.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";

describe("the owner's recent questions (#3226 C)", () => {
  let rig: any, olivia: any, alex: any, ben: any, exposureId = "", R1 = "";
  beforeAll(async () => {
    rig = await s3bRig();
    const owner = rig.addPerson("olivia", "Olivia Chen"); rig.addPerson("alex", "Alex Lin"); rig.addPerson("ben", "Ben Wu");
    const fleetId = randomUUID(), link = rig.link(fleetId, owner); exposureId = randomUUID();
    await rig.http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId, owner, displayName: "Sales numbers", revision: 1,
      state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link), link);
    for (const l of ["olivia", "alex", "ben"]) await rig.signIn(l);
    olivia = await rig.signIn("olivia");
    const g = (await rig.call(olivia, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "alex", days: 7 })).json.grant;
    alex = await rig.signIn("alex"); ben = await rig.signIn("ben");
    R1 = (await rig.call(alex, "POST", "/hub/v1/rooms", { exposureId, grantId: g.id })).json.room.id;
    for (const text of ["What were Q3 sales?", "And Q4?"]) await rig.call(alex, "POST", `/hub/v1/rooms/${R1}/messages`, { idempotencyKey: randomUUID(), text });
  });
  afterAll(async () => { await rig?.close(); });

  it("who asked, when, and the stage — the latest first; never the question's or the answer's text", async () => {
    const r = await rig.call(olivia, "GET", `/hub/v1/exposures/${exposureId}/activity`);
    expect(r.status).toBe(200);
    expect(r.json.activity.map((a: any) => [a.askerName, a.stage, typeof a.askedAt])).toEqual([["Alex Lin", "queued", "number"], ["Alex Lin", "queued", "number"]]);
    expect(r.json.activity[0].askedAt).toBeGreaterThanOrEqual(r.json.activity[1].askedAt);
    expect(Object.keys(r.json.activity[0]).sort()).toEqual(["askedAt", "askerName", "stage"]);
    expect(r.text).not.toMatch(/Q3|Q4|sales/i);
  });
  it("the owner only: the asker and anyone else get not-found, with nothing named", async () => {
    for (const who of [alex, ben]) {
      const r = await rig.call(who, "GET", `/hub/v1/exposures/${exposureId}/activity`);
      expect([r.status, r.json.code]).toEqual([404, "not-found"]);
      expect(r.text).not.toContain("Alex Lin");
    }
    expect((await rig.call(null, "GET", `/hub/v1/exposures/${exposureId}/activity`)).status).toBe(401);
    expect((await rig.call(olivia, "GET", `/hub/v1/exposures/${randomUUID()}/activity`)).status).toBe(404);
    expect((await rig.call(olivia, "POST", `/hub/v1/exposures/${exposureId}/activity`, {})).status).toBe(405);
  });
  it("the read is audited as a metadata read by the owner", async () => {
    const reads = rig.audits.filter((a: any) => a.action === "exposure.activity-read");
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(reads.every((a: any) => a.exposureId === exposureId && a.actor.kind === "person")).toBe(true);
  });
});
