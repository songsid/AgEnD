/** Reconstruct the production Fleet-owned controller over the same private files. No Fleet process is started. */
import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { FleetManager } from "../src/fleet-manager.js";
import { CompanyJoinClient } from "../src/hub/join/client.js";
import { currentLocalJoinId } from "../src/hub/join/local-journal.js";
import { companyIdentityDigest } from "../src/hub/join/protocol.js";
const homes: string[] = [], controllers: Array<{ close(): void }> = [];
afterEach(() => { controllers.splice(0).forEach(c => c.close()); vi.restoreAllMocks(); homes.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });

it("a new FleetManager reconstructs the expired journal and starts again from the same private state", async () => {
  const home = mkdtempSync(join(tmpdir(), "company-restart-")); chmodSync(home, 0o700); homes.push(home);
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  const hub = { hubId: randomUUID(), webOrigin: "https://hub.example.test", memberOrigin: "https://hub.example.test:9443",
    spkiSha256: "a".repeat(64), issuerPublicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() };
  vi.spyOn(CompanyJoinClient.prototype, "discover").mockResolvedValue({ v: 1, hub, identityDigest: companyIdentityDigest(hub), certificatePem: "", features: ["company-join-v1"] });
  const push = vi.spyOn(CompanyJoinClient.prototype, "command").mockImplementation(async (binding, purpose) => {
    expect(purpose).toBe("push"); return { requestId: binding.requestId, expiresAt: now + 600_000, browserAction: hub.webOrigin + "/hub/join/open" };
  });
  const session = { ownerKey: {}, sessionId: "b".repeat(64), authorityEpoch: 1, hostHere: true, current: () => true };
  const body = { address: hub.webOrigin, label: "Restart Fleet", fleetOrigin: "http://127.0.0.1:4444" };
  const first = await new FleetManager(home).hubCompanyJoin(); controllers.push(first);
  const old = await first.start(body, { session, confirmedCurrent: () => true }); first.close(); now += 600_000;
  const second = await new FleetManager(home).hubCompanyJoin(); controllers.push(second);
  const next = await second.start(body, { session: { ...session, ownerKey: {}, sessionId: "c".repeat(64) }, confirmedCurrent: () => true });
  expect(next.operationId).not.toBe(old.operationId); expect(next.state).toBe("awaiting-sign-in");
  expect(push).toHaveBeenCalledTimes(2); expect(currentLocalJoinId(home)).toBe(next.operationId);
});
