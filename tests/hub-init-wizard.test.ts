/**
 * S-48 `agend hub init` wizard (hub.md §5; #3095 "Installing a Hub" and "Hub and a personal fleet on one machine"
 * addenda). Scripted terminal, real initializer and files in a temporary home, fake S1 identity and fake directory.
 * The directory sign-in against the real S2 module and the fake LDAP rig is in hub-init-rig.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verify } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { runHubInitWizard, type HubServiceControl } from "../src/hub/init/wizard.js";
import { setLocale } from "../src/locale.js";
import { quickstartMachine } from "../src/quickstart.js";
import { ADMIN, FakeIdentity, fakeDirectory, makeTestCerts, scriptedIO, tempDir, type TestCerts } from "./support/hub-init-fixtures.js";

const BIND_PW = "Bind-" + "b".repeat(20);
const USER_PW = "User-" + "u".repeat(20);

let certs: TestCerts;
beforeAll(() => {
  setLocale("en");
  certs = makeTestCerts();
});
afterAll(() => setLocale("en"));

function service(installed = false) {
  const s = { installs: 0, installedNow: installed };
  const control: HubServiceControl = {
    installed: () => s.installedNow,
    install: async () => {
      s.installs += 1;
      s.installedNow = true;
      return "/fake/unit";
    },
  };
  return { s, control };
}

function setup(opts: { home?: string; directory?: Parameters<typeof fakeDirectory>[0]; serviceInstalled?: boolean } = {}) {
  const home = opts.home ?? tempDir("agend-hubinit-home-");
  const identity = new FakeIdentity();
  const dir = fakeDirectory(opts.directory ?? { [`alice:${USER_PW}`]: { ok: true, person: ADMIN } });
  const svc = service(opts.serviceInstalled ?? false);
  const initializer = createHubInitializer({ home, identity, probe: { pidAlive: () => false } });
  const run = (answers: Parameters<typeof scriptedIO>[0]) => {
    const io = scriptedIO(answers);
    return runHubInitWizard({ io: io.io, home, initializer, createDirectory: dir.create, readFile: (p) => readFileSync(p, "utf8"), service: svc.control }).then((outcome) => ({ outcome, io }));
  };
  return { home, identity, dir, svc, run };
}

const addresses = ["Team Hub", "https://hub.example.test:8443", "", "192.0.2.10:8443", "192.0.2.10:9443"];
const tls = () => [certs.cert, certs.key];
const directoryAnswers = () => ["corp", "ldaps://directory.example.test", certs.caCert, "2", "dc=example,dc=test", "cn=reader,dc=example,dc=test", { hidden: BIND_PW }];
const signIn = (pw = USER_PW) => ["alice", { hidden: pw }];
const tail = ["y", "30", "180", "initialize", "install"];

function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe("agend hub init — the whole flow", () => {
  it("sets up a dedicated Hub: config with enabled last, private files, sealed manifest, service on request, pairing steps", async () => {
    const t = setup();
    const { outcome, io } = await t.run([...addresses, ...tls(), ...directoryAnswers(), ...signIn(), ...tail]);
    expect(outcome).toBe("initialized");
    expect(io.remaining()).toBe(0);

    const cfg = yaml.load(readFileSync(join(t.home, "fleet.yaml"), "utf8")) as { hub: Record<string, any> };
    expect(cfg.hub).toMatchObject({
      enabled: true,
      name: "Team Hub",
      webOrigin: "https://hub.example.test:8443",
      memberOrigin: "https://hub.example.test:9443",
      webListen: { host: "192.0.2.10", port: 8443 },
      memberListen: { host: "192.0.2.10", port: 9443 },
      webTls: { certificateFile: "hub/web-tls/cert.pem", keyFile: "hub/web-tls/key.pem" },
      directory: { realm: "corp", url: "ldaps://directory.example.test", profile: "openldap", bindPasswordRef: "file:hub/secrets/directory-bind" },
      administrator: ADMIN.key,
      retention: { contentDays: 30, eventDays: 180 },
      coexistence: "dedicated",
    });
    expect(Object.keys(cfg.hub)[0]).toBe("enabled");

    // The service password lives only in its private file, byte for byte; the operator's password nowhere.
    const secret = join(t.home, "hub/secrets/directory-bind");
    expect(readFileSync(secret, "utf8")).toBe(BIND_PW);
    for (const f of allFiles(t.home)) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toContain(USER_PW);
      if (f !== secret) expect(text, f).not.toContain(BIND_PW);
    }
    expect(io.text()).not.toContain(USER_PW);
    expect(io.text()).not.toContain(BIND_PW);
    for (const f of [secret, join(t.home, "hub/web-tls/key.pem"), join(t.home, "hub/init-manifest.json")]) expect(statSync(f).mode & 0o777, f).toBe(0o600);
    for (const d of ["hub", "hub/secrets", "hub/web-tls", "hub/init"]) expect(statSync(join(t.home, d)).mode & 0o777, d).toBe(0o700);

    // The manifest is sealed by the issuer key over the digest of the settings now in fleet.yaml.
    const manifest = JSON.parse(readFileSync(join(t.home, "hub/init-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ v: 1, hubId: cfg.hub.hubId, planDigest: hubPlanDigest(cfg.hub) });
    expect(verify(null, FakeIdentity.tuple(cfg.hub.hubId, manifest), t.identity.issuer.publicKey, Buffer.from(manifest.signature, "base64"))).toBe(true);
    expect(hubPlanDigest({ ...cfg.hub, name: "Edited by hand" })).not.toBe(manifest.planDigest);

    // The directory test used the service password it was given; the service was installed only on "install".
    expect(t.dir.calls).toEqual([{ bindPassword: BIND_PW, login: "alice" }]);
    expect(t.svc.s.installs).toBe(1);
    const identity = await t.identity.read(t.home);
    expect(io.text()).toContain("https://hub.example.test:9443");
    expect(io.text()).toContain(identity!.spkiSha256);
  });

  it("asks for the service with an exact word: anything else installs nothing; an installed service is not reinstalled", async () => {
    const skip = setup();
    const r1 = await skip.run([...addresses, ...tls(), ...directoryAnswers(), ...signIn(), "y", "30", "180", "initialize", "y"]);
    expect(r1.outcome).toBe("initialized");
    expect(skip.svc.s.installs).toBe(0);
    expect(r1.io.text()).toContain("Service not installed");

    const already = setup({ serviceInstalled: true });
    const r2 = await already.run([...addresses, ...tls(), ...directoryAnswers(), ...signIn(), "y", "30", "180", "initialize"]);
    expect(r2.outcome).toBe("initialized");
    expect(already.svc.s.installs).toBe(0);
    expect(r2.io.text()).toContain("it was not reinstalled");
  });

  it("writes nothing when the operator does not type the confirmation word", async () => {
    const t = setup();
    const { outcome } = await t.run([...addresses, ...tls(), ...directoryAnswers(), ...signIn(), "y", "30", "180", "yes"]);
    expect(outcome).toBe("cancelled");
    expect(existsSync(join(t.home, "hub"))).toBe(false);
    expect(existsSync(join(t.home, "fleet.yaml"))).toBe(false);
  });

  it("writes nothing when the operator declines to become the administrator", async () => {
    const t = setup();
    const { outcome } = await t.run([...addresses, ...tls(), ...directoryAnswers(), ...signIn(), "n"]);
    expect(outcome).toBe("cancelled");
    expect(readdirSync(t.home)).toEqual([]);
  });

  it("refuses to touch an already initialized Hub", async () => {
    const t = setup();
    expect((await t.run([...addresses, ...tls(), ...directoryAnswers(), ...signIn(), ...tail])).outcome).toBe("initialized");
    const before = readFileSync(join(t.home, "fleet.yaml"), "utf8");
    const again = await t.run([]);
    expect(again.outcome).toBe("refused");
    expect(again.io.text()).toContain("never replaces a Hub identity");
    expect(readFileSync(join(t.home, "fleet.yaml"), "utf8")).toBe(before);
  });
});

describe("an interrupted setup", () => {
  it("is shown on the next run; it resumes with the saved answers after the service password, or stays off", async () => {
    const home = tempDir("agend-hubinit-cut-");
    const identity = new FakeIdentity();
    const cut = createHubInitializer({ home, identity, probe: { pidAlive: () => false }, afterStage: (s) => { if (s === "secret") throw new Error("power cut"); } });
    const svc = service();
    const dir = fakeDirectory({ [`alice:${USER_PW}`]: { ok: true, person: ADMIN } });
    const first = scriptedIO([...addresses, ...tls(), ...directoryAnswers(), ...signIn(), "y", "30", "180", "initialize"]);
    expect(await runHubInitWizard({ io: first.io, home, initializer: cut, createDirectory: dir.create, readFile: (p) => readFileSync(p, "utf8"), service: svc.control })).toBe("refused");
    expect(first.text()).toContain("power cut");
    expect(first.text()).toContain("The Hub stays off.");
    expect(existsSync(join(home, "fleet.yaml"))).toBe(false);

    const initializer = createHubInitializer({ home, identity, probe: { pidAlive: () => false } });
    const run = (answers: Parameters<typeof scriptedIO>[0]) => {
      const io = scriptedIO(answers);
      return runHubInitWizard({ io: io.io, home, initializer, createDirectory: dir.create, readFile: (p) => readFileSync(p, "utf8"), service: svc.control }).then((outcome) => ({ outcome, io }));
    };
    const declined = await run(["n"]);
    expect(declined.outcome).toBe("cancelled");
    expect(declined.io.text()).toContain("stopped after step “secret”");
    expect(declined.io.text()).toContain("To start over instead");
    expect(existsSync(join(home, "fleet.yaml"))).toBe(false);

    const resumed = await run(["y", { hidden: BIND_PW }, "initialize", "no"]);
    expect(resumed.outcome).toBe("initialized");
    expect((yaml.load(readFileSync(join(home, "fleet.yaml"), "utf8")) as { hub: { enabled: boolean } }).hub.enabled).toBe(true);
    expect(identity.provisions).toBe(1);
    expect(readFileSync(join(home, "hub/secrets/directory-bind"), "utf8")).toBe(BIND_PW);
  });
});

describe("same OS account as an existing fleet", () => {
  const withFleet = () => {
    const home = tempDir("agend-hubinit-fleet-");
    writeFileSync(join(home, "fleet.yaml"), "# my fleet\ninstances:\n  general:\n    working_directory: /tmp/x\n    backend: claude-code\n");
    return home;
  };

  it("warns with what it found, recommends a dedicated account, and stops unless the exact words are typed", async () => {
    const home = withFleet();
    const before = readFileSync(join(home, "fleet.yaml"), "utf8");
    const t = setup({ home });
    for (const answer of ["y", "yes", "same", ""]) {
      const { outcome, io } = await t.run([answer]);
      expect(outcome).toBe("cancelled");
      expect(io.text()).toContain("This OS account already runs an AgEnD fleet");
      expect(io.text()).toContain("fleet.yaml with 1 agent(s)");
      expect(io.text()).toMatch(/dedicated OS account/);
    }
    expect(readFileSync(join(home, "fleet.yaml"), "utf8")).toBe(before);
    expect(existsSync(join(home, "hub"))).toBe(false);
  });

  it("with “same account” typed, sets up a same-user pilot beside the fleet, keeping its config", async () => {
    const home = withFleet();
    const t = setup({ home });
    const { outcome, io } = await t.run(["same account", ...addresses, ...tls(), ...directoryAnswers(), ...signIn(), ...tail]);
    expect(outcome).toBe("initialized");
    expect(io.text()).toContain("Reminder: same account as an existing fleet");
    const text = readFileSync(join(home, "fleet.yaml"), "utf8");
    expect(text).toContain("# my fleet");
    const cfg = yaml.load(text) as { hub: { coexistence: string }; instances: object };
    expect(cfg.hub.coexistence).toBe("same-user-pilot");
    expect(Object.keys(cfg.instances)).toEqual(["general"]);
  });
});

describe("directory: LDAPS only, and the test sign-in", () => {
  it("refuses an ldap:// address and asks again", async () => {
    const t = setup();
    const plaintext = ["corp", "ldap://directory.example.test", "", "2", "dc=example,dc=test", "cn=reader,dc=example,dc=test", "r"];
    const { outcome, io } = await t.run([...addresses, ...tls(), ...plaintext, ...directoryAnswers(), ...signIn(), ...tail]);
    expect(outcome).toBe("initialized");
    expect(io.text()).toMatch(/ldap:\/\/ is plaintext/);
  });

  it("shows why a test sign-in failed (wrong password, disabled, unreachable or bad certificate) and lets the operator retry", async () => {
    const t = setup({
      directory: {
        [`alice:${USER_PW}`]: { ok: true, person: ADMIN },
        "bob": { ok: false, reason: "not-eligible" },
        "carol": { unavailable: "Error: self-signed certificate in certificate chain" },
      },
    });
    const { outcome, io } = await t.run([
      ...addresses, ...tls(), ...directoryAnswers(),
      "alice", { hidden: "wrong" }, "r",
      "bob", { hidden: USER_PW }, "r",
      "carol", { hidden: USER_PW }, "r",
      ...signIn(), ...tail,
    ]);
    expect(outcome).toBe("initialized");
    const text = io.text();
    expect(text).toContain("The directory refused that login or password.");
    expect(text).toContain("That account is disabled or expired in the directory.");
    expect(text).toContain("its certificate could not be verified: Error: self-signed certificate in certificate chain");
  });

  it("stops after too many failed sign-ins without writing anything", async () => {
    const t = setup();
    const fail = ["alice", { hidden: "wrong" }];
    const { outcome, io } = await t.run([...addresses, ...tls(), ...directoryAnswers(), ...fail, "r", ...fail, "r", ...fail, "r", ...fail, "r", ...fail]);
    expect(outcome).toBe("cancelled");
    expect(io.text()).toContain("Too many attempts");
    expect(readdirSync(t.home)).toEqual([]);
  });

  it("can go back and change the directory settings after a failed sign-in", async () => {
    const t = setup();
    const { outcome } = await t.run([...addresses, ...tls(), ...directoryAnswers(), "alice", { hidden: "wrong" }, "e", ...directoryAnswers(), ...signIn(), ...tail]);
    expect(outcome).toBe("initialized");
  });
});

describe("browser HTTPS certificate", () => {
  it("without a certificate, explains what is needed and stops — no plaintext fallback, nothing written", async () => {
    const t = setup();
    const { outcome, io } = await t.run([...addresses, ""]);
    expect(outcome).toBe("cancelled");
    expect(io.text()).toContain("You need a certificate and its private key for https://hub.example.test:8443");
    expect(readdirSync(t.home)).toEqual([]);
  });

  it("names each problem (wrong host, mismatched key) and accepts a good certificate after retry", async () => {
    const t = setup();
    const { outcome, io } = await t.run([
      ...addresses,
      certs.wrongHost, certs.wrongHostKey, "r",
      certs.cert, certs.otherKey, "r",
      ...tls(), ...directoryAnswers(), ...signIn(), ...tail,
    ]);
    expect(outcome).toBe("initialized");
    expect(io.text()).toContain("host-not-covered");
    expect(io.text()).toContain("key-mismatch");
  });

  it("warns about a self-signed certificate and needs a yes to use it", async () => {
    const t = setup();
    const { outcome, io } = await t.run([...addresses, certs.selfSigned, certs.selfSignedKey, "n", ...tls(), ...directoryAnswers(), ...signIn(), ...tail]);
    expect(outcome).toBe("initialized");
    expect(io.text()).toContain("This certificate is self-signed");
  });
});

describe("addresses, listeners and retention", () => {
  it("refuses http:// addresses, wildcard listeners and invalid retention overrides", async () => {
    const t = setup();
    const { outcome, io } = await t.run([
      "Team Hub", "http://hub.example.test", "https://hub.example.test:8443", "https://hub.example.test:8443", "",
      "0.0.0.0:8443", "192.0.2.10:8443", "192.0.2.10:8443", "192.0.2.10:9443",
      ...tls(), ...directoryAnswers(), ...signIn(), "y", "0", "3651", "thirty", "30", "180", "initialize", "no",
    ]);
    expect(outcome).toBe("initialized");
    const text = io.text();
    expect(text).toContain("must be https://");
    expect(text).toContain("the member address must differ from the web address");
    expect(text).toContain("a wildcard would listen on every network");
    expect(text).toContain("the two listeners must differ");
    expect(text.match(/Enter a whole number of days/g)).toHaveLength(3);
  });

  it.each(["en", "zh-TW"] as const)("presents suggestions in %s and binds accepted defaults to the confirmed plan", async locale => {
    setLocale(locale);
    try {
      const t = setup();
      const { outcome, io } = await t.run([...addresses, ...tls(), ...directoryAnswers(), ...signIn(), "y", "", "", "initialize", "no"]);
      expect(outcome).toBe("initialized");
      expect(io.remaining()).toBe(0);
      expect(io.text()).toContain("[7]"); expect(io.text()).toContain("[30]");
      expect(io.text()).toContain("content 7 days, event records 30 days");
      const cfg = yaml.load(readFileSync(join(t.home, "fleet.yaml"), "utf8")) as any;
      expect(cfg.hub.retention).toEqual({ contentDays: 7, eventDays: 30 });
    } finally { setLocale("en"); }
  });

  it("a loopback address on a dedicated Hub needs an explicit yes", async () => {
    const t = setup();
    const { outcome, io } = await t.run(["Team Hub", "https://127.0.0.1:8443", "n", "https://hub.example.test:8443", "", "192.0.2.10:8443", "192.0.2.10:9443", ...tls(), ...directoryAnswers(), ...signIn(), ...tail]);
    expect(outcome).toBe("initialized");
    expect(io.text()).toContain("only works on this computer");
  });
});

describe("quickstart's first question", () => {
  it("Enter or 1 keeps the fleet setup; 2 is the team Hub", () => {
    expect(quickstartMachine("")).toBe("fleet");
    expect(quickstartMachine("1")).toBe("fleet");
    expect(quickstartMachine("hub")).toBe("fleet");
    expect(quickstartMachine(" 2 ")).toBe("hub");
  });
});
