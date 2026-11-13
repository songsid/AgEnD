/** #3658: terminal setup keeps trust refusals local and never echoes the password acquisition step. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { X509Certificate } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import { directoryCaInfo } from "../src/hub/init/directory-certificate.js";
import { createBrowserCertificate } from "../src/hub/init/browser-certificate.js";
import { readHidden, type HiddenInput } from "../src/hub/init/prompt.js";
import { runHubInitWizard } from "../src/hub/init/wizard.js";
import { ht } from "../src/hub/init/text.js";
import { setLocale } from "../src/locale.js";
import { ADMIN, FakeIdentity, fakeDirectory, makeTestCerts, scriptedIO, tempDir } from "./support/hub-init-fixtures.js";

let certs: ReturnType<typeof makeTestCerts>;
const homes: string[] = [];
const bindPassword = "Dummy-accepted-service-password";
const misplaced = "Dummy-mistyped-at-method-choice";
const web = "https://hub.example.test:8443";
const url = "ldaps://directory.example.test";
beforeAll(() => { certs = makeTestCerts(); });
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); setLocale("en"); });
afterAll(() => rmSync(certs.dir, { recursive: true, force: true }));
const start = () => ["Kept answers", web, "", "192.0.2.10:8443", "192.0.2.10:9443", certs.cert, certs.key];
const people = () => ["2", "DC=example,DC=test", "CN=Reader,DC=example,DC=test"];
const finish = () => ["alice", "y", "", "", "initialize", "no"];

function rig(answers: Parameters<typeof scriptedIO>[0], options: { secretFile?: boolean; beforeAsk?: (question: string, io: ReturnType<typeof scriptedIO>) => void; generate?: boolean } = {}) {
  const home = tempDir("agend-wizard-2917-"); homes.push(home);
  const io = scriptedIO(answers), directory = fakeDirectory({ alice: { ok: true, person: ADMIN } });
  const ask = io.io.ask;
  io.io.ask = async q => { options.beforeAsk?.(q, io); return ask(q); };
  const leaf = new X509Certificate(readFileSync(certs.cert));
  const inspect = vi.fn(async () => ({ url, leafPem: leaf.toString(), chain: [], certificate: {
    subject: leaf.subject, issuer: leaf.issuer, validTo: leaf.validTo, fingerprint256: leaf.fingerprint256,
  } }));
  const fetch = vi.fn(async () => directoryCaInfo(readFileSync(certs.caCert, "utf8")));
  const initializer = createHubInitializer({ home, identity: new FakeIdentity(), probe: { pidAlive: () => false } });
  const run = () => runHubInitWizard({ home, io: io.io, initializer, createDirectory: directory.create,
    readFile: p => readFileSync(p, "utf8"), checkNetwork: async () => [], directoryCertificates: { inspect, fetch },
    ...(options.secretFile ? { readSecretFile: () => bindPassword } : {}),
    ...(options.generate ? { createBrowserCertificate: (origin: string) => {
      expect(io.text()).toContain(ht("tls_intro", web));
      expect(io.text()).toContain("Fleet");
      expect(io.text()).toMatch(/company accounts|公司帳號連接/);
      expect(io.text()).toMatch(/different hostnames|不同的主機名稱/);
      return createBrowserCertificate(home, origin);
    } } : {}),
    service: { installed: () => false, install: async () => { throw Error("must not install"); } },
  });
  return { home, io, directory, inspect, fetch, run };
}

describe("CA refusal keeps earlier wizard answers", () => {
  it.each(["", "not-a-fingerprint"])("returns to the CA choice on %j without trust, credentials or restarting the form", async pin => {
    const t = rig([...start(), "corp", url, "fetch", pin, certs.caCert, "y", ...people(), { hidden: bindPassword }, ...finish()]);
    expect(await t.run()).toBe("initialized");
    expect(t.io.remaining()).toBe(0);
    expect(t.io.prompts.filter(q => q === ht("name_q"))).toHaveLength(1);
    expect(t.io.prompts.filter(q => q === ht("dir_realm_q"))).toHaveLength(1);
    expect(t.io.prompts.filter(q => q === ht("dir_url_q"))).toHaveLength(1);
    expect(t.io.prompts.filter(q => q === ht("dir_ca_q"))).toHaveLength(2);
    expect(t.inspect).toHaveBeenCalledOnce();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.directory.calls).toEqual([{ bindPassword, login: "alice" }]);
    expect(t.io.text()).toMatch(/earlier answers|先前的答案/);
  });

  it("still requires the exact fingerprint before the CA fetch", async () => {
    const pin = new X509Certificate(readFileSync(certs.cert)).fingerprint256;
    const t = rig([...start(), "corp", url, "fetch", pin, "y", ...people(), { hidden: bindPassword }, ...finish()]);
    expect(await t.run()).toBe("initialized");
    expect(t.fetch).toHaveBeenCalledExactlyOnceWith(await t.inspect.mock.results[0]!.value, pin);
  });

  it.each(["file", "fetch"])("returns to CA choices when the %s CA is not approved", async source => {
    const pin = new X509Certificate(readFileSync(certs.cert)).fingerprint256;
    const choice = source === "file" ? [certs.caCert] : ["fetch", pin];
    const t = rig([...start(), "corp", url, ...choice, "", certs.caCert, "y", ...people(), { hidden: bindPassword }, ...finish()]);
    expect(await t.run()).toBe("initialized");
    expect(t.io.remaining()).toBe(0);
    expect(t.io.prompts.filter(q => q === ht("dir_ca_q"))).toHaveLength(2);
    expect(t.io.prompts.filter(q => q === ht("dir_url_q"))).toHaveLength(1);
    expect(t.fetch).toHaveBeenCalledTimes(source === "fetch" ? 1 : 0);
    expect(t.directory.calls).toEqual([{ bindPassword, login: "alice" }]);
    expect(t.io.text()).toContain(ht("dir_ca_not_approved"));
  });
});

describe("directory endpoint is validated before CA choices or a TLS probe", () => {
  it.each(["", "   ", "ldap://directory.example.test", "https://directory.example.test", "ldaps://user:dummy@directory.example.test"])("re-asks only the address for %j", async invalid => {
    const t = rig([...start(), "corp", invalid, url, certs.caCert, "y", ...people(), { hidden: bindPassword }, ...finish()], {
      beforeAsk(q, io) {
        if (q === ht("dir_ca_q")) expect(io.prompts.filter(x => x === ht("dir_url_q")), "CA prompt must wait for a valid LDAPS endpoint").toHaveLength(2);
      },
    });
    expect(await t.run()).toBe("initialized");
    expect(t.inspect).not.toHaveBeenCalled();
    expect(t.io.text()).toMatch(/ldaps:\/\//);
    expect(t.io.prompts.filter(q => q === ht("dir_realm_q"))).toHaveLength(1);
  });
});

it("treats a password accidentally entered at the method choice as hidden invalid input, never as a password or output", async () => {
  const t = rig([...start(), "corp", url, certs.caCert, "y", ...people(),
    { hidden: misplaced }, { hidden: "1" }, { hidden: bindPassword }, ...finish()], { secretFile: true });
  expect(await t.run()).toBe("initialized");
  expect(t.io.text()).not.toContain(misplaced);
  expect(t.io.text()).not.toContain(bindPassword);
  expect(t.directory.calls).toEqual([{ bindPassword, login: "alice" }]);
  for (const f of readdirSync(t.home, { recursive: true, withFileTypes: true }).filter(f => f.isFile())) {
    expect(readFileSync(join(f.parentPath, f.name), "utf8")).not.toContain(misplaced);
  }
});

it("disables terminal echo before displaying a password prompt", async () => {
  let listener: ((chunk: string | Buffer) => void) | undefined;
  const paintedRaw: boolean[] = [];
  const input: HiddenInput = { isTTY: true, isRaw: false,
    setRawMode(mode) { this.isRaw = mode; }, setEncoding() {},
    on(_event, fn) { listener = fn; }, removeListener() { listener = undefined; }, resume() {}, pause() {},
  };
  const p = readHidden(input, { write(text) { if (text !== "\n") paintedRaw.push(input.isRaw === true); } }, "Password: ");
  listener!("Dummy-private-input\r");
  expect(await p).toBe("Dummy-private-input");
  expect(paintedRaw).toEqual([true]);
  expect(input.isRaw).toBe(false);
});

it.each(["en", "zh-TW"] as const)("explains company-join certificate/hostname requirements before offering generation (%s)", async locale => {
  setLocale(locale);
  const t = rig([...start().slice(0, 5), "generate", "y", "corp", url, certs.caCert, "y", ...people(), { hidden: bindPassword }, ...finish()], { generate: true });
  expect(await t.run()).toBe("initialized");
  expect(t.io.text()).toMatch(/trusted|信任/);
  expect(t.io.text()).toMatch(/browser warning|瀏覽器警告/);
});

it.each(["en", "zh-TW"] as const)("leads the completed handoff with the company-account one-box path (%s)", async locale => {
  setLocale(locale);
  const t = rig([...start(), "corp", url, certs.caCert, "y", ...people(), { hidden: bindPassword }, ...finish()]);
  expect(await t.run()).toBe("initialized");
  const text = t.io.text().slice(t.io.text().indexOf(ht("pairing_title")));
  expect(text).toContain(web + "/ui/hub");
  const company = locale === "en" ? "Sign in with company account" : "以公司帳號登入";
  const manual = locale === "en" ? "pairing code" : "配對碼";
  expect(text).toContain(company);
  expect(text).toContain(locale === "en" ? "Administration → Let colleagues join" : "管理 → 讓同仁加入");
  expect(text).toContain(locale === "en" ? "Administration → Advanced: connect with a pairing code" : "管理 → 進階：使用配對碼連接");
  expect(text.indexOf(company)).toBeLessThan(text.indexOf(manual));
  expect(text).not.toContain(bindPassword);
  expect(text).toContain("https://hub.example.test:9443");
});
