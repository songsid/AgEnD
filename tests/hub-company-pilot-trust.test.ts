/** Owned loopback HTTPS and scratch certificates only; no real Hub, directory, account or browser. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:https";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { X509Certificate } from "node:crypto";
import { inspectPilotCertificate } from "../src/hub/join/certificate.js";
import { CompanyJoinController } from "../src/hub/join/local.js";
import { CompanyCertificateTrust } from "../src/hub/join/certificate-trust.js";
import { hubPilotTrustSettings } from "../src/hub-pilot-trust-settings.js";
import { CompanyJoinClient } from "../src/hub/join/client.js";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { companyIdentityDigest } from "../src/hub/join/protocol.js";
import { sha256 } from "../src/hub/identity.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const done of cleanup.splice(0).reverse()) await done(); });
async function loopbackHub() {
  const home = mkdtempSync(join(tmpdir(), "agend-pilot-trust-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const identity = await provisionHubIdentity({ home, memberOrigin: "https://127.0.0.1:9443" });
  const certificatePem = readFileSync(join(home, "hub/keys/tls-cert.pem"), "utf8");
  let metadata: unknown; const requests: string[] = [];
  const server: Server = createServer({ cert: certificatePem, key: readFileSync(join(home, "hub/keys/tls-key.pem")) }, (req, res) => {
    requests.push(req.url ?? ""); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(metadata));
  });
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("owned listener");
  const origin = `https://127.0.0.1:${address.port}`, hub = { ...identity, webOrigin: origin, memberOrigin: "https://127.0.0.1:9443" };
  const { issuerKeyId: _issuerKeyId, ...joinHub } = hub;
  metadata = { v: 1, hub: joinHub, identityDigest: companyIdentityDigest(joinHub), certificatePem, features: ["company-join-v1", "enrolment-code-v1"] };
  return { home, origin, certificatePem, fingerprint: sha256(new X509Certificate(certificatePem).raw), requests };
}
function discoverPinned(client: CompanyJoinClient, origin: string, certificateFingerprint: string) {
  // Structural options keep the fail-first input native-compiling before the new optional field is implemented.
  const options = { display: true, certificateFingerprint };
  return client.discover(origin, () => true, options);
}
describe("pilot company join certificate transport", () => {
  it("reads a self-signed IP Hub through exactly the certificate the person chose", async () => {
    const r = await loopbackHub();
    await expect(discoverPinned(new CompanyJoinClient(), r.origin, r.fingerprint)).resolves.toMatchObject({ hub: { webOrigin: r.origin } });
    expect(r.requests).toEqual(["/hub/v1/join/metadata"]);
  });
  it("refuses a different certificate before any metadata request", async () => {
    const r = await loopbackHub();
    await expect(discoverPinned(new CompanyJoinClient(), r.origin, "a".repeat(64))).rejects.toThrow();
    expect(r.requests).toEqual([]);
  });
  it("does not offer an expired or wrong-name certificate for pilot trust", async () => {
    const r = await loopbackHub(), cert = new X509Certificate(r.certificatePem);
    expect(() => inspectPilotCertificate(cert.raw, "https://localhost")).toThrow();
    expect(() => inspectPilotCertificate(cert.raw, r.origin, Date.parse(cert.validTo))).toThrow();
  });
  it("keeps ordinary OS/CA trust when no certificate was chosen", async () => {
    const r = await loopbackHub();
    await expect(new CompanyJoinClient().discover(r.origin, () => true)).rejects.toThrow();
    expect(r.requests).toEqual([]);
    await expect(new CompanyJoinClient({ ca: r.certificatePem }).discover(r.origin, () => true)).resolves.toMatchObject({ hub: { webOrigin: r.origin } });
  });
});

async function fleet(r: Awaited<ReturnType<typeof loopbackHub>>, allowed = true) {
  const home = mkdtempSync(join(tmpdir(), "agend-pilot-fleet-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  let enabled = allowed;
  const transport = new CompanyJoinClient(), command = vi.fn<CompanyJoinClient["command"]>(async (binding, purpose) => {
    if (purpose !== "push") throw Error("Only push expected");
    return { requestId: binding.requestId, expiresAt: Date.now() + 600_000, browserAction: r.origin + "/hub/join/open" };
  });
  const controller = new CompanyJoinController({ home, schedule: false, pilotTrustEnabled: () => enabled,
    client: { discover: transport.discover.bind(transport), inspectCertificate: transport.inspectCertificate.bind(transport), command },
    snapshot: () => ({ membership: false, binding: null }), enableMembership: () => { throw Error("Not redeemed"); }, activate() {}, link: () => "offline" });
  cleanup.push(() => controller.close());
  const session = { ownerKey: {}, sessionId: "b".repeat(64), authorityEpoch: 1, hostHere: true, current: () => true };
  const input = { address: r.origin, fleetOrigin: "http://localhost:12345" };
  return { home, command, controller, session, input, off: () => { enabled = false; },
    start: (fingerprint = r.fingerprint, previous: string | null = null) => controller.start({ ...input, label: "Pilot Fleet", code: "ABCD2345", trust: { fingerprint, previous } }, { session, confirmedCurrent: () => true }) };
}
describe("Fleet pilot trust consent and persistence", () => {
  it("probes without saving, then trusts and starts the code join in one press", async () => {
    const r = await loopbackHub(), f = await fleet(r);
    expect(await f.controller.probe(f.input, f.session)).toMatchObject({ ok: false, reason: "certificate", selfSigned: true, trust: { fingerprint: r.fingerprint, previous: null } });
    expect(existsSync(join(f.home, "hub-member"))).toBe(false); expect(r.requests).toEqual([]);
    expect(await f.start()).toMatchObject({ state: "awaiting-sign-in" });
    expect(f.command).toHaveBeenCalledOnce(); expect(f.command.mock.calls[0]![2]).toMatchObject({ code: "ABCD2345" });
    expect(new CompanyCertificateTrust(f.home).read(r.origin)).toBe(r.fingerprint);
    expect(await f.controller.probe(f.input, f.session)).toMatchObject({ ok: true, companyJoin: true, pilotTrusted: true });
  });
  it("a wrong choice saves no pin and pushes nothing", async () => {
    const r = await loopbackHub(), f = await fleet(r);
    await expect(f.start("a".repeat(64))).rejects.toThrow();
    expect(f.command).not.toHaveBeenCalled(); expect(existsSync(join(f.home, "hub-member"))).toBe(false); expect(r.requests).toEqual([]);
  });
  it("turning the setting off requires OS trust even with a saved certificate", async () => {
    const r = await loopbackHub(), f = await fleet(r);
    new CompanyCertificateTrust(f.home).save(r.origin, { fingerprint: r.fingerprint, previous: null }, () => true);
    f.off();
    expect(await f.controller.probe(f.input, f.session)).toEqual({ ok: false, reason: "certificate", selfSigned: true });
    await expect(f.start()).rejects.toThrow(); expect(f.command).not.toHaveBeenCalled(); expect(r.requests).toEqual([]);
  });
  it("a changed pin is refused until the person explicitly selects it again, with an exact previous pin", async () => {
    const r = await loopbackHub(), f = await fleet(r), store = new CompanyCertificateTrust(f.home), previous = "a".repeat(64);
    store.save(r.origin, { fingerprint: previous, previous: null }, () => true);
    expect(await f.controller.probe(f.input, f.session)).toMatchObject({ ok: false, reason: "certificate", trust: { fingerprint: r.fingerprint, previous } });
    await expect(f.controller.start({ ...f.input, label: "Pilot Fleet" }, { session: f.session, confirmedCurrent: () => true })).rejects.toThrow();
    await expect(f.start()).rejects.toThrow(); expect(store.read(r.origin)).toBe(previous); expect(f.command).not.toHaveBeenCalled();
    expect(await f.start(r.fingerprint, previous)).toMatchObject({ state: "awaiting-sign-in" }); expect(store.read(r.origin)).toBe(r.fingerprint);
  });
  // Leader 11-14 (2.4.0-beta.1): pilot trust defaults on for -alpha and -beta prerelease builds, off for stable.
  it.each(["2.4.0", "2.4.0-rc.1", "2.4.0-betaish", "bad"])("defaults off in %s, while alpha and beta default on and explicit settings win", version => {
    expect(hubPilotTrustSettings({}, version)).toEqual({ enabled: false });
    expect(hubPilotTrustSettings({}, "2.4.0-alpha.3")).toEqual({ enabled: true });
    expect(hubPilotTrustSettings({}, "2.4.0-beta.1")).toEqual({ enabled: true });
    expect(hubPilotTrustSettings({ hub_member: { pilot_trust: false } }, "2.4.0-beta.1")).toEqual({ enabled: false });
    expect(hubPilotTrustSettings({ hub_member: { pilot_trust: false } }, "2.4.0-alpha.3")).toEqual({ enabled: false });
    expect(hubPilotTrustSettings({ hub_member: { pilot_trust: true } }, version)).toEqual({ enabled: true });
  });
});
