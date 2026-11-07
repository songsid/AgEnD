/** Inert driver interleavings; real TLS/BER listener coverage is in hub-group-directory-wire. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ searches: [] as any[], binds: [] as any[], tls: [] as any[], responses: [] as any[], afterSearch: undefined as (() => void) | undefined, onBind: undefined as (() => void) | undefined }));
vi.mock("node:tls", async original => ({ ...await original<typeof import("node:tls")>(), connect: (options: any) => { f.tls.push(options); return { authorized: true, encrypted: true, destroyed: false }; } }));
vi.mock("ldapts", async original => ({ ...await original<typeof import("ldapts")>(), Client: class {
  isConnected = false;
  constructor(private options: any) {}
  async bind(dn: string, password: string) { if (!this.isConnected) { this.options.createSecureConnection(); this.isConnected = true; } f.binds.push({ dn, password }); f.onBind?.(); }
  async search(base: string, options: any, controls: any) { f.searches.push({ base, ...options, controls }); f.afterSearch?.(); const value = f.responses.shift(); if (value instanceof Error) throw value; return Array.isArray(value) ? { searchEntries: value, searchReferences: [] } : value ?? { searchEntries: [], searchReferences: [] }; }
  async unbind() { this.isConnected = false; }
} }));
import { BerWriter } from "ldapts";
import { createHubDirectory } from "../src/hub/directory/directory.js";
import { guidStringToBytes } from "../src/hub/directory/profiles.js";
import { AD_EXTENDED_DN } from "../src/hub/directory/groups.js";
const config = { realm: "example", url: "ldaps://directory.example.test:636", baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test", profile: "ad" };
const user = { realm: "example", objectId: "11111111-1111-4111-8111-111111111111" }, a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const dn = "CN=Owners,DC=example,DC=test";
const group = (id = a) => ({ dn, objectGUID: guidStringToBytes(id), groupType: "-2147483646" });
const entry = (memberOf: unknown = `<GUID=${a}>;${dn}`) => ({ dn: "CN=User,DC=example,DC=test", objectGUID: guidStringToBytes(user.objectId), userAccountControl: "512", sAMAccountName: "user", memberOf });
const directory = (over = {}) => createHubDirectory({ ...config, ...over }, { bindPassword: "Dummy-service-password" }, { now: () => 100 });
beforeEach(() => { f.searches.length = f.binds.length = f.tls.length = f.responses.length = 0; f.afterSearch = f.onBind = undefined; });

describe("AD-only group permission reader", () => {
  it("requires an AD realm on the DC LDAPS port, before opening a connection", async () => {
    for (const over of [{ profile: "openldap" }, { url: "ldaps://directory.example.test:3269" }, { url: "ldaps://directory.example.test:1636" }]) {
      const d = directory(over); expect(d.groupPolicy).toBeUndefined();
      expect(await d.resolvePolicyGroup!(dn)).toEqual({ ok: false, reason: "unsupported" });
      expect(await d.readPolicyGroups!(user)).toEqual({ kind: "unknown" });
    }
    expect(f.tls).toEqual([]);
  });
  it("resolves exactly one security group and rechecks it by raw immutable GUID", async () => {
    f.responses.push([group()], [group()]); const d = directory();
    expect(await d.resolvePolicyGroup!(dn)).toEqual({ ok: true, group: { key: { realm: "example", objectId: a }, dn } });
    expect(f.searches[0]).toMatchObject({ base: dn, scope: "base", sizeLimit: 2, filter: "(objectClass=group)", derefAliases: "never" });
    expect(f.searches[1].filter.filters[1]).toMatchObject({ attribute: "objectGUID", value: guidStringToBytes(a) });
    expect(f.binds).toEqual([{ dn: config.bindDn, password: "Dummy-service-password" }]);
  });
  it.each([
    ["distribution group", [{ ...group(), groupType: "2" }], [], "not-security-group"],
    ["no GUID", [{ ...group(), objectGUID: undefined }], [], "not-security-group"],
    ["not found", [], [], "not-found"], ["ambiguous", [group(), group()], [], "unknown"],
    ["recreated while resolving", [group()], [group(b)], "unknown"],
    ["moved during selection", [group()], [{ ...group(), dn: "CN=Elsewhere,DC=example,DC=test" }], "unknown"],
  ])("refuses %s", async (_label, first, second, reason) => {
    f.responses.push(first, second); expect(await directory().resolvePolicyGroup!(dn)).toEqual({ ok: false, reason });
  });
  it("cannot search a DN outside the configured base or accept a referral as complete", async () => {
    expect(await directory().resolvePolicyGroup!("CN=Other,DC=elsewhere,DC=test")).toEqual({ ok: false, reason: "invalid" }); expect(f.searches).toEqual([]);
    f.responses.push({ searchEntries: [group()], searchReferences: ["ldaps://elsewhere.invalid"] });
    expect(await directory().resolvePolicyGroup!(dn)).toEqual({ ok: false, reason: "unknown" });
  });
  it("requests critical extended-DN Flags1 and matches GUIDs from the SAME membership response", async () => {
    f.responses.push([entry()]);
    expect(await directory().readPolicyGroups!(user)).toEqual({ kind: "complete", person: user, groups: [a], observedAt: 100 });
    expect(f.searches).toHaveLength(1); const control = f.searches[0].controls[0];
    expect(control).toMatchObject({ type: AD_EXTENDED_DN, critical: true });
    const w = new BerWriter(); control.write(w); expect(w.buffer.includes(Buffer.from([0x04, 0x05, 0x30, 0x03, 0x02, 0x01, 0x01]))).toBe(true);
    expect(f.tls[0]).toMatchObject({ rejectUnauthorized: true, minVersion: "TLSv1.2", servername: "directory.example.test", port: 636 });
  });
  it.each([
    ["unsupported control", new Error("unavailable critical extension")],
    ["plain DN", [entry(dn)]], ["missing memberOf", [entry(undefined)]],
    ["ranged partial", [{ ...entry(), "memberOf;range=0-1499": [`<GUID=${a}>;${dn}`] }]],
    ["referral", { searchEntries: [entry()], searchReferences: ["ldaps://elsewhere.invalid"] }],
    ["ambiguous person", [entry(), entry()]], ["wrong identity", [{ ...entry(), objectGUID: guidStringToBytes(b) }]],
  ])("unknown is not negative proof: %s", async (_label, response) => {
    // entry(undefined) uses a default argument, so remove the attribute deliberately for this case.
    if (_label === "missing memberOf") response = [{ ...entry(), memberOf: undefined }];
    f.responses.push(response); expect(await directory().readPolicyGroups!(user)).toEqual({ kind: "unknown" });
  });
  it("distinguishes complete other-group facts, missing identity and a disabled user", async () => {
    f.responses.push([entry(`<GUID=${b}>;CN=Other,DC=example,DC=test`)], [], [{ ...entry(), userAccountControl: "514" }]); const d = directory();
    expect(await d.readPolicyGroups!(user)).toEqual({ kind: "complete", person: user, groups: [b], observedAt: 100 });
    expect(await d.readPolicyGroups!(user)).toMatchObject({ kind: "ineligible", reason: "gone" });
    expect(await d.readPolicyGroups!(user)).toMatchObject({ kind: "ineligible", reason: "disabled" });
  });
  it("snapshots the subject and withholds work that finishes after close", async () => {
    const d = directory(), mutable = { ...user }; f.responses.push([entry()]); f.onBind = () => { mutable.objectId = b; };
    expect(await d.readPolicyGroups!(mutable)).toMatchObject({ kind: "complete", person: user });
    expect(f.searches[0].filter.filters[1]).toMatchObject({ value: guidStringToBytes(user.objectId) });
    f.responses.push([entry()]); f.afterSearch = () => { void d.close(); };
    expect(await d.readPolicyGroups!(user)).toEqual({ kind: "unknown" });
  });
  it("unsupported permission facts cannot block ordinary eligible directory sign-in", async () => {
    const plain = entry(dn); f.responses.push([plain], [plain]); const d = directory();
    expect(await d.signIn("user", "Dummy-personal-password")).toMatchObject({ ok: true, person: { key: user } });
    expect(f.searches.every(s => s.controls === undefined)).toBe(true); expect(f.binds.filter(b => b.password === "Dummy-personal-password")).toHaveLength(1);
    f.responses.push(new Error("unsupported extension")); expect(await d.readPolicyGroups!(user)).toEqual({ kind: "unknown" });
  });
  it("permission diagnostics do not repeat directory text, DNs or credentials", async () => {
    const events: unknown[] = [], d = createHubDirectory(config, { bindPassword: "Dummy-service-password" }, { onDiagnostic: e => events.push(e) });
    f.responses.push(new Error(`service-password ${dn}`)); expect(await d.readPolicyGroups!(user)).toEqual({ kind: "unknown" });
    expect(events).toEqual([{ op: "group-membership", outcome: "unknown" }]);
  });
});
