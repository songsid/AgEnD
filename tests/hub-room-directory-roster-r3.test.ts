/** Exact production directory adapter with inert TLS/LDAP transport, no real account or server. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ sockets: [] as any[], searches: [] as any[], group: {} as any, people: [] as any[], references: [] as string[], change: false, error: false }));
vi.mock("node:tls", async original => {
  const { EventEmitter } = await import("node:events");
  return { ...await original<typeof import("node:tls")>(), connect: () => {
    const socket = Object.assign(new EventEmitter(), { authorized: true, encrypted: true, destroyed: false, closed: false,
      destroy() { this.destroyed = true; this.closed = true; queueMicrotask(() => (this as any).emit("close")); return this; } }); f.sockets.push(socket); return socket;
  } };
});
vi.mock("ldapts", async original => ({ ...await original<typeof import("ldapts")>(), Client: class {
  isConnected = false; socket: any; calls = 0;
  constructor(private options: any) {}
  async bind() { this.socket = this.options.createSecureConnection(); this.isConnected = true; }
  async search() { this.calls++; return { searchEntries: [{ ...f.group, ...(this.calls > 1 && f.change ? { objectGUID: Buffer.alloc(16) } : {}) }], searchReferences: [] }; }
  async *searchPaginated(base: string, options: unknown) { f.searches.push({ base, ...options as object }); if (f.error) throw new Error("size limit exceeded");
    yield { searchEntries: f.people.slice(0, 1), searchReferences: f.references }; if (f.people.length > 1) yield { searchEntries: f.people.slice(1), searchReferences: [] };
  }
  async unbind() { this.isConnected = false; if (this.socket && !this.socket.closed) await new Promise<void>(resolve => { this.socket.once("close", resolve); this.socket.destroy(); }); }
} }));
import { createHubDirectory } from "../src/hub/directory/directory.js";
import { guidStringToBytes } from "../src/hub/directory/profiles.js";
const groupId = "11111111-2222-4333-8444-555555555555", personId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
let d: ReturnType<typeof createHubDirectory> | undefined;
const make = () => d = createHubDirectory({ realm: "corp", url: "ldaps://directory.example.test:636", baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test", profile: "ad" }, { bindPassword: "owned-fixture" });
const entry = (id = personId, disabled = false) => ({ dn: "CN=Person,DC=example,DC=test", objectGUID: guidStringToBytes(id), sAMAccountName: "person", displayName: "Person", userAccountControl: disabled ? "514" : "512", accountExpires: "0" });
beforeEach(() => { f.sockets = []; f.searches = []; f.references = []; f.change = false; f.error = false;
  f.group = { dn: "CN=Project (one),DC=example,DC=test", objectGUID: guidStringToBytes(groupId), groupType: "-2147483646", cn: "Project" }; f.people = [entry()]; });
afterEach(async () => { await d?.close(); d = undefined; });
it("reads every complete direct page under a5s bound and excludes disabled people", async () => {
  f.people = [entry(), entry("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", true)]; const out = await make().roomGroupMembers!({ realm: "corp", objectId: groupId });
  expect(out).toMatchObject({ ok: true, group: { key: { realm: "corp", objectId: groupId }, name: "Project" }, people: [{ key: { realm: "corp", objectId: personId }, displayName: "Person" }] });
  if (!out.ok) throw new Error("roster missing"); expect(out.people).toHaveLength(1);
  expect(f.searches).toHaveLength(1); expect(f.searches[0]).toMatchObject({ sizeLimit: 0, timeLimit: 5, paged: { pageSize: 100 }, derefAliases: "never" });
  expect(f.searches[0].filter).toContain("(memberOf=CN=Project \\28one\\29,DC=example,DC=test)");
  expect(f.searches[0].filter).not.toContain("1.2.840.113556.1.4.1941"); expect(f.sockets.every(s => s.closed)).toBe(true);
});
it.each(["referral", "size-limit", "changed-group", "duplicate", "outside-base"])("refuses %s without returning a partial roster", async mode => {
  if (mode === "referral") f.references = ["ldap://other.example.test"];
  if (mode === "size-limit") f.error = true;
  if (mode === "changed-group") f.change = true;
  if (mode === "duplicate") f.people = [entry(), entry()];
  if (mode === "outside-base") f.people = [{ ...entry(), dn: "CN=Person,DC=outside,DC=test" }];
  expect(await make().roomGroupMembers!({ realm: "corp", objectId: groupId })).toEqual({ ok: false, reason: "unknown" });
  expect(f.sockets.every(s => s.closed)).toBe(true);
});
