/**
 * Company-join preparation: sealed scratch Hub + production directory driver + inert LDAP wire peer.
 * The caller redirects only loopback DC:636 to `directoryListening(port)` in its test connector.
 * TLS verification, LDAP BER, session/CSRF, group policy, SQLite and audit are production paths.
 * No fleet daemon, tmux, CLI, real account, directory or model endpoint is started.
 */
import Database from "better-sqlite3";
import yaml from "js-yaml";
import { createServer } from "node:net";
import { request } from "node:https";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubInitializer } from "../../src/hub/init/initializer.js";
import { hubIdentityProvider } from "../../src/hub/init/identity.js";
import { createHubServerFactory, type HubHttpDeps } from "../../src/hub/compose/server.js";
import { createHubDirectory } from "../../src/hub/directory/directory.js";
import { hubTxDatabase } from "../../src/hub/db.js";
import * as httpEntry from "../../src/hub/http/compose.js";
import type { HubGroupPolicy } from "../../src/hub/group-policy/model.js";
import { ADMIN, makeTestCerts, type TestCerts } from "./hub-init-fixtures.js";
import { directoryCertificates } from "./hub-directory-ca-fixture.js";
import { groupWirePeer, GROUP_A, GROUP_B, GROUP_DN, type GroupWireUser } from "./hub-group-directory-wire.js";

/** Immutable source material; the caller owns its lifetime, never a rig's mutable state. */
export interface CompanyJoinCertificates {
  host: string;
  web: TestCerts;
  directory: ReturnType<typeof directoryCertificates>;
}

export interface JoinBrowser { cookie: string; csrf: string }
export interface JoinHttpResult {
  status: number;
  body: any;
  text: string;
  cookie: string;
  headers: import("node:http").IncomingHttpHeaders;
}

