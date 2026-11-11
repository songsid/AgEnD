/** S2: actual Hub HTTP/CSRF + production directory over owned verified LDAPS. */
import { afterEach, describe, expect, it, vi } from "vitest";
const dc = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:tls", async original => {
  const real = await original<typeof import("node:tls")>();
  return { ...real, connect: (options: import("node:tls").ConnectionOptions) => real.connect({ ...options,
    ...(options.host === "127.0.0.1" && options.port === 636 ? { port: dc.port } : {}) }) };
});
import { randomUUID } from "node:crypto";
import { companyJoinRig } from "./support/hub-company-join-rig.js";
import { GROUP_A, GROUP_DN } from "./support/hub-group-directory-wire.js";
let rig: Awaited<ReturnType<typeof companyJoinRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; vi.restoreAllMocks(); });
async function world() { const r = rig = await companyJoinRig(p => { dc.port = p; }); return { r, admin: await r.signIn("alice") }; }
const path = "/hub/v1/admin/group-policy/search";
describe("bounded group prefix suggestions", () => {
  it("finds Owners case-insensitively, spends service bind, and leaves selection authority to resolve", async () => {
    const { r, admin } = await world(), before = r.wire.searches.length;
    const result = await r.call(admin, "POST", path, { q: "  oWn  " });
    expect(result).toMatchObject({ status: 200, body: { ok: true, groups: [{ objectId: GROUP_A, cn: "Owners", dn: GROUP_DN }], truncated: false } });
    const searches = r.wire.searches.slice(before).filter(s => s.sizeLimit === 20);
    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({ base: "DC=example,DC=test", scope: 2, deref: 0, sizeLimit: 20, timeLimit: 5,
      attributes: ["objectGUID", "cn", "distinguishedName"], controls: [] });
    expect(JSON.stringify(searches[0].filter)).toContain("oWn");
    const resolved = await r.call(admin, "POST", "/hub/v1/admin/group-policy/resolve", { dn: result.body.groups[0].dn });
    expect(resolved.body).toMatchObject({ realm: "corp", objectId: GROUP_A, dn: GROUP_DN });
    expect(r.db.prepare("SELECT COUNT(*) n FROM hub_group_resources").get()).toEqual({ n: 0 });
  });
  it("treats filter metacharacters as literal prefix text", async () => {
    const { r, admin } = await world();
    const result = await r.call(admin, "POST", path, { q: "*)(cn=*" });
    expect(result).toMatchObject({ status: 200, body: { ok: true, groups: [], truncated: false } });
    const wire = r.wire.searches.filter(s => s.sizeLimit === 20).at(-1);
    expect(JSON.stringify(wire.filter)).toContain("*)(cn=*");
  });
  it("caps 21 matches at 20 and ignores continuation references", async () => {
    const { r, admin } = await world();
    for (let i = 0; i < 21; i++) r.wire.state.labels.set(randomUUID(), `CN=Search${String(i).padStart(2, "0")},DC=example,DC=test`);
    r.wire.state.mode = "continuation";
    const result = await r.call(admin, "POST", path, { q: "Search" });
    expect(result).toMatchObject({ status: 200, body: { ok: true, truncated: true } });
    expect(result.body.groups).toHaveLength(20);
    expect((await r.call(admin, "POST", path, { q: "NoSuchGroup" })).body).toEqual({ ok: true, groups: [], truncated: false });
  });
  it("refuses short/control/extra inputs and nonadmin, missing CSRF, cross-origin requests", async () => {
    const { r, admin } = await world(), carol = await r.signIn("carol"), before = r.wire.searches.length;
    for (const q of ["x", "\u0000own", "own\n", "x".repeat(65)]) expect((await r.call(admin, "POST", path, { q })).status).toBe(400);
    expect((await r.call(admin, "POST", path, { q: "own", realm: "other" })).status).toBe(400);
    expect(r.wire.searches).toHaveLength(before);
    expect((await r.call(null, "POST", path, { q: "own" })).status).toBe(401);
    expect((await r.call(carol, "POST", path, { q: "own" })).status).toBe(403);
    expect((await r.call(admin, "POST", path, { q: "own" }, { "X-AgEnD-Hub-CSRF": "" })).status).toBe(403);
    expect((await r.call(admin, "POST", path, { q: "own" }, { Origin: "https://other.invalid" })).status).toBe(403);
  });
  it("limits the 31st search per exact admin session and permits a fresh session", async () => {
    const { r, admin } = await world();
    for (let i = 0; i < 30; i++) expect((await r.call(admin, "POST", path, { q: "own" })).status).toBe(200);
    const before = r.wire.searches.filter(s => s.sizeLimit === 20).length;
    expect((await r.call(admin, "POST", path, { q: "own" }))).toMatchObject({ status: 429, body: { ok: false, reason: "limited" } });
    expect(r.wire.searches.filter(s => s.sizeLimit === 20)).toHaveLength(before);
    expect((await r.call(await r.signIn("alice"), "POST", path, { q: "own" })).status).toBe(200);
  }, 30_000);
  it("a non-answering search settles at the deadline and closes its owned TLS connection", async () => {
    const { r } = await world(); r.wire.state.holdGroupSearch = true;
    const started = Date.now(), result = await r.directory.searchPolicyGroups!("own");
    expect(result).toMatchObject({ ok: false, reason: "unknown" });
    expect(Date.now() - started).toBeLessThan(7500);
    await vi.waitFor(() => expect(r.wire.openSockets()).toBe(0));
  }, 10_000);
});
