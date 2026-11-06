/** Real init/private files + loopback CA bootstrap; final person sign-in/identity/service are inert adapters. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { runHubInitWizard } from "../src/hub/init/wizard.js";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import { inspectDirectoryCertificate, fetchDirectoryCa } from "../src/hub/init/directory-certificate.js";
import { WizardCancelled } from "../src/hub/init/prompt.js";
import { setLocale } from "../src/locale.js";
import { ADMIN, FakeIdentity, fakeDirectory, makeTestCerts, scriptedIO, tempDir } from "./support/hub-init-fixtures.js";
import { directoryCaFixture, directoryCertificates } from "./support/hub-directory-ca-fixture.js";

let web: ReturnType<typeof makeTestCerts>, directory: ReturnType<typeof directoryCertificates>;
const roots: string[] = [], listeners: Array<Awaited<ReturnType<typeof directoryCaFixture>>> = [];
const BIND = "Dummy-service-fixture-only", USER = "Dummy-person-fixture-only";
beforeAll(() => { web = makeTestCerts(); directory = directoryCertificates(); });
afterEach(async () => { for (const f of listeners.splice(0)) await f.close(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); setLocale("en"); });
afterAll(() => { directory?.cleanup(); if (web) rmSync(web.dir, { recursive: true, force: true }); });
const start = () => ["Example Hub", "https://hub.example.test:8443", "", "192.0.2.10:8443", "192.0.2.10:9443", web.cert, web.key];
const reader = () => ["2", "DC=example,DC=test", "CN=Reader,DC=example,DC=test", { hidden: BIND }];
const finish = () => ["alice", "y", "7", "30", "initialize", "no"];
async function listener(requireBind = false) {
  const f = await directoryCaFixture(directory.leaf, directory.ca, { requireBind }); listeners.push(f); return f;
}
function setup(answers: Parameters<typeof scriptedIO>[0], o: { cancelled?: boolean; noFetch?: boolean } = {}) {
  const home = tempDir("agend-ca-wizard-"), identity = new FakeIdentity(); roots.push(home);
  const io = scriptedIO(answers), person = fakeDirectory({ alice: { ok: true, person: ADMIN } });
  let fetchCalls = 0, hiddenPrompts = 0;
  const askHidden = io.io.askHidden;
  io.io.askHidden = async question => { hiddenPrompts++; return askHidden(question); };
  if (o.cancelled) {
    const ask = io.io.ask;
    io.io.ask = async question => { if (/Trust these exact CA/.test(question)) throw new WizardCancelled(); return ask(question); };
  }
  const run = () => runHubInitWizard({ checkNetwork: async () => [], home, io: io.io, initializer: createHubInitializer({ home, identity, probe: { pidAlive: () => false } }),
    createDirectory: person.create, readFile: p => readFileSync(p, "utf8"), service: { installed: () => false, install: async () => { throw Error("not requested"); } },
    ...(!o.noFetch ? { directoryCertificates: { inspect: inspectDirectoryCertificate, fetch: (...args: Parameters<typeof fetchDirectoryCa>) => { fetchCalls++; return fetchDirectoryCa(...args); } } } : {}) });
  return { run, home, io, identity, person, fetchCount: () => fetchCalls, hiddenCount: () => hiddenPrompts };
}
describe("directory CA consent in the initializer", () => {
  it.each(["en", "zh-TW"] as const)("fetches anonymously and confirms exact CA material before any service password in %s", async locale => {
    setLocale(locale); const f = await listener(), pin = new X509Certificate(directory.leaf.cert).fingerprint256;
    const s = setup([...start(), "corp", f.url, "fetch", pin, "y", ...reader(), ...finish()]);
    expect(await s.run()).toBe("initialized"); expect(s.io.remaining()).toBe(0);
    const config = yaml.load(readFileSync(join(s.home, "fleet.yaml"), "utf8")) as any;
    expect(new X509Certificate(config.hub.directory.caPem).fingerprint256).toBe(new X509Certificate(directory.ca).fingerprint256);
    expect(config.hub.directory).not.toHaveProperty("allowPartialTrustChain"); expect(config.hub.directory).not.toHaveProperty("rejectUnauthorized");
    expect(s.io.text()).toContain(new X509Certificate(directory.ca).fingerprint256);
    expect(s.io.text()).toContain(locale === "en" ? "not trusted yet" : "尚未信任");
    expect(s.io.text()).not.toContain(BIND); expect(s.io.text()).not.toContain(USER);
    expect(f.binds).toEqual([{ dn: "", password: "" }]); expect(s.person.calls).toEqual([{ bindPassword: BIND, login: "alice" }]);
  });
  it("asks for the service secret only after exact leaf confirmation when anonymous CA lookup is denied", async () => {
    const f = await listener(true), pin = new X509Certificate(directory.leaf.cert).fingerprint256;
    const s = setup([...start(), "corp", f.url, "fetch", pin, ...reader(), "y", ...finish()]);
    expect(await s.run()).toBe("initialized"); expect(s.io.remaining()).toBe(0);
    expect(s.io.text()).toContain("Anonymous CA lookup was denied");
    expect(f.binds).toEqual([{ dn: "", password: "" }, { dn: "CN=Reader,DC=example,DC=test", password: BIND }]);
    expect(s.io.text()).not.toContain(BIND); expect(s.io.text()).not.toContain(USER);
  });
  it("refuses a mismatched leaf fingerprint without any LDAP bytes or secret prompt", async () => {
    const f = await listener(), s = setup([...start(), "corp", f.url, "fetch", "0".repeat(64), "q"]);
    expect(await s.run()).toBe("cancelled"); expect(s.fetchCount()).toBe(0); expect(s.hiddenCount()).toBe(0);
    expect(s.io.remaining()).toBe(1);
    expect(f.applicationBytes()).toBe(0); expect(s.identity.provisions).toBe(0); expect(s.person.calls).toEqual([]);
    expect(existsSync(join(s.home, "fleet.yaml"))).toBe(false);
  });
  it("declining fetched or imported CA fingerprints cancels before service login and initialization", async () => {
    const f = await listener(), pin = new X509Certificate(directory.leaf.cert).fingerprint256;
    const tail = [...reader(), ...finish()];
    for (const answers of [[...start(), "corp", f.url, "fetch", pin, "n", ...tail], [...start(), "corp", f.url, web.caCert, "n", ...tail]]) {
      const s = setup(answers); expect(await s.run()).toBe("cancelled"); expect(s.io.remaining()).toBe(tail.length);
      expect(s.hiddenCount()).toBe(0);
      expect(s.identity.provisions).toBe(0); expect(s.person.calls).toEqual([]); expect(existsSync(join(s.home, "fleet.yaml"))).toBe(false);
    }
    expect(f.binds).toEqual([{ dn: "", password: "" }]);
  });
  it("propagates terminal cancellation at the new CA consent prompt instead of treating it as an unreadable file", async () => {
    const s = setup([...start(), "corp", "ldaps://directory.example.test", web.caCert], { cancelled: true });
    expect(await s.run()).toBe("cancelled"); expect(s.io.remaining()).toBe(0); expect(s.io.text()).not.toContain("CA file must contain");
    expect(existsSync(join(s.home, "fleet.yaml"))).toBe(false);
  });
  it("keeps system roots available and explains a build without fetch before requesting any secret", async () => {
    const roots = setup([...start(), "corp", "ldaps://directory.example.test", "", ...reader(), ...finish()]);
    expect(await roots.run()).toBe("initialized"); expect(roots.io.remaining()).toBe(0);
    expect((yaml.load(readFileSync(join(roots.home, "fleet.yaml"), "utf8")) as any).hub.directory).not.toHaveProperty("caPem");
    const missing = setup([...start(), "corp", "ldaps://directory.example.test", "fetch", "q"], { noFetch: true });
    expect(await missing.run()).toBe("cancelled"); expect(missing.io.remaining()).toBe(0); expect(missing.io.text()).toContain("import a CA PEM file");
  });
});
