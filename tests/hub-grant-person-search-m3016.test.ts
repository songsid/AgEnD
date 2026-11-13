/** Production search/filter/physical-close path with inert TLS and LDAP peers; no account or network. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ sockets: [] as any[], searches: [] as any[], entries: [] as any[], holdUnbind: false, unbind: 0,
  release: undefined as (() => void) | undefined, holdSearch: false }));
vi.mock("node:tls", async original => {
  const { EventEmitter } = await import("node:events");
  return { ...await original<typeof import("node:tls")>(), connect: () => {
    const socket = Object.assign(new EventEmitter(), { authorized: true, encrypted: true, destroyed: false, closed: false,
      destroy() { this.destroyed = true; if (!f.holdUnbind) { this.closed = true; queueMicrotask(() => (this as any).emit("close")); } return this; } });
    f.sockets.push(socket); return socket;
  } };
});
vi.mock("ldapts", async original => ({ ...await original<typeof import("ldapts")>(), Client: class {
  isConnected = false;
  socket: any;
  constructor(private options: any) {}
  async bind() { this.socket = this.options.createSecureConnection(); this.isConnected = true; }
  async search(base: string, options: unknown) { f.searches.push({ base, ...options as object }); if (f.holdSearch) await new Promise((_, reject) => this.socket.once("close", () => reject(new Error("owned socket closed")))); return { searchEntries: f.entries, searchReferences: ["ldap://ignored.invalid"] }; }
  async unbind() { f.unbind++; if (f.holdUnbind) await new Promise<void>(r => { f.release = r; }); this.isConnected = false; }
} }));
import { createHubDirectory } from "../src/hub/directory/directory.js";
import { guidStringToBytes } from "../src/hub/directory/profiles.js";
const id = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
const entry = () => ({ dn: "CN=Alex,DC=example,DC=test", objectGUID: guidStringToBytes(id), sAMAccountName: "alex", displayName: "Alex Chen", userAccountControl: "512", accountExpires: "0" });
let directory: ReturnType<typeof createHubDirectory> | undefined;
beforeEach(() => { f.sockets = []; f.searches = []; f.entries = []; f.holdUnbind = false; f.unbind = 0; f.release = undefined; f.holdSearch = false; });
afterEach(async () => { f.holdUnbind = false; f.release?.(); for (const socket of f.sockets) { socket.closed = true; socket.emit("close"); } await directory?.close(); directory = undefined; vi.useRealTimers(); });
const make = () => directory = createHubDirectory({ realm: "corp", url: "ldaps://directory.example.test:636", baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test", profile: "ad" }, { bindPassword: "owned-fixture" });
describe("bounded directory person feedback", () => {
  it("uses a literal prefix on names/login, with20/5s bounds and a narrow immutable-key projection", async () => {
    f.entries = [entry()]; const d = make(), out = await d.searchGrantPeople!("*)(cn=*");
    expect(out).toEqual({ ok: true, people: [{ person: { realm: "corp", objectId: id }, login: "alex", displayName: "Alex Chen" }], truncated: false });
    expect(f.searches).toHaveLength(1); expect(f.searches[0]).toMatchObject({ base: "DC=example,DC=test", sizeLimit: 20, timeLimit: 5, derefAliases: "never", scope: "sub" });
    expect(f.searches[0].filter).toBe("(&(&(objectClass=person)(!(objectClass=computer)))(|(displayName=\\2a\\29\\28cn=\\2a*)(cn=\\2a\\29\\28cn=\\2a*)(sAMAccountName=\\2a\\29\\28cn=\\2a*)))");
    expect(JSON.stringify(out)).not.toMatch(/dn|password|memberOf/i); expect(f.sockets.every(s => s.closed)).toBe(true);
  });
  it.each(["short", "control", "too-long"])("rejects %s before opening a connection", async kind => {
    const d = make(), q = kind === "short" ? "a" : kind === "control" ? "a\u0000b" : "a".repeat(65);
    expect(await d.searchGrantPeople!(q)).toEqual({ ok: false, reason: "unknown" }); expect(f.sockets).toHaveLength(0);
  });
  it("refuses duplicate/outside-base/oversized replies and excludes disabled accounts", async () => {
    const d = make(); f.entries = [{ ...entry(), userAccountControl: "514" }];
    expect(await d.searchGrantPeople!("Al")).toEqual({ ok: true, people: [], truncated: false });
    for (const entries of [[entry(), entry()], [{ ...entry(), dn: "CN=Alex,DC=outside,DC=test" }], Array.from({ length: 21 }, entry)]) {
      f.entries = entries; expect(await d.searchGrantPeople!("Al")).toEqual({ ok: false, reason: "unknown" });
    }
  });
  it("holds the returned promise through unbind AND the physical socket close", async () => {
    const d = make(); f.holdUnbind = true; let settled = false;
    const running = d.searchGrantPeople!("Al").finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(f.unbind).toBe(1)); expect(settled).toBe(false);
      f.release!(); await new Promise<void>(r => setImmediate(r)); expect(f.sockets[0].destroyed).toBe(true); expect(settled).toBe(false);
      f.sockets[0].closed = true; f.sockets[0].emit("close"); expect(await running).toEqual({ ok: true, people: [], truncated: false });
    } finally { f.release?.(); for (const socket of f.sockets) { socket.closed = true; socket.emit("close"); } await running; }
  });
  it("the5s deadline aborts a held search and settles only after its owned close", async () => {
    vi.useFakeTimers(); const d = make(); f.holdSearch = true;
    const started = Date.now(), running = d.searchGrantPeople!("Al");
    try {
      await vi.waitFor(() => expect(f.searches).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(Math.max(0, 5000 - (Date.now() - started)));
      expect(f.sockets[0].destroyed).toBe(true); expect(f.sockets[0].closed).toBe(true);
      expect(await running).toEqual({ ok: false, reason: "unknown" }); expect(f.searches).toHaveLength(1);
    } finally { for (const s of f.sockets) { s.closed = true; s.emit("close"); } await running; }
  });
});
