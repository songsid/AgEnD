/**
 * M-2682: Administration → This Hub on the real Hub HTTP (s3b rig): the administrator only, CSRF on both writes, the second
 * step takes only the reference the first returned, the actor handed to the writer is the session's own, and both audit
 * records frame the commit. The writer is a recording fake here (its own behaviour: hub-settings-commit-m2682.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubSettingsError, type HubSettingsWriter } from "../src/hub/settings-commit.js";

const INFO = { hubId: "4c3b2a19-0e8f-4d7c-9b6a-5f4e3d2c1b0a", memberSpkiSha256: "a".repeat(64), issuerKeyId: "k".repeat(16), version: "2.3.5-alpha.9", coexistence: "dedicated" };
let rig: any, rigOff: any, rigRead: any, admin: any, bo: any, seen: Array<[string, unknown]>, refuse: string | null;
const writer: HubSettingsWriter = {
  prepare(op, actor) { seen.push(["prepare", { op, actor }]); if (refuse) throw new HubSettingsError(refuse as never); return { ref: "ref-1", summary: { field: "name", from: "Team Hub", to: op.name }, expiresAt: 1 }; },
  commit(ref, actor, current) { seen.push(["commit", { ref, actor, current: current() }]); if (refuse) throw new HubSettingsError(refuse as never); return { receiptId: "11111111-1111-4111-8111-111111111111", summary: { field: "name", from: "Team Hub", to: "Ops" } }; },
  recover() {}, pending: () => false,
};
beforeAll(async () => {
  rig = await s3bRig({ hubSettings: { info: INFO, writer } });
  rig.addPerson("bo", "Bo Wu");
  admin = await rig.signIn("admin"); bo = await rig.signIn("bo");
  rigOff = await s3bRig();
  rigRead = await s3bRig({ hubSettings: { info: INFO } });
});
afterAll(async () => { await rig?.close(); await rigOff?.close(); await rigRead?.close(); });
beforeEach(() => { seen = []; refuse = null; });

describe("Administration → This Hub", () => {
  it("the administrator reads what this Hub is; anyone else is refused; without the deps the routes are 404", async () => {
    const r = await rig.call(admin, "GET", "/hub/v1/admin/hub");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, name: "Team Hub", ...INFO, rename: true });
    expect((await rig.call(bo, "GET", "/hub/v1/admin/hub")).status).toBe(403);
    expect((await rig.call(null, "GET", "/hub/v1/admin/hub")).status).toBe(401);
    const a2 = await rigOff.signIn("admin");
    expect((await rigOff.call(a2, "GET", "/hub/v1/admin/hub")).status).toBe(404);
    const a3 = await rigRead.signIn("admin");
    expect((await rigRead.call(a3, "GET", "/hub/v1/admin/hub")).json).toMatchObject({ rename: false });
    expect((await rigRead.call(a3, "POST", "/hub/v1/admin/hub/name/prepare", { name: "x" })).json).toEqual({ ok: false, code: "unavailable" });
  });
  it("prepare then commit: the session's own actor, the reference only, and a held + completed audit around the commit", async () => {
    const before = rig.audits.length;
    const p = await rig.call(admin, "POST", "/hub/v1/admin/hub/name/prepare", { name: "Ops" });
    expect(p.json).toEqual({ ok: true, ref: "ref-1", summary: { field: "name", from: "Team Hub", to: "Ops" }, expiresAt: 1 });
    const c = await rig.call(admin, "POST", "/hub/v1/admin/hub/name/commit", { ref: "ref-1", name: "Evil", person: { realm: "x", objectId: "y" } });
    expect(c.json).toEqual({ ok: true, summary: { field: "name", from: "Team Hub", to: "Ops" } });
    const [prep, commit] = seen;
    expect(prep![1]).toMatchObject({ op: { kind: "rename", name: "Ops" }, actor: { person: rig.admin } });
    expect(commit![1]).toMatchObject({ ref: "ref-1", actor: { person: rig.admin }, current: true });
    expect((commit![1] as any).actor.sessionId).toBe((prep![1] as any).actor.sessionId);
    const records = rig.audits.slice(before).filter((a: any) => a.action === "hub.settings.rename");
    expect(records.map((a: any) => [a.result, a.reasonCode ?? null])).toEqual([["held", null], ["completed", "11111111-1111-4111-8111-111111111111"]]);
    // clearing is an explicit null
    await rig.call(admin, "POST", "/hub/v1/admin/hub/name/prepare", { name: null });
    expect(seen.at(-1)![1]).toMatchObject({ op: { kind: "rename", name: null } });
  });
  it("writes need CSRF and the administrator; a writer refusal is a plain code, never a 500", async () => {
    expect((await rig.call({ cookie: admin.cookie, csrf: "wrong" }, "POST", "/hub/v1/admin/hub/name/prepare", { name: "Ops" })).status).toBe(403);
    expect((await rig.call(bo, "POST", "/hub/v1/admin/hub/name/prepare", { name: "Ops" })).status).toBe(403);
    expect((await rig.call(admin, "POST", "/hub/v1/admin/hub/name/prepare", {})).json).toEqual({ ok: false, code: "invalid" });
    expect((await rig.call(admin, "POST", "/hub/v1/admin/hub/name/commit", { ref: 7 })).json).toEqual({ ok: false, code: "invalid" });
    expect(seen).toEqual([]);
    for (const [code, status] of [["stale", 409], ["denied", 403], ["unavailable", 503], ["invalid", 400]] as const) {
      refuse = code;
      const before = rig.audits.length;
      const r = await rig.call(admin, "POST", "/hub/v1/admin/hub/name/commit", { ref: "ref-1" });
      expect([r.status, r.json]).toEqual([status, { ok: false, code }]);
      // the attempt's outcome beside its held record (Fable #3426 N2)
      expect(rig.audits.slice(before).filter((a: any) => a.action === "hub.settings.rename").map((a: any) => [a.result, a.reasonCode ?? null])).toEqual([["held", null], ["denied", code]]);
    }
    expect((await rig.call(admin, "GET", "/hub/v1/admin/hub/name/commit")).status).toBe(405);
  });
});
