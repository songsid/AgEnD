/** Actual normal TLS and ldapts BER, two owned loopback peers; no external directory, service or account. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { X509Certificate, randomUUID } from "node:crypto";
import { directoryCertificates } from "./support/hub-directory-ca-fixture.js";
import { groupWirePeer, PERSON_ID } from "./support/hub-group-directory-wire.js";
import { createHubDirectory } from "../src/hub/directory/directory.js";
import { createHubDirectorySettingsProof, probeHubDirectorySettingsTls, type HubDirectoryProofContext } from "../src/hub/settings-directory-proof.js";
import type { HubDirectorySettingsCandidate, HubDirectorySettingsWriter } from "../src/hub/settings-commit.js";
import { resolveDirectoryConfig } from "../src/hub/directory/config.js";
import { BIND_PASSWORD_REF } from "../src/hub/init/layout.js";

let certs: ReturnType<typeof directoryCertificates>;
const peers: Awaited<ReturnType<typeof groupWirePeer>>[] = [], close: Array<() => Promise<void> | void> = [];
beforeAll(() => { certs = directoryCertificates(); });
afterEach(async () => { for (const f of close.splice(0)) await f(); for (const peer of peers.splice(0)) await peer.close(); });
afterAll(() => certs?.cleanup());
const admin = { realm: "fictional", objectId: PERSON_ID }, dn = "CN=Admin,DC=example,DC=test";
async function fixture(material?: { cert: string; key: string }) {
  const old = await groupWirePeer(certs.leaf, [{ id: PERSON_ID, login: "admin", dn, password: "Personal-old-only" }]); peers.push(old);
  const next = await groupWirePeer(material ?? certs.leaf, [{ id: PERSON_ID, login: "admin", dn, password: "Different-new-only" }]); peers.push(next);
  const config = { realm: admin.realm, profile: "ad" as const, url: `ldaps://127.0.0.1:${old.port}`, baseDn: "DC=example,DC=test",
    bindDn: "CN=Reader,DC=example,DC=test", bindPasswordRef: BIND_PASSWORD_REF, caPem: certs.ca, timeoutMs: 500 };
  const directory = createHubDirectory(config, { bindPassword: "Dummy-service-only" }); close.push(() => directory.close());
  const writer: HubDirectorySettingsWriter = {
    prepare: vi.fn((_candidate, _actor, current) => { expect(current()).toBe(true); return { ref: "writer", expiresAt: Date.now() + 300_000 }; }),
    commit: vi.fn((_ref, _actor, current) => { expect(current()).toBe(true); return { receiptId: randomUUID(), directoryEpoch: 1 }; }), compensate: () => { throw Error("not in this test"); },
  };
  let active = 0, peak = 0;
  const control = createHubDirectorySettingsProof({ source: () => ({ directory, config, administrator: admin, bindPassword: "Dummy-service-only", groups: [], epoch: 0, image: "a".repeat(64), current: () => true }),
    withDirectoryRead: async (_key, read) => { active++; peak = Math.max(peak, active); try { return await read(); } finally { active--; } },
    createDirectory: createHubDirectory, writer: () => writer }); close.push(() => control.close());
  const ctx: HubDirectoryProofContext = { actor: { kind: "hub-administrator", person: admin, sessionId: "owned-admin-session", requestId: randomUUID() }, current: () => true };
  const candidate: HubDirectorySettingsCandidate = { directory: { ...config, url: `ldaps://127.0.0.1:${next.port}` }, bindPassword: "Dummy-service-only",
    changes: ["server", "secret"], recipients: [{ kind: "host", sink: "owner-needs-you" }] };
  return { control, ctx, candidate, old, next, writer, config, occupancy: () => ({ active, peak }) };
}
describe("directory settings proof with real TLS and LDAP", () => {
  it("uses credential-free verified inspection, confirms once, reauthenticates only at OLD, and searches NEW with service credentials", async () => {
    const r = await fixture(), p = await r.control.prepare(r.candidate, r.ctx);
    expect(p.trust).toMatchObject({ leafFingerprint: new X509Certificate(certs.leaf.cert).fingerprint256.replace(/:/g, ""),
      caFingerprints: [new X509Certificate(certs.ca).fingerprint256.replace(/:/g, "")] });
    expect(r.old.binds).toEqual([]); expect(r.next.binds).toEqual([]);
    await expect(r.control.apply(p.ref, { confirmation: p.trust!.challenge, credentials: { login: "admin", password: "Personal-old-only" } }, r.ctx)).resolves.toMatchObject({ directoryEpoch: 1 });
    expect(r.old.bindRecords).toContainEqual({ dn, password: "Personal-old-only" });
    expect(r.next.bindRecords.length).toBeGreaterThan(0);
    expect(r.next.bindRecords.every(b => b.dn === "CN=Reader,DC=example,DC=test" && b.password === "Dummy-service-only")).toBe(true);
    expect(r.writer.commit).toHaveBeenCalledOnce(); expect(r.occupancy()).toEqual({ active: 0, peak: 1 });
  });
  it.each(["wrongHost", "expired", "unrelated"] as const)("refuses %s TLS before either directory receives credentials", async material => {
    const r = await fixture(certs[material]);
    await expect(r.control.prepare(r.candidate, r.ctx)).rejects.toMatchObject({ code: "unavailable" });
    expect(r.old.binds).toEqual([]); expect(r.next.binds).toEqual([]); expect(r.writer.commit).not.toHaveBeenCalled(); expect(r.occupancy().active).toBe(0);
  });
  it("the candidate LDAP connection pins the confirmed leaf IN ADDITION to normal CA/hostname verification", async () => {
    const r = await fixture(certs.alternate);
    // Both leaves are valid for this host and issued by the same CA. Only the explicitly confirmed one is accepted.
    const unpinned = createHubDirectory(r.candidate.directory, { bindPassword: "Dummy-service-only" }); close.push(() => unpinned.close());
    expect(await unpinned.checkEligibility(admin)).toMatchObject({ eligible: true });
    const count = r.next.binds.length;
    const pinned = createHubDirectory(r.candidate.directory, { bindPassword: "Dummy-service-only" }, { expectedServerFingerprint: new X509Certificate(certs.leaf.cert).fingerprint256 }); close.push(() => pinned.close());
    expect(await pinned.checkEligibility(admin)).toEqual({ eligible: false, reason: "unavailable" }); expect(r.next.binds).toHaveLength(count);
  });
  it("a changed CA is confirmed in the SAME dialog, with no service bind during preparation", async () => {
    const r = await fixture(certs.unrelated); r.candidate.directory.caPem = certs.unrelated.cert;
    const p = await r.control.prepare(r.candidate, r.ctx);
    expect(p.trust!.caFingerprints).toEqual([new X509Certificate(certs.unrelated.cert).fingerprint256.replace(/:/g, "")]);
    expect(r.next.binds).toEqual([]);
    await expect(r.control.test(p.ref, undefined, r.ctx)).rejects.toMatchObject({ code: "trust" }); expect(r.next.binds).toEqual([]);
  });
  it("the TLS probe closes physically before its promise releases admission", async () => {
    const r = await fixture();
    const leaf = await probeHubDirectorySettingsTls(resolveDirectoryConfig(r.candidate.directory));
    expect(leaf).toBe(new X509Certificate(certs.leaf.cert).fingerprint256.replace(/:/g, "")); expect(r.next.binds).toEqual([]);
  });
});
