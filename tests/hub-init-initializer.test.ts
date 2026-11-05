/**
 * S-48 HubInitializer (hub.md §5): plan validation, the plan-bound single-use confirmation, staged commit with
 * `hub.enabled` last, interruption at every durable step (stays off, visible, resumable only with the same plan),
 * and never replacing an identity it did not create.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { createHubInitializer, STAGES, UNAVAILABLE_IDENTITY, type HubInitStage } from "../src/hub/init/initializer.js";
import { HubInitError, type HubInitPlan } from "../src/hub/init/types.js";
import { checkBrowserTls } from "../src/hub/init/browser-tls.js";
import { readHidden, WizardCancelled } from "../src/hub/init/prompt.js";
import { ADMIN, FakeIdentity, makeTestCerts, tempDir, type TestCerts } from "./support/hub-init-fixtures.js";

let certs: TestCerts;
beforeAll(() => {
  certs = makeTestCerts();
});

const BIND_PW = "Bind-" + "b".repeat(20);

function plan(over: Partial<HubInitPlan> = {}): HubInitPlan {
  return {
    name: "Team Hub",
    webOrigin: "https://hub.example.test:8443",
    memberOrigin: "https://hub.example.test:9443",
    directory: { realm: "corp", url: "ldaps://directory.example.test", baseDn: "dc=example,dc=test", bindDn: "cn=reader,dc=example,dc=test", profile: "openldap" },
    bindPasswordRef: "file:hub/secrets/directory-bind",
    administrator: { ...ADMIN.key },
    retention: { contentDays: 30, eventDays: 180 },
    coexistence: "dedicated",
    memberListen: { host: "192.0.2.10", port: 9443 },
    webListen: { host: "192.0.2.10", port: 8443 },
    webTls: { certFile: certs.cert, keyFile: certs.key },
    ...over,
  };
}

function make(opts: { home?: string; afterStage?: (s: HubInitStage) => void; identity?: FakeIdentity; now?: () => number; uid?: number } = {}) {
  const home = opts.home ?? tempDir("agend-hubinit-unit-");
  const identity = opts.identity ?? new FakeIdentity();
  const init = createHubInitializer({
    home, identity, probe: { pidAlive: () => false },
    ...(opts.afterStage ? { afterStage: opts.afterStage } : {}), ...(opts.now ? { now: opts.now } : {}), ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
  });
  return { home, identity, init };
}

const hubCfg = (home: string) => (yaml.load(readFileSync(join(home, "fleet.yaml"), "utf8")) as { hub?: Record<string, unknown> }).hub;

async function problems(p: HubInitPlan, home?: string): Promise<string[]> {
  const { init } = make(home ? { home } : {});
  try {
    await init.validate(p);
    return [];
  } catch (err) {
    return [...(err as HubInitError).problems];
  }
}

describe("plan validation (nothing written)", () => {
  it("accepts a complete plan", async () => {
    expect(await problems(plan())).toEqual([]);
  });

  it("refuses plaintext and malformed addresses, wildcard or equal listeners, and equal origins", async () => {
    expect((await problems(plan({ webOrigin: "http://hub.example.test" }))).join()).toMatch(/must be https:\/\//);
    expect((await problems(plan({ memberOrigin: "https://hub.example.test:9443/path" }))).join()).toMatch(/host\[:port\] only/);
    expect((await problems(plan({ memberOrigin: "https://hub.example.test:8443" }))).join()).toMatch(/must differ/);
    expect((await problems(plan({ webListen: { host: "0.0.0.0", port: 8443 } }))).join()).toMatch(/wildcard/);
    expect((await problems(plan({ memberListen: { host: "::", port: 9443 } }))).join()).toMatch(/wildcard/);
    expect((await problems(plan({ memberListen: { host: "192.0.2.10", port: 8443 } }))).join()).toMatch(/different addresses/);
    expect((await problems(plan({ webListen: { host: "192.0.2.10", port: 70000 } }))).join()).toMatch(/port/);
  });

  it("refuses ldap://, an administrator from another realm, and missing or out-of-range retention", async () => {
    expect((await problems(plan({ directory: { ...plan().directory, url: "ldap://directory.example.test" } }))).join()).toMatch(/plaintext/);
    expect((await problems(plan({ administrator: { realm: "other", objectId: ADMIN.key.objectId } }))).join()).toMatch(/administrator/);
    expect((await problems(plan({ administrator: { realm: "corp", objectId: "alice" } }))).join()).toMatch(/administrator/);
    expect((await problems(plan({ retention: { contentDays: 0, eventDays: 180 } }))).join()).toMatch(/retention.contentDays/);
    expect((await problems(plan({ retention: { eventDays: 180 } as never }))).join()).toMatch(/no default/);
    expect((await problems(plan({ bindPasswordRef: "env:HUB_PASSWORD" }))).join()).toMatch(/bindPasswordRef/);
  });

  it("checks the browser certificate against the web address", async () => {
    expect((await problems(plan({ webTls: { certFile: certs.wrongHost, keyFile: certs.wrongHostKey } }))).join()).toMatch(/does not name/);
    expect((await problems(plan({ webTls: { certFile: certs.cert, keyFile: certs.otherKey } }))).join()).toMatch(/does not belong/);
    expect((await problems(plan({ webTls: { certFile: join(certs.dir, "missing.pem"), keyFile: certs.key } }))).join()).toMatch(/cannot be read/);
    expect(await problems(plan({ webOrigin: "https://192.0.2.10:8443" }))).toEqual([]); // the IP SAN covers it
  });

  it("dedicated vs same-user-pilot must match what is in the account", async () => {
    const home = tempDir("agend-hubinit-fleet-");
    writeFileSync(join(home, "fleet.yaml"), "instances:\n  general:\n    working_directory: /tmp/x\n");
    expect((await problems(plan(), home)).join()).toMatch(/already runs a fleet/);
    expect(await problems(plan({ coexistence: "same-user-pilot" }), home)).toEqual([]);
    expect((await problems(plan({ coexistence: "same-user-pilot" }))).join()).toMatch(/only for an account that already runs a fleet/);
  });

  it("refuses while S1's key generation is unavailable", async () => {
    const init = createHubInitializer({ home: tempDir("agend-hubinit-na-"), identity: UNAVAILABLE_IDENTITY, probe: { pidAlive: () => false } });
    await expect(init.validate(plan())).rejects.toThrow(/not available in this build/);
  });
});

describe("confirmation is server-created, plan-bound and single use", () => {
  it("refuses an unknown, reused or expired reference, and a plan or certificate changed after confirmation", async () => {
    const { home, init } = make();
    await expect(init.commit(plan(), "made-up")).rejects.toThrow(/unknown or was already used/);

    const changed = await init.prepareConfirmation(plan(), { bindPassword: BIND_PW });
    await expect(init.commit(plan({ name: "Other" }), changed.reference)).rejects.toThrow(/changed after confirmation/);
    await expect(init.commit(plan(), changed.reference)).rejects.toThrow(/unknown or was already used/);
    expect(existsSync(join(home, "hub"))).toBe(false);

    let t = Date.now();
    const timed = make({ now: () => t });
    const c = await timed.init.prepareConfirmation(plan(), { bindPassword: BIND_PW });
    t += 11 * 60_000;
    await expect(timed.init.commit(plan(), c.reference)).rejects.toThrow(/expired/);
    expect(existsSync(join(timed.home, "hub"))).toBe(false);

    // The certificate file is swapped between confirmation and commit.
    const certCopy = join(tempDir("agend-hubinit-swap-"), "cert.pem");
    writeFileSync(certCopy, readFileSync(certs.cert));
    const swap = make();
    const s = await swap.init.prepareConfirmation(plan({ webTls: { certFile: certCopy, keyFile: certs.key } }), { bindPassword: BIND_PW });
    writeFileSync(certCopy, `${readFileSync(certs.cert, "utf8")}\n`);
    await expect(swap.init.commit(plan({ webTls: { certFile: certCopy, keyFile: certs.key } }), s.reference)).rejects.toThrow(/changed after confirmation/);
  });

  it("needs the service password before confirming", async () => {
    const { init } = make();
    await expect(init.prepareConfirmation(plan(), { bindPassword: "" })).rejects.toThrow(/password is missing/);
  });
});

describe("staged commit", () => {
  it("runs every stage in order and publishes hub.enabled only at the end", async () => {
    const seen: HubInitStage[] = [];
    let home = "";
    const t = make({
      afterStage: (stage) => {
        seen.push(stage);
        const cfg = existsSync(join(home, "fleet.yaml")) ? hubCfg(home) : undefined;
        if (stage !== "enabled") expect(cfg?.enabled ?? false, stage).toBe(false);
        if (stage === "manifest") expect(existsSync(join(home, "hub/init-manifest.json"))).toBe(true);
      },
    });
    home = t.home;
    const c = await t.init.prepareConfirmation(plan(), { bindPassword: BIND_PW });
    const result = await t.init.commit(plan(), c.reference);
    expect(seen).toEqual([...STAGES]);
    expect(hubCfg(home)?.enabled).toBe(true);
    expect(result.hubId).toBe(hubCfg(home)?.hubId);
    expect((await t.init.inspect()).existingHub).toBe(true);
  });

  for (const stage of STAGES) {
    it(`interrupted after “${stage}”: stays off (or at most enabled at the very end), shows a repair state, resumes only with the same plan`, async () => {
      let armed = true;
      const t = make({
        afterStage: (s) => {
          if (armed && s === stage) throw new Error(`power cut after ${s}`);
        },
      });
      const c = await t.init.prepareConfirmation(plan(), { bindPassword: BIND_PW });
      await expect(t.init.commit(plan(), c.reference)).rejects.toThrow(/power cut/);
      const cfg = existsSync(join(t.home, "fleet.yaml")) ? hubCfg(t.home) : undefined;
      if (stage !== "enabled") expect(cfg?.enabled ?? false).toBe(false);

      const inspection = await t.init.inspect();
      if (stage === "enabled") {
        expect(inspection.existingHub).toBe(true); // everything was written; only the receipt update was cut
        return;
      }
      expect(inspection.existingHub).toBe(false);
      expect(inspection.incomplete?.stage).toBe(stage);
      expect(inspection.incomplete?.plan.name).toBe("Team Hub");

      // Different answers cannot take over the half-done setup.
      await expect(t.init.prepareConfirmation(plan({ name: "Another Hub" }), { bindPassword: BIND_PW })).rejects.toThrow(/already initialized/);

      armed = false;
      const again = await t.init.prepareConfirmation(plan(), { bindPassword: BIND_PW });
      await t.init.commit(plan(), again.reference);
      expect(hubCfg(t.home)?.enabled).toBe(true);
      expect(t.identity.provisions).toBe(1); // the identity was created once and reused
      expect(readFileSync(join(t.home, "hub/secrets/directory-bind"), "utf8")).toBe(BIND_PW);
    });
  }

  it("refuses a hub directory that is a symlink, not a directory, readable by others, or owned by another user — before writing", async () => {
    const elsewhere = tempDir("agend-hubinit-elsewhere-");
    const cases: [string, (home: string) => void, RegExp, number?][] = [
      ["symlink", (home) => symlinkSync(elsewhere, join(home, "hub")), /symlink or not a directory/],
      ["file", (home) => writeFileSync(join(home, "hub"), "x"), /symlink or not a directory/],
      ["group-readable", (home) => { mkdirSync(join(home, "hub")); chmodSync(join(home, "hub"), 0o750); }, /readable by other users/],
      ["other owner", () => {}, /owned by another user/, (process.getuid?.() ?? 0) + 1],
    ];
    for (const [label, arrange, error, uid] of cases) {
      const t = make(uid !== undefined ? { uid } : {});
      arrange(t.home);
      const c = await t.init.prepareConfirmation(plan(), { bindPassword: BIND_PW });
      await expect(t.init.commit(plan(), c.reference), label).rejects.toThrow(error);
      expect(existsSync(join(t.home, "fleet.yaml")), label).toBe(false);
      expect(t.identity.provisions, label).toBe(0);
    }
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("a resumed setup refuses an identity on disk that is not the one it created", async () => {
    let armed = true;
    const t = make({ afterStage: (s) => { if (armed && s === "identity") throw new Error("power cut"); } });
    const c = await t.init.prepareConfirmation(plan(), { bindPassword: BIND_PW });
    await expect(t.init.commit(plan(), c.reference)).rejects.toThrow(/power cut/);
    // Someone replaces the keys while the setup is stopped.
    const file = join(t.home, "hub/keys/identity.json");
    const swapped = { ...JSON.parse(readFileSync(file, "utf8")), hubId: "00000000-0000-4000-8000-000000000000" };
    writeFileSync(file, JSON.stringify(swapped));
    armed = false;
    const again = await t.init.prepareConfirmation(plan(), { bindPassword: BIND_PW });
    await expect(t.init.commit(plan(), again.reference)).rejects.toThrow(/not the one this initialization created/);
    expect(existsSync(join(t.home, "fleet.yaml"))).toBe(false);
    // The same check holds for a swapped certificate key with the original hub id.
    writeFileSync(file, JSON.stringify({ ...swapped, hubId: JSON.parse(readFileSync(join(t.home, "hub/init/operation.json"), "utf8")).identity.hubId, spkiSha256: "f".repeat(64) }));
    const third = await t.init.prepareConfirmation(plan(), { bindPassword: BIND_PW });
    await expect(t.init.commit(plan(), third.reference)).rejects.toThrow(/not the one this initialization created/);
  });

  it("on resume, the service password typed now replaces the one an interrupted run saved", async () => {
    let armed = true;
    const t = make({ afterStage: (s) => { if (armed && s === "secret") throw new Error("power cut"); } });
    const c = await t.init.prepareConfirmation(plan(), { bindPassword: BIND_PW });
    await expect(t.init.commit(plan(), c.reference)).rejects.toThrow(/power cut/);
    expect(readFileSync(join(t.home, "hub/secrets/directory-bind"), "utf8")).toBe(BIND_PW);
    armed = false;
    const changed = "Bind-" + "c".repeat(20);
    const again = await t.init.prepareConfirmation(plan(), { bindPassword: changed });
    await t.init.commit(plan(), again.reference);
    expect(readFileSync(join(t.home, "hub/secrets/directory-bind"), "utf8")).toBe(changed);
  });

  it("never replaces an identity it did not create", async () => {
    const identity = new FakeIdentity();
    const home = tempDir("agend-hubinit-foreign-");
    await identity.provision({ home, memberOrigin: "https://elsewhere.example.test:9443" });
    const before = readFileSync(join(home, "hub/keys/identity.json"), "utf8");
    const t = make({ home, identity });
    expect((await t.init.inspect()).existingHub).toBe(true);
    await expect(t.init.prepareConfirmation(plan(), { bindPassword: BIND_PW })).rejects.toThrow(/already initialized/);
    expect(readFileSync(join(home, "hub/keys/identity.json"), "utf8")).toBe(before);
    expect(existsSync(join(home, "fleet.yaml"))).toBe(false);
  });
});

describe("browser certificate check", () => {
  it("rejects garbage, and an expired or not-yet-valid certificate by its dates", () => {
    expect(checkBrowserTls("nope", "nope", "https://hub.example.test").problems).toEqual(["cert-unreadable"]);
    const cert = readFileSync(certs.cert, "utf8");
    const key = readFileSync(certs.key, "utf8");
    expect(checkBrowserTls(cert, key, "https://hub.example.test:8443").ok).toBe(true);
    expect(checkBrowserTls(cert, key, "https://hub.example.test:8443", Date.now() + 10 * 86_400_000).problems).toContain("expired");
    expect(checkBrowserTls(cert, key, "https://hub.example.test:8443", Date.now() - 10 * 86_400_000).problems).toContain("not-yet-valid");
    expect(checkBrowserTls(cert, readFileSync(certs.otherKey, "utf8"), "https://hub.example.test").problems).toContain("key-mismatch");
    // The CA certificate itself is not a server certificate.
    expect(checkBrowserTls(readFileSync(certs.caCert, "utf8"), key, "https://hub.example.test").problems).toEqual(expect.arrayContaining(["key-mismatch"]));
    const self = checkBrowserTls(readFileSync(certs.selfSigned, "utf8"), readFileSync(certs.selfSignedKey, "utf8"), "https://hub.example.test");
    expect(self).toMatchObject({ ok: true, selfSigned: true });
  });
});

describe("hidden password input", () => {
  function fakeTty(isTTY = true) {
    const listeners: ((c: string) => void)[] = [];
    const raw: boolean[] = [];
    const input = {
      isTTY,
      isRaw: false,
      setRawMode: (m: boolean) => raw.push(m),
      setEncoding: () => {},
      on: (_e: "data", l: (c: string | Buffer) => void) => listeners.push(l as (c: string) => void),
      removeListener: () => listeners.splice(0),
      resume: () => {},
      pause: () => {},
    };
    const written: string[] = [];
    return { input, output: { write: (t: string) => written.push(t) }, type: (s: string) => listeners.forEach((l) => l(s)), raw, written };
  }

  it("never echoes, handles backspace and swallows escape sequences, restores the terminal", async () => {
    const t = fakeTty();
    const p = readHidden(t.input, t.output, "Password: ");
    t.type("se\u001b[Dcr\u007fret\u001bOA\u001b[1;5C");
    t.type("!\r");
    expect(await p).toBe("secret!");
    expect(t.written.join("")).toBe("Password: \n");
    expect(t.raw).toEqual([true, false]);
  });

  it("Ctrl-C cancels; a non-terminal input is refused instead of echoing", async () => {
    const t = fakeTty();
    const p = readHidden(t.input, t.output, "Password: ");
    t.type("abc\u0003");
    await expect(p).rejects.toBeInstanceOf(WizardCancelled);
    const pipe = fakeTty(false);
    await expect(readHidden(pipe.input, pipe.output, "Password: ")).rejects.toThrow(/interactive terminal/);
    expect(pipe.written).toEqual([]);
  });
});
