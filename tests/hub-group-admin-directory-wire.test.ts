/** New control -> real directory driver -> verified loopback LDAPS, fake people only. Admin session callbacks are inert. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
const wire = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:tls", async original => {
  const real = await original<typeof import("node:tls")>();
  return { ...real, connect: (options: any) => real.connect({ ...options,
    ...(options.host === "127.0.0.1" && options.port === 636 ? { port: wire.port } : {}) }) };
});
import { directoryCertificates } from "./support/hub-directory-ca-fixture.js";
import { groupWirePeer, GROUP_A, GROUP_DN, PERSON_ID } from "./support/hub-group-directory-wire.js";
import { createHubDirectory } from "../src/hub/directory/directory.js";
import { createHubGroupAdminReads } from "../src/hub/group-policy/admin-read.js";
import type { HubActor } from "../src/hub/types.js";

let certs: ReturnType<typeof directoryCertificates> | undefined;
let peer: Awaited<ReturnType<typeof groupWirePeer>> | undefined;
let directory: ReturnType<typeof createHubDirectory> | undefined;
let reads: ReturnType<typeof createHubGroupAdminReads> | undefined;
beforeAll(() => { certs = directoryCertificates(); });
afterEach(async () => { reads?.close(); await directory?.close(); await peer?.close(); reads = undefined; directory = undefined; peer = undefined; });
afterAll(() => certs?.cleanup());
async function fixture() {
  peer = await groupWirePeer(certs!.leaf); wire.port = peer.port;
  directory = createHubDirectory({ realm: "example", profile: "ad", url: "ldaps://127.0.0.1:636", caPem: certs!.ca,
    baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test", timeoutMs: 500 }, { bindPassword: "Dummy-service-only" });
  const administrator = { realm: "example", objectId: PERSON_ID }, authenticate = vi.fn(async (): Promise<HubActor> => ({ kind: "directory", person: administrator, sessionId: "wire-session" }));
  const unused = () => { throw Error("selection must not read/change policy or resource state"); };
  reads = createHubGroupAdminReads({ administrator, directory, current: () => true, binding: () => ({ kind: "repair-required", legacy: false }),
    policy: unused, inventory: { current: unused, ledger: unused, paused: unused }, authorization: { resume: unused } });
  return { reads, peer, authenticate, ctx: { requestId: "admin-wire", current: () => true, requireAdmin: authenticate } };
}
describe("administrator group selection over real LDAPS", () => {
  it("returns the selected immutable GUID after the real same-object directory recheck", async () => {
    const w = await fixture();
    expect(await w.reads.resolve({ dn: GROUP_DN }, w.ctx)).toEqual({ ok: true, realm: "example", objectId: GROUP_A, dn: GROUP_DN });
    expect(w.authenticate).toHaveBeenCalledTimes(2); expect(w.peer.searches).toHaveLength(2);
    expect(w.peer.binds).toEqual(["CN=Reader,DC=example,DC=test"]);
    expect(w.peer.searches.every(s => s.sizeLimit === 2 && s.deref === 0)).toBe(true);
  });
  it("keeps a missing group selection bounded with no key or DN disclosure", async () => {
    const w = await fixture(); w.peer.state.labels.delete(GROUP_A);
    expect(await w.reads.resolve({ dn: GROUP_DN }, w.ctx)).toEqual({ ok: false, reason: "not-found" });
    expect(w.authenticate).toHaveBeenCalledTimes(2);
  });
});
