/** Sealed Hub, real HTTPS/member protocol/SQLite, owned synthetic LDAPS and a scratch Fleet. */
import { afterEach, expect, it, vi } from "vitest";
const dc = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:tls", async original => { const real = await original<typeof import("node:tls")>(); return { ...real,
  connect: (o: import("node:tls").ConnectionOptions, callback?: () => void) => real.connect({ ...o,
    ...(o.host === "127.0.0.1" && o.port === 636 ? { port: dc.port } : {}),
    ...(o.host === "hub.example.test" ? { host: "127.0.0.1" } : {}) }, callback) }; });
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { makeTestCerts } from "./support/hub-init-fixtures.js";
import { directoryCertificates } from "./support/hub-directory-ca-fixture.js";
import { companyJoinRig } from "./support/hub-company-join-rig.js";
import { CompanyJoinClient } from "../src/hub/join/client.js";
import { CompanyJoinController } from "../src/hub/join/local.js";
import { readLocalJoin } from "../src/hub/join/local-journal.js";
import { sha256 } from "../src/hub/identity.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const done of cleanup.splice(0).reverse()) await done(); });
it("a self-signed Hub joins a Fleet by code after the one explicit trust choice, through real redeem and ACK", async () => {
  const certs = makeTestCerts(), directory = directoryCertificates();
  cleanup.push(() => { directory.cleanup(); rmSync(certs.dir, { recursive: true, force: true }); });
  const web = { ...certs, cert: certs.selfSigned, key: join(certs.dir, "self.key"), caCert: certs.selfSigned };
  const r = await companyJoinRig(port => { dc.port = port; }, { certificates: { host: "hub.example.test", web, directory } }); cleanup.push(r.close);
  const admin = await r.signIn("alice");
  expect((await r.call(admin, "PUT", "/hub/v1/admin/company-join", { enabled: true, expectedRevision: 1 })).status).toBe(200);
  const made = await r.call(admin, "POST", "/hub/v1/admin/enrolment-codes", { expires: "today", maxUses: 30, perPersonFleets: 1, scope: { kind: "directory" } });
  expect(made.status, made.text).toBe(201);
  const home = mkdtempSync(join(tmpdir(), "agend-pilot-joined-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  let membership = false;
  const controller = new CompanyJoinController({ home, schedule: false, pilotTrustEnabled: () => true,
    client: new CompanyJoinClient({ lookup: (_host, o, done) => o.all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4) }),
    snapshot: () => ({ membership, binding: existsSync(join(home, "hub-member/state.json")) ? sha256(readFileSync(join(home, "hub-member/state.json"))) : null }),
    enableMembership: (current, accept) => { if (!current()) throw Error("stale"); membership = true; accept(); }, activate() {}, link: () => "offline" });
  cleanup.push(() => controller.close());
  const session = { ownerKey: {}, sessionId: "b".repeat(64), authorityEpoch: 1, hostHere: true, current: () => true, fleetOrigin: "http://localhost:12345" };
  const input = { address: r.webOrigin, fleetOrigin: session.fleetOrigin };
  expect(await controller.probe(input, session)).toMatchObject({ ok: false, reason: "certificate", selfSigned: true });
  const fingerprint = sha256(new X509Certificate(readFileSync(web.cert)).raw);
  const started = await controller.start({ ...input, label: "Pilot Fleet", code: made.body.code, trust: { fingerprint, previous: null } }, { session, confirmedCurrent: () => true });
  expect(started).toMatchObject({ state: "awaiting-sign-in" });
  const record = readLocalJoin(home, started.operationId);
  const opened = await r.call(null, "POST", "/hub/join/open", new URLSearchParams({ requestId: record.binding.requestId, state: record.browserState }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded", Origin: input.fleetOrigin });
  expect(opened.status).toBe(303);
  const carol = await r.signIn("carol"), browser = { ...carol, cookie: carol.cookie + "; " + opened.cookie };
  const approved = await r.call(browser, "POST", "/hub/v1/join/approve", { requestId: record.binding.requestId });
  expect(approved.status, approved.text).toBe(200);
  expect(await controller.status(started.operationId, session)).toMatchObject({ state: "saved", issued: true, outcomeKnown: true });
  expect(membership).toBe(true); expect(r.deps.store.read().fleets).toHaveLength(1);
  expect(readLocalJoin(home, started.operationId)).toMatchObject({ stage: "active" });
  expect(r.db.prepare("SELECT stage FROM hub_company_join_requests WHERE id=?").get(record.binding.requestId)).toEqual({ stage: "acknowledged" });
}, 30_000);
