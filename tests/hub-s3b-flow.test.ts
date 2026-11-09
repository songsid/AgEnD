/**
 * AgEnD Hub P1, S3b whole flow over S1's REAL transport (local TLS/WSS on 127.0.0.1, a scratch home under .artifacts,
 * a fake directory — no real organisation service, nothing privileged):
 *   the administrator makes a pairing code on the Hub web API → the member pairs → the owner confirms from her own Hub
 *   session → the administrator approves → the member claims and connects → it publishes its catalog snapshot →
 *   the owner grants an asker → the asker asks in a room → the Hub sends a signed question on the reconciled link →
 *   the member verifies it, takes admit/begin/release leases online, sends receipts and the answer → the asker reads it.
 * S5's DB/audit/content are the agreed fakes (tests/helpers/hub-s3b-rig.ts shapes); everything else is production code.
 */
import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { freeHubPort } from "./helpers/hub-rig.js";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { HubTransportStore, migrateHubTransportStore } from "../src/hub/store.js";
import { HubPairingService } from "../src/hub/pairing.js";
import { HubServer } from "../src/hub/server.js";
import { beginHubPairing, claimHubPairing } from "../src/hub/pairing-client.js";
import { HubMemberClient, type HubMemberLink } from "../src/hub/client.js";
import { readPrivateFile } from "../src/hub/private-files.js";
import { signAsker, verifyAsker, personKeyString } from "../src/hub/identity.js";
import { createHubHttp, HUB_HTTP_MIGRATIONS } from "../src/hub/http/compose.js";
import type { HubAuditRecord, HubDirectory, HubQuestion, HubTx, PersonKey } from "../src/hub/types.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

