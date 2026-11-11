/**
 * M-2921 (Hub UX U1, spec 1.1 "Probe"): the Fleet's read-only look at a Hub before joining. It fetches the Hub's public
 * metadata as start does — asking for the display-only extras (X-AgEnD-Join-Display) — and stops: no pin, no journal, no
 * handoff, no push (A-L4). It answers the Hub's name (an older Hub: null), whether it takes company joins, how its
 * identity compares with what is saved, whether the host names differ, and this computer's name as the suggested label.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyJoinController, probeLabel } from "../src/hub/join/local.js";
import { CompanyJoinReachError, CompanyJoinRemoteError } from "../src/hub/join/client.js";
import { CompanyIdentityChanged, CompanyTrustStore } from "../src/hub/join/trust.js";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { companyIdentityDigest } from "../src/hub/join/protocol.js";

const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const p of homes.splice(0)) rmSync(p, { force: true, recursive: true }); });
const home = () => { const p = mkdtempSync(join(tmpdir(), "agend-u1-probe-")); chmodSync(p, 0o700); homes.push(p); return p; };

async function world(o: { name?: string } = {}) {
  const directory = home(), hubHome = home();
  const identity = await provisionHubIdentity({ home: hubHome, memberOrigin: "https://hub.example.test:9443" });
  const hub = { hubId: identity.hubId, spkiSha256: identity.spkiSha256, issuerPublicKey: identity.issuerPublicKey, memberOrigin: "https://hub.example.test:9443", webOrigin: "https://hub.example.test" };
  const metadata = { v: 1 as const, hub, identityDigest: companyIdentityDigest(hub), certificatePem: readFileSync(join(hubHome, "hub/keys/tls-cert.pem"), "utf8"),
    features: ["company-join-v1", "member-leave-v1"], ...(o.name ? { name: o.name } : {}) };
  const session = { ownerKey: {}, sessionId: "b".repeat(64), authorityEpoch: 1, hostHere: true, current: () => true };
  const discover = vi.fn(async (_origin: string, _current: () => boolean, _options?: { display?: boolean }) => metadata as any);
  const command = vi.fn(async () => { throw new Error("a probe never sends a command"); });
  let now = 1_000_000;
  const controller = new CompanyJoinController({ home: directory, client: { discover, command } as any, now: () => now, schedule: false as const,
    snapshot: () => ({ membership: false, binding: null }), link: () => "offline" as const, activate: vi.fn(), enableMembership: () => {} } as any);
  const probe = (address = hub.webOrigin, fleetOrigin = "http://127.0.0.1:4444") => controller.probe({ address, fleetOrigin }, session);
  return { directory, hub, metadata, discover, command, controller, probe, advance: (ms: number) => { now += ms; } };
}

describe("M-2921: the Fleet's probe", () => {
  it("answers what the Fleet would join: the Hub's name, company join, a new identity, separate hosts, this computer's name; asks for the display extras", async () => {
    const w = await world({ name: "Acme Hub" });
    const r = await w.probe();
    expect(r).toEqual({ ok: true, hubName: "Acme Hub", webOrigin: "https://hub.example.test", companyJoin: true, identity: "new", separateHosts: true,
      suggestedLabel: probeLabel(), features: ["company-join-v1", "member-leave-v1"] });
    expect(w.discover).toHaveBeenCalledWith("https://hub.example.test", expect.any(Function), { display: true });
  });
  it("an older Hub (no display name): hubName null, so the page shows the host", async () => {
    const w = await world();
    expect(await w.probe()).toMatchObject({ ok: true, hubName: null });
  });
  it("A-L4: leaves no trace — after five probes there is no company-trust file or directory, no company-joins record, and no command was sent", async () => {
    const w = await world({ name: "Acme Hub" });
    for (let i = 0; i < 5; i++) await w.probe();
    expect(existsSync(join(w.directory, "hub-member"))).toBe(false);
    expect(readdirSync(w.directory)).toEqual([]);
    expect(w.command).not.toHaveBeenCalled();
  });
  it("identity: known once pinned (a start's pin), changed when the saved pin differs; nothing is written either way", async () => {
    const w = await world();
    new CompanyTrustStore(w.directory).checkAndPin(w.hub, null, null, () => true);           // what a start leaves
    const pinned = readdirSync(join(w.directory, "hub-member/company-trust"));
    expect(await w.probe()).toMatchObject({ identity: "known" });
    const other = await world();                                                           // another identity at the same origin
    w.discover.mockResolvedValueOnce(other.metadata as any);
    expect(await w.probe()).toMatchObject({ identity: "changed" });
    expect(readdirSync(join(w.directory, "hub-member/company-trust"))).toEqual(pinned);
  });
  it.each([["certificate"], ["unreachable"], ["not-hub"]] as const)("a Hub that cannot be read (%s): that reason, for its message (E4 / E3 / E5)", async (kind) => {
    const w = await world();
    w.discover.mockRejectedValueOnce(new CompanyJoinReachError(kind));
    expect(await w.probe()).toEqual({ ok: false, reason: kind });
  });
  it("a Hub with company join off: companyJoin false (E6); an identity that does not verify: changed (E8)", async () => {
    const w = await world();
    w.discover.mockRejectedValueOnce(new CompanyJoinRemoteError("incompatible"));
    expect(await w.probe()).toMatchObject({ ok: true, companyJoin: false });
    w.discover.mockRejectedValueOnce(new CompanyIdentityChanged());
    expect(await w.probe()).toMatchObject({ ok: true, identity: "changed" });
  });
  it("the same host name for the Fleet and the Hub: separateHosts false (E7) — a different port is not enough", async () => {
    const w = await world();
    expect(await w.probe("https://hub.example.test", "https://hub.example.test:8443")).toMatchObject({ separateHosts: false });
  });
  it("10 probes per session per minute; the 11th says limited; a minute later it answers again", async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) expect(await w.probe()).toMatchObject({ ok: true });
    expect(await w.probe()).toEqual({ ok: false, reason: "limited" });
    w.advance(60_001);
    expect(await w.probe()).toMatchObject({ ok: true });
  });
  it("the suggested label is the computer's name: its first label, at most 120 characters", () => {
    expect(probeLabel("Hans-MacBook-Pro.local")).toBe("Hans-MacBook-Pro");
    expect(probeLabel("x".repeat(200))).toHaveLength(120);
    expect(probeLabel("")).toBe("");
  });
});
