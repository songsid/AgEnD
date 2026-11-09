/** Admin-only pairing owner resolution, over the real HTTP handler and SQLite with an inert directory. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import type { DirectoryLookupResult } from "../src/hub/directory/types.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
let rig: Rig | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; vi.restoreAllMocks(); });
async function world() {
  const r = rig = await s3bRig(), owner = r.addPerson("olivia", "Olivia Example"), other = r.addPerson("other", "Other Example");
  const lookup = vi.fn(async (login: string): Promise<DirectoryLookupResult> => {
    const person = [...r.people.values()].find(p => p.login.toLowerCase() === login.toLowerCase());
    return person ? { ok: true, person: { key: person.key, login: person.login, dn: "private", displayName: person.name, groups: [] } } : { ok: false, reason: "not-found" };
  });
  r.directory.lookupForPairing = lookup;
  const admin = await r.signIn("admin"); expect(admin.status).toBe(200);
  const code = (login = "olivia", browser = admin) => r.call(browser, "POST", "/hub/v1/admin/pairings", { login });
  return { r, owner, other, lookup, admin, code };
}
function held<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe("pairing for owners who have never signed in", () => {
  it("resolves a new owner without creating a Hub person, session or grant, preserving owner confirmation", async () => {
    const w = await world(), response = await w.code("  OLIVIA  ");
    expect(response.status).toBe(200); expect(w.lookup).toHaveBeenCalledWith("OLIVIA");
    expect(w.r.store.read().pairings[0]).toMatchObject({ owner: w.owner, ownerConfirmed: false, adminApproved: false });
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_people").get()).toEqual({ n: 1 });
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_sessions").get()).toEqual({ n: 1 });
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
  });
  it("refuses ordinary users, signed-out callers, cross-origin writes and missing CSRF before the lookup", async () => {
    const w = await world(), person = await w.r.signIn("other");
    expect((await w.code("olivia", person)).status).toBe(403);
    expect((await w.r.call(null, "POST", "/hub/v1/admin/pairings", { login: "olivia" })).status).toBe(401);
    expect((await w.r.call(w.admin, "POST", "/hub/v1/admin/pairings", { login: "olivia" }, { Origin: "https://elsewhere.example.test" })).status).toBe(403);
    expect((await w.r.call(w.admin, "POST", "/hub/v1/admin/pairings", { login: "olivia" }, { "X-AgEnD-Hub-CSRF": "" })).status).toBe(403);
    expect(w.lookup).not.toHaveBeenCalled(); expect(w.r.store.read().pairings).toEqual([]);
  });
  it.each(["not-found", "not-eligible", "unavailable"] as const)("refuses a directory %s without publishing an offer", async reason => {
    const w = await world(); w.lookup.mockResolvedValueOnce({ ok: false, reason });
    const response = await w.code(); expect(response.status).toBe(reason === "unavailable" ? 503 : 404);
    expect(JSON.stringify(response.json)).not.toContain("private"); expect(w.r.store.read().pairings).toEqual([]);
  });
  it("refuses a thrown lookup without echoing its exception", async () => {
    const w = await world(); w.lookup.mockRejectedValueOnce(Error("Private directory details"));
    const response = await w.code(); expect(response.status).toBe(503); expect(response.json).toEqual({ code: "unavailable" });
    expect(w.r.store.read().pairings).toEqual([]);
  });
  it.each(["login", "realm"] as const)("refuses a mismatched returned %s", async changed => {
    const w = await world();
    w.lookup.mockResolvedValueOnce({ ok: true, person: { key: { ...w.owner, ...(changed === "realm" ? { realm: "elsewhere" } : {}) }, login: changed === "login" ? "other" : "olivia", dn: "private", groups: [] } });
    expect((await w.code()).status).toBe(503); expect(w.r.store.read().pairings).toEqual([]);
  });
  it.each(["disabled", "renamed"] as const)("rechecks the immutable identity after lookup (%s)", async changed => {
    const w = await world();
    const result: DirectoryLookupResult = { ok: true, person: { key: w.owner, login: "olivia", dn: "private", groups: [] } };
    w.lookup.mockImplementationOnce(async () => {
      if (changed === "disabled") w.r.setEligible("olivia", false); else w.r.rename("olivia", "renamed");
      return result;
    });
    expect((await w.code()).status).toBe(404); expect(w.r.store.read().pairings).toEqual([]);
  });
  it("a reused login targets the fresh directory key and never the old cached person", async () => {
    const w = await world(); await w.r.signIn("olivia"); w.r.rename("olivia", "renamed");
    const replacement = w.r.addPerson("olivia", "New Olivia"); expect(replacement).not.toEqual(w.owner);
    expect((await w.code()).status).toBe(200);
    expect(w.r.store.read().pairings[0]!.owner).toEqual(replacement);
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
  });
  it("an admin who signs out during lookup cannot publish the result", async () => {
    const w = await world(), gate = held<DirectoryLookupResult>(), entered = held<void>();
    w.lookup.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const pending = w.code(); await entered.promise;
    expect((await w.r.call(w.admin, "DELETE", "/hub/v1/session")).status).toBe(200);
    gate.resolve({ ok: true, person: { key: w.owner, login: "olivia", dn: "private", groups: [] } });
    expect((await pending).status).toBe(401); expect(w.r.store.read().pairings).toEqual([]);
  });
  it("legacy drivers without lookup retain the exact existing known-person path", async () => {
    const w = await world(); delete w.r.directory.lookupForPairing;
    expect((await w.code()).status).toBe(404); await w.r.signIn("olivia");
    expect((await w.code()).status).toBe(200); expect(w.r.store.read().pairings[0]!.owner).toEqual(w.owner);
  });
  it("bounds concurrent owner lookups and releases every slot after refusal", async () => {
    const w = await world(), entered = held<void>(), gates = Array.from({ length: 4 }, () => held<DirectoryLookupResult>()); let count = 0;
    w.lookup.mockImplementation(() => { const gate = gates[count++]; if (count === 4) entered.resolve(); return gate?.promise ?? Promise.resolve({ ok: false, reason: "not-found" }); });
    const pending = Array.from({ length: 4 }, () => w.code()); await entered.promise;
    try { expect((await w.code()).status).toBe(429); expect(w.lookup).toHaveBeenCalledTimes(4); }
    finally { gates.forEach(g => g.resolve({ ok: false, reason: "not-found" })); await Promise.all(pending); }
    expect((await w.code()).status).toBe(404); expect(w.r.store.read().pairings).toEqual([]);
  });
  it("does not widen the existing grant-by-known-person path", async () => {
    const w = await world(), owner = await w.r.signIn("olivia"), link = w.r.link(randomUUID(), w.owner), exposureId = randomUUID();
    await w.r.http.receive(w.r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId: link.fleetId, owner: w.owner,
      displayName: "Example", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
    const response = await w.r.call(owner, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "other", days: 7 });
    expect(response.status).toBe(404); expect(w.lookup).not.toHaveBeenCalled();
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
  });

});
