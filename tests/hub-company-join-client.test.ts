/** Actual CA-authenticated discovery and SPKI-pinned member delivery; never cookies or browser TLS downgrades. */
import { afterEach, describe, expect, it, vi } from "vitest";
const dc = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:tls", async original => {
  const real = await original<typeof import("node:tls")>();
  return { ...real, connect: (options: import("node:tls").ConnectionOptions, callback?: () => void) => real.connect({ ...options,
    ...(options.host === "127.0.0.1" && options.port === 636 ? { port: dc.port } : {}),
    ...(options.host === "hub.example.test" ? { host: "127.0.0.1" } : {}) }, callback) };
});
import { readFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { LookupFunction } from "node:net";
import { companyJoinRig } from "./support/hub-company-join-rig.js";
import { CompanyJoinClient } from "../src/hub/join/client.js";
import { pkceChallenge } from "../src/hub/join/protocol.js";
import { sha256 } from "../src/hub/identity.js";
const lookup: LookupFunction = (_host, options, callback) => options.all
  ? (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [{ address: "127.0.0.1", family: 4 }])
  : callback(null, "127.0.0.1", 4);
let rig: Awaited<ReturnType<typeof companyJoinRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; vi.restoreAllMocks(); });
describe("company join Fleet transport", () => {
  it("uses browser CA trust for discovery, and the independently pinned member listener for all key proofs and delivery", async () => {
    const r = rig = await companyJoinRig(port => { dc.port = port; }), admin = await r.signIn("alice");
    await r.enable(admin); expect((await r.call(admin, "PUT", "/hub/v1/admin/company-join", { enabled: true, expectedRevision: 1 })).status).toBe(200);
    const client = new CompanyJoinClient({ ca: readFileSync(r.certs.caCert), lookup });
    const metadata = await client.discover(r.webOrigin, () => true);
    const key = generateKeyPairSync("ed25519"), verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("hex");
    const binding = { hub: metadata.hub, publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), fleetOrigin: "http://127.0.0.1:4444",
      requestId: randomUUID(), operationId: randomUUID(), fleetId: randomUUID(), verifierS256: pkceChallenge(verifier) };
    const command = (purpose: Parameters<CompanyJoinClient["command"]>[1], payload = {}) => client.command(binding, purpose, payload, key.privateKey, () => true);
    expect(await command("push", { label: "Laptop", stateHash: sha256(state), invitation: null })).toMatchObject({ browserAction: r.webOrigin + "/hub/join/open" });
    expect(await command("status")).toMatchObject({ state: "pending" });
    const opened = await r.call(null, "POST", "/hub/join/open", new URLSearchParams({ requestId: binding.requestId, state }).toString(),
      { "Content-Type": "application/x-www-form-urlencoded", Origin: binding.fleetOrigin });
    const carol = await r.signIn("carol"); carol.cookie += "; " + opened.cookie;
    expect((await r.call(carol, "POST", "/hub/v1/join/approve", { requestId: binding.requestId })).status).toBe(200);
    expect(await command("redeem", { verifier })).toMatchObject({ state: "issued", hub: metadata.hub, credential: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(new CompanyJoinClient({ lookup }).discover(r.webOrigin, () => true)).rejects.toThrow(); // private CA not trusted implicitly
    await expect(client.command({ ...binding, hub: { ...binding.hub, spkiSha256: "a".repeat(64) } }, "status", {}, key.privateKey, () => true)).rejects.toThrow();
    await expect(client.discover(r.webOrigin, () => false)).rejects.toThrow();
    await expect(command("redeem", { verifier: randomBytes(32).toString("base64url") })).rejects.toMatchObject({ code: "denied" });
  });
});