it("pairs, publishes, grants, asks, leases and answers end to end over S1's real TLS/WSS link", async () => {
  mkdirSync(".artifacts", { recursive: true });
  const root = mkdtempSync(join(process.cwd(), ".artifacts/hub-s3b-flow-")); chmodSync(root, 0o700);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const memberHome = join(root, "member"); mkdirSync(memberHome, { mode: 0o700 });
  const port = await freeHubPort(), memberOrigin = `https://127.0.0.1:${port}`, webOrigin = "https://hub-web.example.test";
  const identity = await provisionHubIdentity({ home: root, memberOrigin });
  const issuerKey = createPrivateKey(readPrivateFile(root, "hub/keys/issuer-key.pem"));

  // S5 (faked as agreed): the DB with every migration, unit of work, audit, content.
  const db = new Database(join(root, "hub.sqlite")); chmodSync(join(root, "hub.sqlite"), 0o600);
  cleanup.push(() => { db.close(); });
  migrateHubTransportStore(db); for (const m of HUB_HTTP_MIGRATIONS) m.up(db);
  db.exec("CREATE TABLE audit_rows (value TEXT NOT NULL)");
  const live = new WeakMap<HubTx, Database.Database>(), audits: HubAuditRecord[] = [], contents = new Map<string, { question?: string; answer?: string }>();
  const uow = { atomic<T>(work: (tx: HubTx) => T): T { return db.transaction(() => { const tx = { id: randomUUID() }; live.set(tx, db); try { return work(tx); } finally { live.delete(tx); } }).immediate(); } };
  const sql = (tx: HubTx) => { const d = live.get(tx); if (!d) throw new Error("tx is not running"); return d; };
  const audit = { append(tx: HubTx, r: HubAuditRecord) { sql(tx).prepare("INSERT INTO audit_rows VALUES(?)").run(JSON.stringify(r)); audits.push(r); }, async read() { return []; }, async readContent(): Promise<never> { throw new Error("n/a"); } };
  const content = { put(tx: HubTx, p: { question?: string; answer?: string }) { sql(tx); const ref = randomBytes(16).toString("hex"); contents.set(ref, p); return ref; }, get: (ref: string) => contents.get(ref) };
  let floor = 0;
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: (n) => { floor = n; } }, appendAudit: (r, d) => { d.prepare("INSERT INTO audit_rows VALUES(?)").run(JSON.stringify(r)); } });
  store.initialize();

  // The directory: three people.
  const people = new Map<string, PersonKey>();
  for (const login of ["admin", "olivia", "alex"]) people.set(login, { realm: "corp", objectId: randomUUID() });
  const directory: HubDirectory = { realm: "corp",
    async signIn(login, password) { const key = people.get(login); return key && password === `pw-${login}` ? { ok: true, person: { key, login, dn: "private", displayName: login, groups: [] } } : { ok: false, reason: "invalid-credentials" }; },
    async checkEligibility(key) { const login = [...people].find(([, k]) => personKeyString(k) === personKeyString(key))?.[0]; return login ? { eligible: true, person: { key, login, dn: "private", groups: [] } } : { eligible: false, reason: "gone" }; },
    async close() {} };

  let enabled = true, server!: HubServer;
  const pairing = new HubPairingService({ store, directory, enabled: () => enabled, fenceFleet: (id, reason) => server?.fenceFleet(id, reason),
    identity: { hubId: identity.hubId, memberOrigin, webOrigin, spkiSha256: identity.spkiSha256, issuerPublicKey: identity.issuerPublicKey } });
  const http = createHubHttp({ uow, audit, directory, pairing, store, content, current: () => ({ serverEnabled: () => enabled, memberEnabled: () => false, epoch: () => 0 }), transport: () => (enabled ? server : null),
    config: Object.freeze({ hubId: identity.hubId, name: "Team Hub", memberOrigin, webOrigin, administrator: people.get("admin")! }),
    issuer: { keyId: identity.issuerKeyId, sign: (e) => signAsker(e, issuerKey) } }, sql);
  server = new HubServer({ home: root, hubId: identity.hubId, memberOrigin, listen: { host: "127.0.0.1", port }, pairing,
    current: () => enabled, hold: () => {}, receive: (frame, link) => http.receive(frame, link) });
  await server.start();
  cleanup.push(() => server.close());
  const web: Server = createServer((req, res) => { if (!http.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => web.close(() => resolve())));
  const base = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
  const browser = async (login: string) => {
    const r = await fetch(`${base}/hub/v1/session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: webOrigin }, body: JSON.stringify({ login, password: `pw-${login}` }) });
    expect(r.status).toBe(200);
    const csrf = ((await r.json()) as { csrf: string }).csrf, cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method, headers: { Origin: webOrigin, Cookie: cookie, "X-AgEnD-Hub-CSRF": csrf, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json() as any };
    };
  };
  const admin = await browser("admin"), olivia = await browser("olivia"), alex = await browser("alex");

  // Pairing: code from the administrator, the owner's own confirmation, the administrator's approval of that fingerprint.
  const offer = await admin("POST", "/hub/v1/admin/pairings", { login: "olivia" });
  expect(offer.status).toBe(200);
  const pending = await beginHubPairing({ home: memberHome, memberOrigin, code: offer.json.code, current: () => enabled });
  expect((await olivia("POST", `/hub/v1/pairings/${pending.pairingId}/confirm`, { fingerprint: pending.fingerprint })).status).toBe(200);
  expect((await admin("POST", `/hub/v1/admin/pairings/${pending.pairingId}/approve`, { fingerprint: pending.fingerprint })).status).toBe(200);
  await claimHubPairing({ home: memberHome, hubId: identity.hubId, approvedFingerprint: pending.fingerprint, expectedProfileDigest: null, current: () => enabled });

  // The member: publishes its owner-consented catalog, reconciles, then answers what it is sent — leases taken online.
  const owner = people.get("olivia")!;
  const exposureId = randomUUID();
  let link: HubMemberLink | null = null, memberSeq = 0;
  const seen: HubQuestion[] = [];
  const member = new HubMemberClient({ home: memberHome, hubId: identity.hubId, memberOrigin, current: () => enabled, hold: () => {}, random: () => 0,
    reconcile: async (l) => {
      link = l;
      await l.send({ v: 1, type: "exposure.snapshot", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload: { revision: 1, exposures: [{ id: exposureId,
        fleetId: l.profile.fleetId, owner, displayName: "Sales numbers", revision: 1, state: "published", dataViewId: "sales-q3", allowedTools: ["read_sheet"], policyDigest: "b".repeat(64) }] } });
      await l.exchange({ v: 1, type: "reconcile", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload: { afterReceiptSequence: 0, messages: [] } }, "reconcile");
    },
    receive: async (frame, l) => {
      if (frame.type !== "question") return;
      const q = frame.payload as HubQuestion, e = q.identity;
      verifyAsker(e, q.text, { hubId: identity.hubId, issuerKeyId: identity.issuerKeyId, issuerPublicKey: createPublicKey(identity.issuerPublicKey),
        fleetId: l.profile.fleetId, owner, revocationVersion: l.revocationVersion, now: Date.now() });
      seen.push(q);
      const op = async (phase: "admit" | "begin") => member.authorize({ messageId: e.messageId, operationId: randomUUID(), exposureRevision: e.exposureRevision, phase });
      await op("admit");
      await l.exchange({ v: 1, type: "receipt", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload: { messageId: e.messageId, contentDigest: e.contentDigest, stage: "delivered", sequence: ++memberSeq, at: Date.now() } }, "receipt");
      await op("begin");
      const answerId = randomUUID(), text = "Q3 sales were 42.";
      const releaseLease = await member.authorize({ messageId: e.messageId, operationId: randomUUID(), exposureRevision: e.exposureRevision, phase: "release-answer", answer: { answerId, contentDigest: sha(text) } });
      await l.exchange({ v: 1, type: "answer", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload: { messageId: e.messageId, answerId, text, contentDigest: sha(text), releaseLease } }, "receipt");
    } });
  cleanup.push(() => member.close());
  await member.start();
  expect(link).not.toBeNull();

  // The owner sees her exposure (mirrored from the snapshot) and grants the asker on its exact revision.
  await vi.waitFor(async () => expect((await olivia("GET", "/hub/v1/exposures")).json.mine).toHaveLength(1));
  const g = await olivia("POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "alex", days: 1 });
  expect(g.status).toBe(200);
  const cat = await alex("GET", "/hub/v1/exposures");
  expect(cat.json.askable.map((x: any) => x.exposure.displayName)).toEqual(["Sales numbers"]);
  const room = await alex("POST", "/hub/v1/rooms", { exposureId, grantId: g.json.grant.id });
  const ask = await alex("POST", `/hub/v1/rooms/${room.json.room.id}/messages`, { idempotencyKey: randomUUID(), text: "What were Q3 sales?" });
  expect(ask.json.receipt.stage).toBe("queued");

  await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5_000 });
  expect(seen[0]!.identity).toMatchObject({ messageId: ask.json.receipt.messageId, exposureId, owner, asker: people.get("alex"), destinationFleetId: link!.profile.fleetId });
  await vi.waitFor(() => expect(db.prepare("SELECT stage FROM hub_messages").get()).toEqual({ stage: "answered" }), { timeout: 5_000 });
  const read = await alex("GET", `/hub/v1/rooms/${room.json.room.id}/messages`);
  expect(read.json.entries).toEqual([expect.objectContaining({ question: "What were Q3 sales?", answer: "Q3 sales were 42.", receipt: expect.objectContaining({ stage: "answered" }) })]);
  // Provenance: the question, the leases and the answer are all in the audit, the answer under its own content ref.
  const actions = audits.map((a) => a.action);
  for (const a of ["question.accepted", "question.sent", "authorize.admit", "receipt.delivered", "authorize.begin", "authorize.release-answer", "answer.accepted"]) expect(actions, a).toContain(a);
  expect(audits.find((a) => a.action === "answer.accepted")!.contentRef).toMatch(/^[a-f0-9]{32}$/);
  // The asker's text never sits in S3's tables (only S5's content refs).
  expect(JSON.stringify(db.prepare("SELECT * FROM hub_messages").all())).not.toContain("Q3 sales");
});
