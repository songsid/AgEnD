/** The local-init, authenticated pairing and owner-authorized grant lookup driver: inert LDAP/TLS seams, no listener or directory/account access. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ searches: [] as any[], binds: [] as any[], tls: [] as any[], responses: [] as any[], close: 0, afterSearch: undefined as (() => void) | undefined }));
vi.mock("node:tls", async original => ({ ...await original<typeof import("node:tls")>(),
  connect: (options: any) => { f.tls.push(options); return { authorized: true, encrypted: true, destroyed: false }; },
}));
vi.mock("ldapts", () => ({
  Client: class {
    isConnected = false;
    constructor(private options: any) {}
    async bind(dn: string, password: string) { if (!this.isConnected) { this.options.createSecureConnection(); this.isConnected = true; } f.binds.push({ dn, password }); }
    async search(base: string, options: any) { f.searches.push({ base, ...options }); f.afterSearch?.(); const value = f.responses.shift(); if (value instanceof Error) throw value; return { searchEntries: value ?? [] }; }
    async unbind() { f.close++; this.isConnected = false; }
  },
  AndFilter: class { constructor(readonly options: any) {} }, EqualityFilter: class { constructor(readonly options: any) {} },
  FilterParser: { parseString: (value: string) => value },
}));
import { createHubDirectory } from "../src/hub/directory/index.js";
const config = { realm: "demo", url: "ldaps://directory.example.test", baseDn: "dc=example,dc=test", bindDn: "cn=reader,dc=example,dc=test", profile: "openldap" };
const id = "1463aac8-6aba-45fa-a172-f4a06ffa16ec", password = "Dummy-service-only";
const entry = { dn: "uid=alice,dc=example,dc=test", entryUUID: id, uid: "alice", displayName: "Alice Example" };
const dir = () => createHubDirectory(config, { bindPassword: password });
beforeEach(() => { f.searches.length = f.binds.length = f.tls.length = f.responses.length = 0; f.close = 0; f.afterSearch = undefined; });

describe.each(["lookupForInitialization", "lookupForPairing", "lookupForGrant"] as const)("%s service-account directory lookup", method => {
  it("looks up and rechecks one identity with only a service bind and strict TLS", async () => {
    f.responses.push([entry], [entry]);
    expect(await dir()[method]!("alice")).toMatchObject({ ok: true, person: { key: { realm: "demo", objectId: id }, login: "alice" } });
    expect(f.binds).toEqual([{ dn: config.bindDn, password }]);
    expect(f.tls).toHaveLength(1); expect(f.tls[0]).toMatchObject({ rejectUnauthorized: true, minVersion: "TLSv1.2", servername: "directory.example.test" });
    expect(f.searches[0]).toMatchObject({ base: config.baseDn, filter: "(&(objectClass=person)(uid=alice))", sizeLimit: 2, derefAliases: "never" });
    expect(f.searches[1].filter.options.filters[1].options).toEqual({ attribute: "entryUUID", value: id });
    expect(f.close).toBe(1);
  });
  it("rejects malformed input and a closed driver before opening TLS", async () => {
    const d = dir();
    for (const login of ["", " alice", "a\nb", "x".repeat(257)]) expect(await d[method]!(login)).toEqual({ ok: false, reason: "bad-input" });
    await d.close(); expect(await d[method]!("alice")).toEqual({ ok: false, reason: "unavailable" });
    expect(f.tls).toEqual([]);
  });
  it("escapes the login instead of admitting a filter expression", async () => {
    expect(await dir()[method]!("*)(uid=*)")).toEqual({ ok: false, reason: "not-found" });
    expect(f.searches[0].filter).toBe("(&(objectClass=person)(uid=\\2a\\29\\28uid=\\2a\\29))");
  });
  it.each([
    ["unknown", [], undefined, "not-found"],
    ["ambiguous", [entry, entry], [entry], "unavailable"],
    ["missing immutable id", [{ ...entry, entryUUID: undefined }], undefined, "unavailable"],
    ["disabled initially", [{ ...entry, pwdAccountLockedTime: "000001010000Z" }], undefined, "not-eligible"],
    ["gone on recheck", [entry], [], "unavailable"],
    ["ambiguous recheck", [entry], [entry, entry], "unavailable"],
    ["replacement id", [entry], [{ ...entry, entryUUID: "2463aac8-6aba-45fa-a172-f4a06ffa16ec" }], "unavailable"],
    ["changed DN", [entry], [{ ...entry, dn: "uid=other,dc=example,dc=test" }], "unavailable"],
    ["renamed login", [entry], [{ ...entry, uid: "other" }], "unavailable"],
    ["disabled on recheck", [entry], [{ ...entry, pwdAccountLockedTime: "000001010000Z" }], "not-eligible"],
    ["directory unavailable", new Error("fake disconnect"), undefined, "unavailable"],
  ])("refuses %s and closes its service connection", async (_label, first, second, reason) => {
    f.responses.push(first); if (second) f.responses.push(second);
    expect(await dir()[method]!("alice")).toEqual({ ok: false, reason }); expect(f.close).toBe(1);
  });
  it("withholds a lookup that completes after close", async () => {
    const d = dir(); f.responses.push([entry]); f.afterSearch = () => { void d.close(); };
    expect(await d[method]!("alice")).toEqual({ ok: false, reason: "unavailable" });
  });
  it("keeps exception-supplied login and DN text out of lookup diagnostics", async () => {
    const events: any[] = [];
    f.responses.push(new Error("untrusted LDAP reply: alice uid=alice,dc=example,dc=test"));
    const d = createHubDirectory(config,{bindPassword:password},{onDiagnostic:e=>events.push(e)});
    expect(await d[method]!("alice")).toEqual({ok:false,reason:"unavailable"});
    expect(events).toEqual([{op:method === "lookupForPairing" ? "pairing-owner-lookup" : method === "lookupForGrant" ? "grant-recipient-lookup" : "initialization-lookup",outcome:"unavailable",error:"directory lookup failed"}]);
  });
});