/** Only dummy passwords. Mutable entries let tests change eligibility/membership across a held browser operation. */
export async function companyJoinRig(directoryListening: (port: number) => void, options: { host?: string; certificates?: CompanyJoinCertificates } = {}) {
  const host = options.host ?? "hub.example.test";
  if (options.certificates && options.certificates.host !== host) throw Error("Owned certificate hostname mismatch");
  const home = mkdtempSync(join(tmpdir(), "agend-company-join-"));
  chmodSync(home, 0o700);
  const cleanups: Array<() => void | Promise<void>> = [() => rmSync(home, { recursive: true, force: true })];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const dispose of cleanups.splice(0).reverse()) {
      try { await dispose(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Company-join fixture cleanup failed");
  };
  try {
    const certs = options.certificates?.web ?? makeTestCerts(host);
    if (!options.certificates) cleanups.push(() => rmSync(certs.dir, { recursive: true, force: true }));
    const dcCerts = options.certificates?.directory ?? directoryCertificates();
    if (!options.certificates) cleanups.push(dcCerts.cleanup);
    const people: GroupWireUser[] = [
      { id: ADMIN.key.objectId, login: "alice", dn: "CN=Alice,DC=example,DC=test", password: "Dummy-alice-only", groups: [GROUP_A] },
      { id: "22222222-2222-4222-8222-222222222222", login: "carol", dn: "CN=Carol,DC=example,DC=test", password: "Dummy-carol-only", groups: [GROUP_A] },
      { id: "33333333-3333-4333-8333-333333333333", login: "dan", dn: "CN=Dan,DC=example,DC=test", password: "Dummy-dan-only", groups: [GROUP_B] },
      { id: "44444444-4444-4444-8444-444444444444", login: "eve", dn: "CN=Eve,DC=example,DC=test", password: "Dummy-eve-only", eligible: false, groups: [GROUP_A] },
    ];
    const wire = await groupWirePeer(dcCerts.leaf, people); cleanups.push(wire.close);
    directoryListening(wire.port);
    // Reserve both addresses simultaneously: sequential probing can hand back the same port.
    const reservations: ReturnType<typeof createServer>[] = [];
    cleanups.push(async () => {
      for (const server of reservations) if (server.listening) await new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done()));
    });
    for (let i = 0; i < 2; i++) {
      const server = createServer(); reservations.push(server);
      await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    }
    const [memberPort, webPort] = reservations.map(server => (server.address() as { port: number }).port) as [number, number];
    await Promise.all(reservations.map(server => new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done()))));
    const webOrigin = `https://${host}:${webPort}`, memberOrigin = `https://${host}:${memberPort}`;
    const plan = {
      name: "Company-join test Hub", webOrigin, memberOrigin,
      webListen: { host: "127.0.0.1", port: webPort }, memberListen: { host: "127.0.0.1", port: memberPort },
      webTls: { certFile: certs.cert, keyFile: certs.key },
      directory: { realm: "corp", url: "ldaps://127.0.0.1:636", profile: "ad" as const, baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test" },
      bindPasswordRef: "file:hub/secrets/directory-bind", administrator: ADMIN.key,
      retention: { contentDays: 7, eventDays: 30 }, coexistence: "dedicated" as const,
    };
    const initializer = createHubInitializer({ home, identity: hubIdentityProvider(), probe: { pidAlive: () => false } });
    const confirmation = await initializer.prepareConfirmation(plan, { bindPassword: "Dummy-service-only" });
    await initializer.commit(plan, confirmation.reference);
    const config = (yaml.load(readFileSync(join(home, "fleet.yaml"), "utf8")) as { hub: Record<string, unknown> }).hub;
    let deps!: HubHttpDeps, directory!: ReturnType<typeof createHubDirectory>;
    const create = createHubServerFactory({ home,
      components: { http: async () => ({ migrations: httpEntry.migrations, createHubHttp(value) {
        deps = value; return httpEntry.createHubHttp(value, hubTxDatabase);
      } }) },
      createDirectory: (cfg, secrets) => directory = createHubDirectory({ ...cfg, caPem: dcCerts.ca }, secrets, { now: () => Date.now() }),
      report: () => {}, log: () => {}, now: () => Date.now(),
    });
    let service = await create(config, () => !closed); cleanups.push(() => service.close());
    await service.start();
    const db = new Database(join(home, "hub/hub.sqlite")); cleanups.push(() => { db.close(); });
    const call = (browser: JoinBrowser | null, method: string, path: string, body?: unknown,
      headers: Record<string, string | undefined> = {}): Promise<JoinHttpResult> => new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
      const requestHeaders: Record<string, string | number | undefined> = { Host: new URL(webOrigin).host, Origin: webOrigin,
        ...(browser ? { Cookie: browser.cookie, "X-AgEnD-Hub-CSRF": browser.csrf } : {}),
        ...(bytes === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes) }), ...headers };
      for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
      const machine = /^\/hub\/v1\/join\/(challenge|push|status|redeem|ack|cancel|tombstone)$/.test(path);
      const req = request({ host: "127.0.0.1", port: machine ? memberPort : webPort, path, servername: host,
        ca: machine ? readFileSync(join(home, "hub/keys/tls-cert.pem")) : readFileSync(certs.caCert),
        method, agent: false, headers: requestHeaders }, res => {
        let text = ""; res.setEncoding("utf8");
        res.on("data", chunk => { text += chunk; }); res.on("error", reject);
        res.on("end", () => {
          let body: unknown; try { body = JSON.parse(text); } catch { body = text; }
          resolve({ status: res.statusCode!, body, text, cookie: (res.headers["set-cookie"]?.[0] ?? "").split(";")[0]!, headers: res.headers });
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error(`Owned Hub fixture ${method} ${path.split("?")[0]} request timed out`)));
      req.on("error", reject); req.end(bytes);
    });
    const signIn = async (login: string): Promise<JoinBrowser> => {
      const user = people.find(p => p.login === login);
      if (!user) throw Error("Unknown fixture user");
      const result = await call(null, "POST", "/hub/v1/session", { login, password: user.password });
      if (result.status !== 200 || !result.cookie || typeof result.body.csrf !== "string") throw Error("Fixture sign-in refused");
      return { cookie: result.cookie, csrf: result.body.csrf };
    };
    const policyPath = "/hub/v1/admin/group-policy";
    const enable = async (admin: JoinBrowser, maxFleets = 1) => {
      const current = await call(admin, "GET", policyPath);
      if (current.status !== 200) throw Error("Fixture policy read refused");
      const policy: HubGroupPolicy = { ...current.body.policy, state: "enabled", groups: [{
        group: { realm: "corp", objectId: GROUP_A }, dn: GROUP_DN, allow: ["pair_fleet"], maxFleets,
      }] };
      const preview = await call(admin, "POST", `${policyPath}/preview`, { policy });
      if (preview.status !== 200) throw Error("Fixture policy preview refused");
      const saved = await call(admin, "PUT", policyPath, { policy, previewDigest: preview.body.previewDigest });
      if (saved.status !== 200) throw Error("Fixture policy save refused");
    };
    return { home, config, webOrigin, memberOrigin, certs, dcCerts, wire, people, get deps() { return deps; }, get directory() { return directory; }, db, call, signIn, enable,
      stopService: () => service.close(), async restartService() {
        if (closed) throw Error("Owned fixture is closed");
        await service.close(); service = await create(config, () => !closed); await service.start();
      }, close };
  } catch (error) { await close(); throw error; }
}
