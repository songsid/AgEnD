/**
 * S-51 PR 2 whole-flow acceptance against the FAKE directory (scripts/manual/hub-directory): `agend hub init` (real S1
 * keys, real LDAPS test sign-in through S2) seals a Hub; the real runtime (S5) mounts it with the real S3b web service;
 * the administrator signs in over TLS, reads the admin overview, and is cut off at the next request once the directory
 * disables them. Skipped unless AGEND_HUB_RIG_ENV names the rig's rig.env (CI's hub-directory job). Never a real
 * directory; listeners on 127.0.0.1 only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "node:https";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { Attribute, Change, Client } from "ldapts";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import { hubIdentityProvider } from "../src/hub/init/identity.js";
import { HubRuntime } from "../src/hub/runtime.js";
import { createHubDirectory } from "../src/hub/directory/index.js";
import { makeTestCerts } from "./support/hub-init-fixtures.js";
import { freeHubPort } from "./helpers/hub-rig.js";

const envFile = process.env.AGEND_HUB_RIG_ENV;
const rig: Record<string, string> = {};
if (envFile && existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) rig[m[1]!] = m[2]!;
  }
}

function call(port: number, ca: string, origin: string, method: string, path: string, opts: { cookie?: string; csrf?: string; body?: unknown } = {}) {
  return new Promise<{ status: number; body: any; cookie?: string }>((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request({
      host: "127.0.0.1", port, path, method, servername: "hub.example.test", ca,
      headers: {
        Origin: origin, Host: new URL(origin).host,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
        ...(opts.csrf ? { "X-CSRF-Token": opts.csrf } : {}),
      },
    }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => {
        const set = res.headers["set-cookie"]?.[0];
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body, ...(set ? { cookie: set.split(";")[0] } : {}) });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe.skipIf(rig.AGEND_HUB_RIG !== "1" || process.platform === "win32")("Hub whole flow against the fake directory (S5b PR 2)", () => {
  let admin: Client;
  // This suite disables its administrator; shared seed users remain read-only for concurrent suites.
  const ownerLogin = `compose-${randomUUID()}`, ownerDn = `uid=${ownerLogin},ou=people,dc=example,dc=test`;
  let ownerUuid = "", ownerCreated = false;
  beforeAll(async () => {
    admin = new Client({ url: rig.AGEND_HUB_RIG_LDAPS_URL!, tlsOptions: { ca: readFileSync(rig.AGEND_HUB_RIG_CA!, "utf8") } });
    await admin.bind(rig.AGEND_HUB_RIG_ADMIN_DN!, rig.AGEND_HUB_RIG_ADMIN_PASSWORD!);
    await admin.add(ownerDn, { objectClass: "inetOrgPerson", uid: ownerLogin, cn: "Compose administrator", sn: "Test",
      userPassword: rig.AGEND_HUB_RIG_SEED_PASSWORD! });
    ownerCreated = true;
    const { searchEntries } = await admin.search(ownerDn, { scope: "base", attributes: ["entryUUID"] });
    ownerUuid = String(searchEntries[0]!.entryUUID);
  });
  afterAll(async () => {
    try { if (ownerCreated) await admin.del(ownerDn); }
    finally { await admin?.unbind(); }
  });

  it("init → mount → directory sign-in → admin → disabled in the directory = refused at the next request", async () => {
    mkdirSync(".artifacts", { recursive: true });
    const home = mkdtempSync(join(process.cwd(), ".artifacts/hub-flow-"));
    chmodSync(home, 0o700);
    const certs = makeTestCerts();
    const [memberPort, webPort] = [await freeHubPort(), await freeHubPort()];
    const webOrigin = `https://hub.example.test:${webPort}`;
    const plan = {
      name: "Flow Hub", webOrigin, memberOrigin: `https://hub.example.test:${memberPort}`,
      memberListen: { host: "127.0.0.1", port: memberPort }, webListen: { host: "127.0.0.1", port: webPort },
      webTls: { certFile: certs.cert, keyFile: certs.key },
      directory: { realm: "rig", url: rig.AGEND_HUB_RIG_LDAPS_URL!, caPem: readFileSync(rig.AGEND_HUB_RIG_CA!, "utf8"), baseDn: rig.AGEND_HUB_RIG_BASE_DN!, bindDn: rig.AGEND_HUB_RIG_BIND_DN!, profile: "openldap" as const },
      bindPasswordRef: "file:hub/secrets/directory-bind",
      administrator: { realm: "rig", objectId: ownerUuid },
      retention: { contentDays: 30, eventDays: 180 },
      coexistence: "dedicated" as const,
    };
    const init = createHubInitializer({ home, identity: hubIdentityProvider(), probe: { pidAlive: () => false } });
    const confirmation = await init.prepareConfirmation(plan, { bindPassword: rig.AGEND_HUB_RIG_BIND_PASSWORD! });
    await init.commit(plan, confirmation.reference);
    const config = yaml.load(readFileSync(join(home, "fleet.yaml"), "utf8")) as { hub: Record<string, unknown> };

    const runtime = new HubRuntime({ home, log: () => {} });
    const ca = readFileSync(certs.caCert, "utf8");
    try {
      await runtime.apply(config);
      expect(runtime.currentHolds()).toEqual([]);
      const seed = rig.AGEND_HUB_RIG_SEED_PASSWORD!;

      expect((await call(webPort, ca, webOrigin, "POST", "/hub/v1/session", { body: { login: ownerLogin, password: "wrong-" + "x".repeat(8) } })).status).toBeGreaterThanOrEqual(400);
      expect((await call(webPort, ca, webOrigin, "POST", "/hub/v1/session", { body: { login: "bob", password: seed } })).status).toBeGreaterThanOrEqual(400);

      const signIn = await call(webPort, ca, webOrigin, "POST", "/hub/v1/session", { body: { login: ownerLogin, password: seed } });
      expect(signIn.status).toBe(200);
      expect(signIn.body).toMatchObject({ signedIn: true, login: ownerLogin, admin: true });
      expect(signIn.cookie).toMatch(new RegExp(`^__Host-agend_hub_${config.hub.hubId}=`));
      expect(JSON.stringify(signIn.body)).not.toContain(seed);

      const overview = await call(webPort, ca, webOrigin, "GET", "/hub/v1/admin/overview", { cookie: signIn.cookie! });
      expect(overview.status).toBe(200);
      expect(overview.body).toMatchObject({ fleets: [], pairings: [] });

      // Disable only this suite’s administrator: its next request is refused without affecting the shared seed.
      await admin.modify(ownerDn, new Change({ operation: "add", modification: new Attribute({ type: "pwdAccountLockedTime", values: ["000001010000Z"] }) }));
      const control = createHubDirectory(plan.directory, { bindPassword: rig.AGEND_HUB_RIG_BIND_PASSWORD! });
      try {
        const after = await call(webPort, ca, webOrigin, "GET", "/hub/v1/admin/overview", { cookie: signIn.cookie! });
        expect(after.status).toBeGreaterThanOrEqual(400);
        // Other concurrent suites read the seed account; this flow must not disable their positive control.
        expect(await control.signIn("alice", seed)).toMatchObject({ ok: true });
      } finally {
        await control.close();
        await admin.modify(ownerDn, new Change({ operation: "delete", modification: new Attribute({ type: "pwdAccountLockedTime", values: [] }) }));
      }
    } finally {
      await runtime.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000); // a real init, LDAPS sign-ins and TLS: well over the default 10 s when suites run in parallel
});
