/** Real HubCore admission + cookie HTTP, inert in-memory directory. No listener outside the owned loopback rig. */
import { afterEach, describe, expect, it } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { createHubWebClient } from "/ui/js/hub-client.js";
const rigs: Awaited<ReturnType<typeof s3bRig>>[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
describe("admin GET scheduling against the actual 4/person eligibility cap", () => {
  it("raw concurrent requests exhaust admission; the same real routes through the client serialize and all finish", async () => {
    const rig = await s3bRig(); rigs.push(rig); const signed = await rig.signIn("admin"); expect(signed.status).toBe(200);
    const original = rig.directory.checkEligibility.bind(rig.directory); let active = 0, peak = 0, entered = 0;
    let release!: () => void, allFour!: () => void; const held = new Promise<void>(r => { release = r; }), four = new Promise<void>(r => { allFour = r; });
    rig.directory.checkEligibility = async key => {
      entered++; active++; peak = Math.max(peak, active); if (entered === 4) allFour();
      try { await held; return await original(key); } finally { active--; }
    };
    const paths = ["/hub/v1/admin/overview", "/hub/v1/rooms", "/hub/v1/exposures", "/hub/v1/pairings"];
    const blocked = paths.map(path => rig.call(signed, "GET", path));
    try { await four; expect((await rig.call(signed, "GET", "/hub/v1/admin/overview")).status).toBe(429); expect(peak).toBe(4); }
    finally { release(); await Promise.all(blocked); }
    active = 0; peak = 0; entered = 0;
    rig.directory.checkEligibility = async key => {
      entered++; active++; peak = Math.max(peak, active);
      try { await new Promise<void>(r => setImmediate(r)); return await original(key); } finally { active--; }
    };
    const fetchImpl = async (path: string, init: any) => {
      const r = await rig.call(signed, init.method, path);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: new Headers(), json: async () => r.json };
    };
    const client = createHubWebClient({ fetchImpl } as any);
    const answers = await Promise.all([client.adminOverview(), client.rooms(), client.catalog(), client.pairings(), client.session()]);
    expect(answers.every(answer => answer.ok)).toBe(true); expect(peak).toBe(1); expect(entered).toBeGreaterThanOrEqual(4);
  });
});
