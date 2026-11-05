/**
 * S-48: the `agend hub init` test sign-in through the real S2 directory module against the fake directory
 * (scripts/manual/hub-directory). Skipped unless AGEND_HUB_RIG_ENV names the rig's rig.env (CI's hub-directory job).
 * Never a real directory.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { Client } from "ldapts";
import { createHubDirectory } from "../src/hub/directory/index.js";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import { runHubInitWizard } from "../src/hub/init/wizard.js";
import { setLocale } from "../src/locale.js";
import { FakeIdentity, makeTestCerts, scriptedIO, tempDir, type TestCerts } from "./support/hub-init-fixtures.js";

const envFile = process.env.AGEND_HUB_RIG_ENV;
const rig: Record<string, string> = {};
if (envFile && existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) rig[m[1]!] = m[2]!;
  }
}

describe.skipIf(rig.AGEND_HUB_RIG !== "1")("agend hub init against the fake directory (S-48)", () => {
  let certs: TestCerts;
  let aliceUuid = "";
  beforeAll(async () => {
    setLocale("en");
    certs = makeTestCerts();
    const admin = new Client({ url: rig.AGEND_HUB_RIG_LDAPS_URL!, tlsOptions: { ca: readFileSync(rig.AGEND_HUB_RIG_CA!, "utf8") } });
    await admin.bind(rig.AGEND_HUB_RIG_ADMIN_DN!, rig.AGEND_HUB_RIG_ADMIN_PASSWORD!);
    const { searchEntries } = await admin.search("uid=alice,ou=people,dc=example,dc=test", { scope: "base", attributes: ["entryUUID"] });
    aliceUuid = String(searchEntries[0]!.entryUUID);
    await admin.unbind();
  });
  afterAll(() => setLocale("en"));

  const directory = (ca: string) => [
    "rig", rig.AGEND_HUB_RIG_LDAPS_URL!, ca, "2", rig.AGEND_HUB_RIG_BASE_DN!, rig.AGEND_HUB_RIG_BIND_DN!, { hidden: rig.AGEND_HUB_RIG_BIND_PASSWORD! },
  ];
  const start = () => ["Rig Hub", "https://hub.example.test:8443", "", "192.0.2.10:8443", "192.0.2.10:9443", certs.cert, certs.key];

  async function run(answers: Parameters<typeof scriptedIO>[0]) {
    const home = tempDir("agend-hubinit-rig-");
    const initializer = createHubInitializer({ home, identity: new FakeIdentity(), probe: { pidAlive: () => false } });
    const io = scriptedIO(answers);
    const outcome = await runHubInitWizard({
      io: io.io, home, initializer, createDirectory: createHubDirectory, readFile: (p) => readFileSync(p, "utf8"),
      service: { installed: () => false, install: async () => "unused" },
    });
    return { home, outcome, io };
  }

  it("binds the administrator to the directory's immutable id after a real LDAPS test sign-in; a disabled account is refused first", async () => {
    const seed = rig.AGEND_HUB_RIG_SEED_PASSWORD!;
    const { home, outcome, io } = await run([
      ...start(), ...directory(rig.AGEND_HUB_RIG_CA!),
      "bob", { hidden: seed }, "r",
      "alice", { hidden: "wrong-" + "x".repeat(10) }, "r",
      "alice", { hidden: seed },
      "y", "30", "180", "initialize", "no",
    ]);
    expect(outcome).toBe("initialized");
    expect(io.text()).toContain("That account is disabled or expired in the directory.");
    expect(io.text()).toContain("The directory refused that login or password.");
    const hub = (yaml.load(readFileSync(join(home, "fleet.yaml"), "utf8")) as { hub: Record<string, any> }).hub;
    expect(hub.administrator).toEqual({ realm: "rig", objectId: aliceUuid });
    expect(hub.directory.url).toBe(rig.AGEND_HUB_RIG_LDAPS_URL);
    expect(readFileSync(join(home, "hub/secrets/directory-bind"), "utf8")).toBe(rig.AGEND_HUB_RIG_BIND_PASSWORD);
    expect(io.text()).not.toContain(seed);
    expect(io.text()).not.toContain(rig.AGEND_HUB_RIG_BIND_PASSWORD!);
  });

  it("a directory certificate from the wrong CA fails the test sign-in with the reason, and nothing is written", async () => {
    const { home, outcome, io } = await run([...start(), ...directory(rig.AGEND_HUB_RIG_OTHER_CA!), "alice", { hidden: rig.AGEND_HUB_RIG_SEED_PASSWORD! }, "q"]);
    expect(outcome).toBe("cancelled");
    expect(io.text()).toMatch(/its certificate could not be verified: .*certificate/i);
    expect(existsSync(join(home, "hub"))).toBe(false);
  });

  it("the rig's plaintext ldap:// port is refused before any connection", async () => {
    const { outcome, io } = await run([...start(), "rig", rig.AGEND_HUB_RIG_LDAP_URL!, rig.AGEND_HUB_RIG_CA!, "2", rig.AGEND_HUB_RIG_BASE_DN!, rig.AGEND_HUB_RIG_BIND_DN!, "q"]);
    expect(outcome).toBe("cancelled");
    expect(io.text()).toMatch(/ldap:\/\/ is plaintext/);
  });
});
