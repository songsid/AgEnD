/** Exact owner-scoped grant selection; real HTTP/session/SQLite fences and an inert directory. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import type { DirectoryLookupResult } from "../src/hub/directory/types.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
const rigs: Rig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); vi.restoreAllMocks(); });
const held = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
async function world() {
  const r = await s3bRig(); rigs.push(r);
  const owner = r.addPerson("olivia"), recipient = r.addPerson("alex"), other = r.addPerson("other");
  const lookup = vi.fn(async (login: string): Promise<DirectoryLookupResult> => {
    const p = [...r.people.values()].find(p => p.login.toLowerCase() === login.toLowerCase());
    return p && p.eligible ? { ok: true, person: { key: p.key, login: p.login, dn: "private directory data", groups: [] } }
      : { ok: false, reason: p ? "not-eligible" : "not-found" };
  });
  r.directory.lookupForGrant = lookup;
  const browser = await r.signIn("olivia"), exposureId = randomUUID(), link = r.link(randomUUID(), owner);
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId: link.fleetId, owner,
    displayName: "Shared agent", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
  const input = { exposureId, exposureRevision: 1, login: "alex", days: 7 };
  const grant = (over: Partial<typeof input> = {}, b: typeof browser | null = browser, headers: Record<string, string> = {}) => r.call(b, "POST", "/hub/v1/grants", { ...input, ...over }, headers);
  const selected: DirectoryLookupResult = { ok: true, person: { key: recipient, login: "alex", dn: "private directory data", groups: [] } };
  return { r, owner, recipient, other, lookup, browser, exposureId, grant, selected };
}
describe("#3370 directory grant recipients", () => {
  it("selects the exact immutable person without creating a person, session, room or pairing", async () => {
    const w = await world(), response = await w.grant({ login: "  ALEX  " });
    expect(response.status).toBe(200); expect(w.lookup).toHaveBeenCalledExactlyOnceWith("ALEX");
    expect(response.json.grant).toMatchObject({ owner: w.owner, approvedBy: w.owner, exposureId: w.exposureId, exposureRevision: 1,
      subject: { kind: "person", person: w.recipient }, permissions: ["ask", "read-own-room"] });
    for (const [table, n] of [["hub_people", 1], ["hub_sessions", 1], ["hub_rooms", 0], ["hub_grants", 1]] as const)
      expect(w.r.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n });
    expect(w.r.store.read().pairings).toEqual([]);
    const view = await w.r.call(w.browser, "GET", "/hub/v1/exposures");
    expect(view.json.mine[0].grants[0]).toMatchObject({ subjectLogin: "alex", subjectName: "alex" });
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_people").get()).toEqual({ n: 1 });
  });
  it("serves the fresh refusal dictionary to a cached Hub shell", async () => {
    const w = await world(), response = await w.r.call(w.browser, "GET", "/ui/js/hub-grant-strings.js");
    expect(response.status).toBe(200); expect(response.text).toContain('register("hubGrant"');
    expect(response.text).toContain("recipientRefused");
  });
  it.each(["session", "owner", "withdrawn", "grant"] as const)("rechecks %s after a held recipient label projection", async change => {
    const w = await world(), first = await w.grant(); expect(first.status).toBe(200);
    const entered = held<void>(), gate = held<void>(), original = w.r.directory.checkEligibility.bind(w.r.directory);
    w.r.directory.checkEligibility = async key => {
      if (key.objectId === w.recipient.objectId) { entered.resolve(); await gate.promise; }
      return original(key);
    };
    const pending = w.r.call(w.browser, "GET", "/hub/v1/exposures"); await entered.promise;
    if (change === "session") await w.r.call(w.browser, "DELETE", "/hub/v1/session");
    else if (change === "grant") w.r.db.prepare("UPDATE hub_grants SET state='revoked', revision=revision+1 WHERE id=?").run(first.json.grant.id);
    else if (change === "owner") w.r.db.prepare("UPDATE hub_exposures SET owner=? WHERE id=?").run(`${w.other.realm}/${w.other.objectId}`, w.exposureId);
    else w.r.db.prepare("UPDATE hub_exposures SET state='withdrawn' WHERE id=?").run(w.exposureId);
    gate.resolve(); const response = await pending;
    expect(response.status).toBe(change === "session" ? 401 : 200);
    if (change === "grant") expect(response.json.mine[0].grants).toEqual([]);
    else if (change !== "session") expect(response.json.mine).toEqual([]);
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_people").get()).toEqual({ n: 1 });
  });
  it("refuses unsigned-in, CSRF, cross-origin, non-owner, unknown, stale and frozen exposure requests before selection", async () => {
    const w = await world(), stranger = await w.r.signIn("other");
    expect((await w.grant({}, null)).status).toBe(401);
    expect((await w.grant({}, w.browser, { "X-AgEnD-Hub-CSRF": "" })).status).toBe(403);
    expect((await w.grant({}, w.browser, { Origin: "https://elsewhere.example.test" })).status).toBe(403);
    expect((await w.grant({}, stranger)).status).toBe(404);
    expect((await w.grant({ exposureId: randomUUID() })).status).toBe(404);
    expect((await w.grant({ exposureRevision: 2 })).status).toBe(409);
    expect((await w.r.call(w.browser, "POST", `/hub/v1/exposures/${w.exposureId}/freeze`, { revision: 1 })).status).toBe(200);
    expect((await w.grant()).status).toBe(403);
    expect(w.lookup).not.toHaveBeenCalled(); expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
  });
  it.each(["not-found", "not-eligible", "bad-input", "unavailable"] as const)("refuses bounded directory result %s", async reason => {
    const w = await world(); w.lookup.mockResolvedValueOnce({ ok: false, reason });
    const response = await w.grant(); expect(response.status).toBe(reason === "unavailable" ? 503 : 404);
    expect(response.text).not.toContain("private"); expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
  });
  it.each(["login", "realm", "current-key"] as const)("refuses a mismatched %s without retargeting", async changed => {
    const w = await world();
    if (changed === "current-key") {
      const original = w.r.directory.checkEligibility.bind(w.r.directory);
      w.r.directory.checkEligibility = async key => key.objectId === w.recipient.objectId
        ? { eligible: true, person: { key: w.other, login: "alex", dn: "private", groups: [] } } : original(key);
    } else w.lookup.mockResolvedValueOnce({ ok: true, person: { key: { ...w.recipient, ...(changed === "realm" ? { realm: "elsewhere" } : {}) },
      login: changed === "login" ? "other" : "alex", dn: "private", groups: [] } });
    expect((await w.grant()).status).toBe(changed === "current-key" ? 404 : 503);
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
  });
  it.each(["disabled", "renamed", "recreated"] as const)("freshly rechecks a selected immutable identity (%s)", async change => {
    const w = await world();
    w.lookup.mockImplementationOnce(async () => {
      if (change === "disabled") w.r.setEligible("alex", false);
      else { w.r.rename("alex", "former-alex"); if (change === "recreated") w.r.addPerson("alex"); }
      return w.selected;
    });
    expect((await w.grant()).status).toBe(404); expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
  });
  it("a reused login selects the fresh key, never the cached former person", async () => {
    const w = await world(); await w.r.signIn("alex"); w.r.rename("alex", "former-alex"); const replacement = w.r.addPerson("alex");
    const response = await w.grant(); expect(response.status).toBe(200);
    expect(response.json.grant.subject.person).toEqual(replacement); expect(replacement).not.toEqual(w.recipient);
  });
  const transitions = ["session", "owner", "revision", "withdrawn", "frozen", "server"] as const;
  const outcomes = ["eligible", "unknown", "ineligible", "self", "unavailable"] as const;
  it.each(outcomes.flatMap(outcome => transitions.map(change => [outcome, change] as const)))("fences held %s selection after %s changes", async (outcome, change) => {
    const w = await world(), entered = held<void>(), gate = held<DirectoryLookupResult>();
    w.lookup.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const pending = w.grant({ login: outcome === "self" ? "olivia" : "alex" }); await entered.promise;
    if (change === "session") await w.r.call(w.browser, "DELETE", "/hub/v1/session");
    else if (change === "server") w.r.disable();
    else {
      const [column, value] = change === "owner" ? ["owner", `${w.other.realm}/${w.other.objectId}`]
        : change === "revision" ? ["revision", 2] : change === "frozen" ? ["frozen_through", 1] : ["state", "withdrawn"];
      w.r.db.prepare(`UPDATE hub_exposures SET ${column}=? WHERE id=?`).run(value, w.exposureId);
    }
    gate.resolve(outcome === "eligible" ? w.selected : outcome === "self"
      ? { ok: true, person: { key: w.owner, login: "olivia", dn: "private", groups: [] } }
      : { ok: false, reason: outcome === "unknown" ? "not-found" : outcome === "ineligible" ? "not-eligible" : "unavailable" });
    const response = await pending;
    expect(response.status).toBe(change === "session" ? 401 : change === "owner" ? 404 : change === "revision" ? 409 : change === "server" ? 503 : 403);
    expect(response.text).not.toContain("private"); expect(w.lookup).toHaveBeenCalledTimes(1);
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_people").get()).toEqual({ n: 1 });
  });
  it("shares the selection concurrency bound and releases slots after refusal", async () => {
    const w = await world(), entered = held<void>(), gates = Array.from({ length: 4 }, () => held<DirectoryLookupResult>()); let count = 0;
    w.lookup.mockImplementation(() => { const gate = gates[count++]; if (count === 4) entered.resolve(); return gate!.promise; });
    const pending = Array.from({ length: 4 }, () => w.grant()); await entered.promise;
    try {
      expect((await w.grant()).status).toBe(429);
      const admin = await w.r.signIn("admin"); w.r.directory.lookupForPairing = w.lookup;
      expect((await w.r.call(admin, "POST", "/hub/v1/admin/pairings", { login: "alex" })).status).toBe(429);
      expect(w.lookup).toHaveBeenCalledTimes(4);
    }
    finally { gates.forEach(g => g.resolve({ ok: false, reason: "not-found" })); await Promise.all(pending); }
    w.lookup.mockResolvedValueOnce(w.selected); expect((await w.grant()).status).toBe(200);
  });
  it("a pairing-only injected driver retains the legacy known-person grant path", async () => {
    const w = await world(); delete w.r.directory.lookupForGrant; const pairing = w.r.directory.lookupForPairing = vi.fn(async () => w.selected);
    expect((await w.grant()).status).toBe(404); await w.r.signIn("alex"); expect((await w.grant()).status).toBe(200);
    expect(pairing).not.toHaveBeenCalled(); expect(w.lookup).not.toHaveBeenCalled();
  });
  it("an audit failure rolls back both the new grant and replacement of an earlier grant", async () => {
    const w = await world(), first = await w.grant(); expect(first.status).toBe(200); w.r.setAuditFails(true, "grant.created");
    expect((await w.grant()).status).toBe(500);
    expect(w.r.db.prepare("SELECT id, state, revision FROM hub_grants").all()).toEqual([{ id: first.json.grant.id, state: "active", revision: 1 }]);
  });
  it("a thrown directory error is refused without echoing private details", async () => {
    const w = await world(); w.lookup.mockRejectedValueOnce(Error("private service DN and password"));
    const response = await w.grant(); expect(response.status).toBe(503); expect(response.json).toEqual({ code: "unavailable" });
    expect(w.r.db.prepare("SELECT COUNT(*) n FROM hub_grants").get()).toEqual({ n: 0 });
  });
});
