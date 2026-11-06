/** Real initializer/private files, dummy secrets and inert person/identity/service boundaries. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { runHubInitWizard } from "../src/hub/init/wizard.js";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import { readHubSecretFile } from "../src/hub/init/secret-file.js";
import { setLocale } from "../src/locale.js";
import { ADMIN, FakeIdentity, fakeDirectory, makeTestCerts, scriptedIO, tempDir } from "./support/hub-init-fixtures.js";
let certs: ReturnType<typeof makeTestCerts>;
const homes: string[] = [], PASSWORD = "\uFEFF Dummy-秘密-ä\r\n", USER = "Dummy-person-only-44";
beforeAll(() => { certs = makeTestCerts(); });
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); setLocale("en"); });
afterAll(() => rmSync(certs.dir, { recursive: true, force: true }));
const start = () => ["Example Hub", "https://hub.example.test:8443", "", "192.0.2.10:8443", "192.0.2.10:9443", certs.cert, certs.key,
  "corp", "ldaps://directory.example.test", certs.caCert, "y", "2", "DC=example,DC=test", "CN=Reader,DC=example,DC=test"];
const finish = () => ["alice", "y", "7", "30", "initialize", "no"];
function setup(allowHiddenService = false) {
  const home = realpathSync(tempDir("agend-secret-wizard-")), source = join(home, "owner-secret"); homes.push(home);
  writeFileSync(source, PASSWORD, { mode: 0o600 });
  const identity = new FakeIdentity(), directory = fakeDirectory({ alice: { ok: true, person: ADMIN } });
  const initializer = createHubInitializer({ home, identity, probe: { pidAlive: () => false } });
  const execute = async (answers: Parameters<typeof scriptedIO>[0], selected = initializer) => {
    const io = scriptedIO(answers);
    const askHidden = io.io.askHidden;
    io.io.askHidden = async question => {
      if (/Service account password|服務帳號密碼/.test(question)) expect(allowHiddenService, "file import must not request a typed service password").toBe(true);
      return askHidden(question);
    };
    const outcome = await runHubInitWizard({ checkNetwork: async () => [], home, io: io.io, initializer: selected, createDirectory: directory.create,
      readFile: p => readFileSync(p, "utf8"), readSecretFile: readHubSecretFile,
      service: { installed: () => false, install: async () => { throw Error("not requested"); } } });
    return { outcome, io };
  };
  return { home, source, identity, directory, execute };
}
describe("private service-password file import in init and resume", () => {
  it.each(["en", "zh-TW"] as const)("imports exact bytes after explicit file selection in %s, without retaining the source path or echoing the secret", async locale => {
    setLocale(locale); const s = setup(), r = await s.execute([...start(), "2", s.source, ...finish()]);
    expect(r.outcome).toBe("initialized"); expect(r.io.remaining()).toBe(0);
    expect(s.directory.calls).toEqual([{ bindPassword: PASSWORD, login: "alice" }]);
    expect(readFileSync(join(s.home, "hub/secrets/directory-bind"))).toEqual(Buffer.from(PASSWORD));
    expect(readFileSync(s.source)).toEqual(Buffer.from(PASSWORD)); expect(r.io.text()).not.toContain(PASSWORD); expect(r.io.text()).not.toContain(USER);
    for (const file of readdirSync(join(s.home, "hub"), { recursive: true, withFileTypes: true }).filter(f => f.isFile()).map(f => join(f.parentPath, f.name))) {
      if (file.endsWith("/secrets/directory-bind")) continue;
      expect(readFileSync(file, "utf8")).not.toContain(PASSWORD); expect(readFileSync(file, "utf8")).not.toContain(s.source);
    }
    expect(readFileSync(join(s.home, "fleet.yaml"), "utf8")).not.toContain(s.source);
  });
  it("keeps hidden entry as the default and does not reinterpret a password beginning with file:", async () => {
    const s = setup(true), exact = "file:/this-is-a-literal-password";
    const r = await s.execute([...start(), "", { hidden: exact }, ...finish()]);
    expect(r.outcome).toBe("initialized"); expect(r.io.remaining()).toBe(0);
    expect(s.directory.calls).toEqual([{ bindPassword: exact, login: "alice" }]); expect(r.io.text()).not.toContain(exact);
    expect(readFileSync(join(s.home, "hub/secrets/directory-bind"), "utf8")).toBe(exact);
  });
  it("refuses a non-private file with fixed guidance and cancels before person sign-in or initialization", async () => {
    const s = setup(); chmodSync(s.source, 0o644);
    const r = await s.execute([...start(), "2", s.source, "q", ...finish()]);
    expect(r.outcome).toBe("cancelled"); expect(r.io.remaining()).toBe(finish().length);
    expect(r.io.text()).toContain("mode 0600 or 0400"); expect(r.io.text()).not.toContain(PASSWORD);
    expect(s.directory.calls).toEqual([]); expect(s.identity.provisions).toBe(0); expect(existsSync(join(s.home, "fleet.yaml"))).toBe(false);
    expect(readFileSync(s.source, "utf8")).toBe(PASSWORD);
  });
  it("can correct a bad source choice/file without carrying a rejected secret into initialization", async () => {
    const s = setup(true), r = await s.execute([...start(), "wrong", "2", join(s.home, "missing"), "r", "1", { hidden: "Dummy-replacement-only" }, ...finish()]);
    expect(r.outcome).toBe("initialized"); expect(r.io.remaining()).toBe(0);
    expect(s.directory.calls).toEqual([{ bindPassword: "Dummy-replacement-only", login: "alice" }]);
    expect(readFileSync(join(s.home, "hub/secrets/directory-bind"), "utf8")).toBe("Dummy-replacement-only");
  });
  it("resumes the same sealed plan with an explicitly imported secret and retains the source file", async () => {
    const s = setup();
    const cut = createHubInitializer({ home: s.home, identity: s.identity, probe: { pidAlive: () => false }, afterStage: stage => { if (stage === "secret") throw Error("fixture interruption"); } });
    const first = await s.execute([...start(), "2", s.source, ...finish().slice(0, -1)], cut);
    expect(first.outcome).toBe("refused"); expect(existsSync(join(s.home, "fleet.yaml"))).toBe(false);
    const resumed = await s.execute(["y", "2", s.source, "initialize", "no"]);
    expect(resumed.outcome).toBe("initialized"); expect(resumed.io.remaining()).toBe(0); expect(s.identity.provisions).toBe(1);
    expect(readFileSync(join(s.home, "hub/secrets/directory-bind"))).toEqual(Buffer.from(PASSWORD));
    expect(readFileSync(s.source)).toEqual(Buffer.from(PASSWORD)); expect(resumed.io.text()).not.toContain(PASSWORD);
  });
});
