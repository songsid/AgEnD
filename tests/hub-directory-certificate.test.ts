import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { X509Certificate } from "node:crypto";
import { directoryCaInfo, fetchDirectoryCa, inspectDirectoryCertificate } from "../src/hub/init/directory-certificate.js";
import { CA_DN, directoryCaFixture, directoryCertificates } from "./support/hub-directory-ca-fixture.js";

let certs: ReturnType<typeof directoryCertificates>;
const fixtures: Array<Awaited<ReturnType<typeof directoryCaFixture>>> = [];
beforeAll(() => { certs = directoryCertificates(); });
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
afterAll(() => certs?.cleanup());
async function fixture(pair = certs.leaf, mode: Parameters<typeof directoryCaFixture>[2] = {}) {
  const f = await directoryCaFixture(pair, certs.ca, mode); fixtures.push(f); return f;
}
const credentials = { bindDn: "CN=Reader,DC=example,DC=test", password: "Dummy-fixture-only-22" };
describe("initializer-only directory CA bootstrap over real loopback LDAPS", () => {
  it("inspects without sending application bytes and refuses plaintext, wrong-host or expired certificates", async () => {
    const f = await fixture(), p = await inspectDirectoryCertificate(f.url);
    expect(p.certificate.fingerprint256).toBe(new X509Certificate(certs.leaf.cert).fingerprint256);
    expect(f.applicationBytes()).toBe(0); expect(f.binds).toEqual([]); expect(f.searches).toEqual([]);
    await expect(inspectDirectoryCertificate(f.url.replace("ldaps:", "ldap:"))).rejects.toThrow();
    expect(Date.parse(new X509Certificate(certs.expired.cert).validTo)).toBeLessThanOrEqual(Date.now());
    for (const pair of [certs.wrongHost, certs.expired]) await expect(inspectDirectoryCertificate((await fixture(pair)).url)).rejects.toThrow();
  });
  it("requires the exact owner-confirmed fingerprint before credentials or a second connection", async () => {
    const f = await fixture(), p = await inspectDirectoryCertificate(f.url), before = f.rawConnections();
    const failures: string[] = [];
    for (const pin of ["", "0".repeat(64), "trust"]) failures.push(await fetchDirectoryCa(p, pin, credentials).then(() => "accepted", e => e.message));
    expect(f.rawConnections()).toBe(before); expect(f.applicationBytes()).toBe(0);
    expect(failures).toEqual(Array(3).fill("directory_ca_pin"));
    f.rotate(certs.alternate);
    await expect(fetchDirectoryCa(p, p.certificate.fingerprint256, credentials)).rejects.toThrow();
    expect(f.binds).toEqual([]); expect(f.applicationBytes()).toBe(0);
  });
  it("fetches only the exact same-directory AIA base entry anonymously and proves ordinary CA verification", async () => {
    const f = await fixture(), p = await inspectDirectoryCertificate(f.url);
    const result = await fetchDirectoryCa(p, p.certificate.fingerprint256);
    expect(result.pem).toBe(new X509Certificate(certs.ca).toString());
    expect(result.certificates).toEqual(directoryCaInfo(certs.ca).certificates);
    expect(f.binds).toEqual([{ dn: "", password: "" }]);
    expect(f.searches).toEqual([{ base: CA_DN, scope: 0, deref: 0, sizeLimit: 1, timeLimit: 3, typesOnly: false,
      filter: "(objectClass=*)", attributes: ["cACertificate;binary", "cACertificate"] }]);
    expect(f.rawConnections()).toBe(3); // Inspect, fingerprint-authenticated LDAP, fresh ordinary CA-verified TLS.
    expect(JSON.stringify(result)).not.toContain(credentials.password);
  });
  it("uses the read-only service credential only after verified pinning when anonymous lookup is denied", async () => {
    const f = await fixture(certs.leaf, { requireBind: true }), p = await inspectDirectoryCertificate(f.url);
    await expect(fetchDirectoryCa(p, p.certificate.fingerprint256)).rejects.toThrow("directory_ca_auth_required");
    expect(f.binds).toEqual([{ dn: "", password: "" }]);
    const result = await fetchDirectoryCa(p, p.certificate.fingerprint256, credentials);
    expect(result.certificates[0]!.fingerprint256).toBe(new X509Certificate(certs.ca).fingerprint256);
    expect(f.binds).toEqual([{ dn: "", password: "" }, { dn: credentials.bindDn, password: credentials.password }]);
    expect(f.searches).toHaveLength(2); expect(f.searches.every(s => s.base === CA_DN && s.scope === 0)).toBe(true);
  });
  it("uses a complete presented issuer chain without any LDAP operation", async () => {
    const f = await fixture({ ...certs.leaf, cert: certs.leaf.cert + certs.ca }), p = await inspectDirectoryCertificate(f.url);
    const result = await fetchDirectoryCa(p, p.certificate.fingerprint256, credentials);
    expect(result.certificates[0]!.fingerprint256).toBe(new X509Certificate(certs.ca).fingerprint256);
    expect(f.binds).toEqual([]); expect(f.searches).toEqual([]); expect(f.applicationBytes()).toBe(0);
  });
  it("does not send credentials to an AIA host, accept a wrong issuer, follow referrals or reconnect after a dropped operation", async () => {
    const target = await fixture();
    for (const [pair, mode] of [
      [certs.external, {}], [certs.leaf, { wrongCa: true }],
      [certs.leaf, { referral: target.url.replace("ldaps:", "ldap:") + "/dc=outside" }],
      [certs.leaf, { dropAfterBind: true }],
    ] as const) {
      const f = await fixture(pair, mode), p = await inspectDirectoryCertificate(f.url);
      await expect(fetchDirectoryCa(p, p.certificate.fingerprint256, credentials)).rejects.toThrow();
      expect(f.binds.length).toBeLessThanOrEqual(1); expect(f.rawConnections()).toBeLessThanOrEqual(2);
    }
    expect(target.rawConnections()).toBe(0);
  });
  it("requires the final ordinary CA verification even after the pinned AIA lookup succeeded", async () => {
    let f!: Awaited<ReturnType<typeof fixture>>;
    f = await fixture(certs.leaf, { afterSearch: () => f.rotate(certs.unrelated) });
    const p = await inspectDirectoryCertificate(f.url);
    await expect(fetchDirectoryCa(p, p.certificate.fingerprint256, credentials)).rejects.toThrow("directory_ca_unavailable");
    expect(f.binds).toEqual([{ dn: credentials.bindDn, password: credentials.password }]);
  });
  it("bounds the whole LDAP response, including attributes outside the requested certificate view", async () => {
    const f = await fixture(certs.leaf, { oversized: true }), p = await inspectDirectoryCertificate(f.url);
    await expect(fetchDirectoryCa(p, p.certificate.fingerprint256)).rejects.toThrow("directory_ca_unavailable");
    expect(f.searches).toHaveLength(1); expect(f.rawConnections()).toBe(2);
  });
  it("refuses invalid service secrets before opening a bootstrap connection", async () => {
    const f = await fixture(), p = await inspectDirectoryCertificate(f.url), before = f.rawConnections();
    for (const invalid of [{ bindDn: "", password: "dummy" }, { bindDn: "CN=x", password: "" }, { bindDn: "CN=x", password: "\0" }, { bindDn: "CN=x", password: "x".repeat(1025) }])
      await expect(fetchDirectoryCa(p, p.certificate.fingerprint256, invalid)).rejects.toThrow("directory_ca_invalid");
    expect(f.rawConnections()).toBe(before); expect(f.applicationBytes()).toBe(0);
  });
  it("ends a silent TLS inspection at its deadline without any credential-bearing operation", async () => {
    const { createServer } = await import("node:net");
    let accept!: () => void;
    const accepted = new Promise<void>(resolve => { accept = resolve; });
    const peers: import("node:net").Socket[] = [], server = createServer(s => { peers.push(s); s.on("error", () => {}); accept(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const result = inspectDirectoryCertificate(`ldaps://127.0.0.1:${(server.address() as any).port}`).then(() => { settled = true; }, () => { settled = true; });
    try { await accepted; await vi.advanceTimersByTimeAsync(5000); expect(settled).toBe(true); }
    finally { for (const p of peers) p.destroy(); vi.useRealTimers(); await result; await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("deduplicates identical issuer values and rejects malformed/expired/non-CA import material", async () => {
    const f = await fixture(certs.leaf, { duplicate: true }), p = await inspectDirectoryCertificate(f.url);
    expect((await fetchDirectoryCa(p, p.certificate.fingerprint256)).certificates).toHaveLength(1);
    for (const pem of ["", "not PEM", certs.leaf.cert, certs.ca + "-----BEGIN CERTIFICATE-----\nbroken", "x".repeat(64 * 1024 + 1), certs.ca.repeat(5)]) expect(() => directoryCaInfo(pem)).toThrow();
    expect(() => directoryCaInfo(certs.ca, Date.now() - 3 * 86_400_000)).toThrow("directory_ca_expired");
    expect(() => directoryCaInfo(certs.ca, Date.now() + 3 * 86_400_000)).toThrow("directory_ca_expired");
    expect(directoryCaInfo(certs.ca).certificates[0]!.fingerprint256).toBe(new X509Certificate(certs.ca).fingerprint256);
  });
});
