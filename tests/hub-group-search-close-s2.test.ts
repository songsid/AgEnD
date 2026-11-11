/** Driver promise includes unbind and the owned TLS close event; no network/credentials. */
import { expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ socket: undefined as any, release: undefined as (() => void) | undefined, unbind: 0 }));
vi.mock("node:tls", async original => {
  const { EventEmitter } = await import("node:events");
  return { ...await original<typeof import("node:tls")>(), connect: () => {
    const socket = Object.assign(new EventEmitter(), { authorized: true, encrypted: true, destroyed: false, closed: false,
      destroy() { this.destroyed = true; return this; } });
    f.socket = socket; return socket;
  } };
});
vi.mock("ldapts", async original => ({ ...await original<typeof import("ldapts")>(), Client: class {
  isConnected = false;
  constructor(private options: any) {}
  async bind() { this.options.createSecureConnection(); this.isConnected = true; }
  async search() { return { searchEntries: [], searchReferences: [] }; }
  async unbind() { f.unbind++; await new Promise<void>(resolve => { f.release = resolve; }); this.isConnected = false; }
} }));
import { createHubDirectory } from "../src/hub/directory/directory.js";
it("does not settle the search promise before both unbind and the physical TLS close", async () => {
  const directory = createHubDirectory({ realm: "example", url: "ldaps://directory.example.test:636", baseDn: "DC=example,DC=test",
    bindDn: "CN=Reader,DC=example,DC=test", profile: "ad" }, { bindPassword: "Dummy-service-password" });
  let settled = false;
  const running = directory.searchPolicyGroups!("own").finally(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(f.unbind).toBe(1));
    expect(settled).toBe(false);
    f.release!(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.socket.destroyed).toBe(true); expect(settled).toBe(false);
    f.socket.closed = true; f.socket.emit("close");
    expect(await running).toEqual({ ok: true, groups: [], truncated: false });
  } finally {
    f.release?.(); await new Promise<void>(resolve => setImmediate(resolve));
    if (f.socket) { f.socket.closed = true; f.socket.emit("close"); }
    await running; await directory.close();
  }
});
