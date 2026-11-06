/**
 * #3226 PR D, attachments both ways, over S1's REAL transport (local TLS/WSS, scratch home, fake directory):
 *   the asker uploads files → asks with them → the Hub sends the question with its file refs (bound in the signed
 *   digest) on an attachments-v1 link → the member pulls each file in chunks and checks it → answers with its own file,
 *   pushed in chunks before the answer → the asker reads both directions and downloads them (attachment, nosniff,
 *   sandbox), every step audited. Mixed versions: an older member or an older Hub turns files off, visibly.
 * S5's DB/audit/content are the agreed fakes (as in hub-s3b-flow); the attachment store and everything else is production.
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
import { messageContentDigest, signAsker, verifyAsker, personKeyString } from "../src/hub/identity.js";
import { createHubHttp, HUB_HTTP_MIGRATIONS } from "../src/hub/http/compose.js";
import { HUB_ATTACHMENTS_MIGRATION, HubAttachmentStore } from "../src/hub/attachments/store.js";
import { HUB_ATTACHMENT_CHUNK } from "../src/hub/protocol.js";
import type { HubAttachmentRef, HubAuditRecord, HubDirectory, HubQuestion, HubTx, PersonKey } from "../src/hub/types.js";

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2 * HUB_ATTACHMENT_CHUNK + 1234)]);
const CSV = Buffer.from("region,sales\n" + "north,42\n".repeat(30_000));

async function world(opts: { memberCapabilities?: readonly string[]; hubCapabilities?: readonly string[]; answer?: "file" | "text" } = {}) {
  mkdirSync(".artifacts", { recursive: true });
  const root = mkdtempSync(join(process.cwd(), ".artifacts/hub-attach-")); chmodSync(root, 0o700);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const memberHome = join(root, "member"); mkdirSync(memberHome, { mode: 0o700 });
  const port = await freeHubPort(), memberOrigin = `https://127.0.0.1:${port}`, webOrigin = "https://hub-web.example.test";
  const identity = await provisionHubIdentity({ home: root, memberOrigin });
  const issuerKey = createPrivateKey(readPrivateFile(root, "hub/keys/issuer-key.pem"));
  const db = new Database(join(root, "hub.sqlite")); chmodSync(join(root, "hub.sqlite"), 0o600);
  cleanup.push(() => { db.close(); });
  migrateHubTransportStore(db); for (const m of HUB_HTTP_MIGRATIONS) m.up(db); HUB_ATTACHMENTS_MIGRATION.up(db);
  db.exec("CREATE TABLE audit_rows (value TEXT NOT NULL)");
  const live = new WeakMap<HubTx, Database.Database>(), audits: HubAuditRecord[] = [], contents = new Map<string, { question?: string; answer?: string }>();
  const uow = { atomic<T>(work: (tx: HubTx) => T): T { return db.transaction(() => { const tx = { id: randomUUID() }; live.set(tx, db); try { return work(tx); } finally { live.delete(tx); } }).immediate(); } };
  const sql = (tx: HubTx) => { const d = live.get(tx); if (!d) throw new Error("tx is not running"); return d; };
  const audit = { append(tx: HubTx, r: HubAuditRecord) { sql(tx).prepare("INSERT INTO audit_rows VALUES(?)").run(JSON.stringify(r)); audits.push(r); }, async read() { return []; }, async readContent(): Promise<never> { throw new Error("n/a"); } };
  const content = { put(tx: HubTx, p: { question?: string; answer?: string }) { sql(tx); const ref = randomBytes(16).toString("hex"); contents.set(ref, p); return ref; }, get: (ref: string) => contents.get(ref) };
  let floor = 0;
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: (n) => { floor = n; } }, appendAudit: (r, d) => { d.prepare("INSERT INTO audit_rows VALUES(?)").run(JSON.stringify(r)); } });
  store.initialize();
  const attachments = new HubAttachmentStore({ contentKey: randomBytes(32) });
  const people = new Map<string, PersonKey>();
  for (const login of ["admin", "olivia", "alex"]) people.set(login, { realm: "corp", objectId: randomUUID() });
  const directory: HubDirectory = { realm: "corp",
    async signIn(login, password) { const key = people.get(login); return key && password === `pw-${login}` ? { ok: true, person: { key, login, dn: "private", displayName: login, groups: [] } } : { ok: false, reason: "invalid-credentials" }; },
    async checkEligibility(key) { const login = [...people].find(([, k]) => personKeyString(k) === personKeyString(key))?.[0]; return login ? { eligible: true, person: { key, login, dn: "private", groups: [] } } : { eligible: false, reason: "gone" }; },
    async close() {} };
  let enabled = true, server!: HubServer;
  const pairing = new HubPairingService({ store, directory, enabled: () => enabled, fenceFleet: (id, reason) => server?.fenceFleet(id, reason),
    identity: { hubId: identity.hubId, memberOrigin, webOrigin, spkiSha256: identity.spkiSha256, issuerPublicKey: identity.issuerPublicKey } });
  const http = createHubHttp({ uow, audit, directory, pairing, store, content, attachments, current: () => ({ serverEnabled: () => enabled, memberEnabled: () => false, epoch: () => 0 }), transport: () => (enabled ? server : null),
    config: Object.freeze({ hubId: identity.hubId, name: "Team Hub", webOrigin, administrator: people.get("admin")! }),
    issuer: { keyId: identity.issuerKeyId, sign: (e) => signAsker(e, issuerKey) } }, sql);
  server = new HubServer({ home: root, hubId: identity.hubId, memberOrigin, listen: { host: "127.0.0.1", port }, pairing,
    ...(opts.hubCapabilities ? { capabilities: opts.hubCapabilities } : {}), current: () => enabled, hold: () => {}, receive: (frame, link) => http.receive(frame, link) });
  await server.start(); cleanup.push(() => server.close());
  const web: Server = createServer((req, res) => { if (!http.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => web.close(() => resolve())));
  const base = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
  const browser = async (login: string) => {
    const r = await fetch(`${base}/hub/v1/session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: webOrigin }, body: JSON.stringify({ login, password: `pw-${login}` }) });
    const csrf = ((await r.json()) as { csrf: string }).csrf, cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
    const call = async (method: string, path: string, body?: unknown, raw?: { bytes: Buffer; name: string; headers?: Record<string, string> }) => {
      const res = await fetch(`${base}${path}`, { method, headers: { Origin: webOrigin, Cookie: cookie, "X-AgEnD-Hub-CSRF": csrf,
        ...(raw ? { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(raw.name), ...raw.headers } : body ? { "Content-Type": "application/json" } : {}) },
        body: raw ? new Uint8Array(raw.bytes) : body ? JSON.stringify(body) : undefined });
      const buf = Buffer.from(await res.arrayBuffer());
      let json: any = null; try { json = JSON.parse(buf.toString("utf8")); } catch { /* bytes */ }
      return { status: res.status, json, buf, headers: res.headers };
    };
    return call;
  };
  const admin = await browser("admin"), olivia = await browser("olivia"), alex = await browser("alex");
  const offer = await admin("POST", "/hub/v1/admin/pairings", { login: "olivia" });
  const pending = await beginHubPairing({ home: memberHome, memberOrigin, code: offer.json.code, current: () => enabled });
  await olivia("POST", `/hub/v1/pairings/${pending.pairingId}/confirm`, { fingerprint: pending.fingerprint });
  await admin("POST", `/hub/v1/admin/pairings/${pending.pairingId}/approve`, { fingerprint: pending.fingerprint });
  await claimHubPairing({ home: memberHome, hubId: identity.hubId, approvedFingerprint: pending.fingerprint, expectedProfileDigest: null, current: () => enabled });

  // The member: a minimal answerer that pulls files, checks them against the signed digest, and answers (with a file).
  const owner = people.get("olivia")!, exposureId = randomUUID();
  let link: HubMemberLink | null = null, memberSeq = 0;
  const seen: { q: HubQuestion; files: Buffer[] }[] = [];
  const member = new HubMemberClient({ home: memberHome, hubId: identity.hubId, memberOrigin, current: () => enabled, hold: () => {}, random: () => 0,
    ...(opts.memberCapabilities ? { capabilities: opts.memberCapabilities } : {}),
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
        fleetId: l.profile.fleetId, owner, revocationVersion: l.revocationVersion, now: Date.now() }, q.attachments);
      const files: Buffer[] = [];
      for (const f of q.attachments ?? []) {
        const parts: Buffer[] = [];
        for (let offset = 0; offset < f.size;) {
          const c = await l.exchange({ v: 1, type: "attachment.get", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload: { id: f.id, offset } }, "attachment.chunk") as any;
          const data = Buffer.from(c.payload.data, "base64"); parts.push(data); offset += data.length;
        }
        files.push(Buffer.concat(parts));
      }
      seen.push({ q, files });
      const op = (phase: "admit" | "begin") => member.authorize({ messageId: e.messageId, operationId: randomUUID(), exposureRevision: e.exposureRevision, phase });
      await op("admit");
      await l.exchange({ v: 1, type: "receipt", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload: { messageId: e.messageId, contentDigest: e.contentDigest, stage: "delivered", sequence: ++memberSeq, at: Date.now() } }, "receipt");
      await op("begin");
      let refs: HubAttachmentRef[] | undefined;
      if (opts.answer !== "text") {
        const ref: HubAttachmentRef = { id: randomUUID(), name: "q3-by-region.csv", size: CSV.length, mime: "text/csv", sha256: sha(CSV) };
        for (let offset = 0; offset < CSV.length; offset += HUB_ATTACHMENT_CHUNK)
          await l.exchange({ v: 1, type: "attachment.put", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload: { id: ref.id, offset, total: ref.size, sha256: ref.sha256, data: CSV.subarray(offset, offset + HUB_ATTACHMENT_CHUNK).toString("base64") } }, "attachment.ack");
        refs = [ref];
      }
      const answerId = randomUUID(), text = "Q3 sales were 42; by region attached.", contentDigest = messageContentDigest("answer", text, { attachments: refs });
      const releaseLease = await member.authorize({ messageId: e.messageId, operationId: randomUUID(), exposureRevision: e.exposureRevision, phase: "release-answer", answer: { answerId, contentDigest } });
      await l.exchange({ v: 1, type: "answer", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload: { messageId: e.messageId, answerId, text, contentDigest, releaseLease, ...(refs ? { attachments: refs } : {}) } }, "receipt");
    } });
  cleanup.push(() => member.close());
  await member.start();
  await vi.waitFor(async () => expect((await olivia("GET", "/hub/v1/exposures")).json.mine).toHaveLength(1));
  const g = await olivia("POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "alex", days: 1 });
  const room = (await alex("POST", "/hub/v1/rooms", { exposureId, grantId: g.json.grant.id })).json.room;
  return { db, audits, alex, olivia, room, seen, link: () => link, attachments };
}

it("both directions end to end: upload → signed question with files → member pulls and checks → answer with a file → asker downloads", async () => {
  const w = await world();
  expect(w.room.features).toEqual(["attachments-v1"]);
  const png = await w.alex("POST", `/hub/v1/rooms/${w.room.id}/files`, undefined, { bytes: PNG, name: "chart.png" });
  expect(png.status).toBe(200);
  expect(png.json.file).toMatchObject({ name: "chart.png", size: PNG.length, mime: "image/png", url: `/hub/v1/rooms/${w.room.id}/files/${png.json.file.id}` });
  const ask = await w.alex("POST", `/hub/v1/rooms/${w.room.id}/messages`, { idempotencyKey: randomUUID(), text: "What were Q3 sales? Chart attached.", files: [png.json.file.id] });
  expect(ask.json.receipt.stage).toBe("queued");

  await vi.waitFor(() => expect(w.seen).toHaveLength(1), { timeout: 10_000 });
  const got = w.seen[0]!;
  expect(got.q.attachments).toEqual([expect.objectContaining({ id: png.json.file.id, name: "chart.png", size: PNG.length, mime: "image/png", sha256: sha(PNG) })]);
  expect(got.files[0]!.equals(PNG)).toBe(true);                      // 3 chunks, reassembled exactly
  expect(got.q.identity.contentDigest).toBe(messageContentDigest("question", got.q.text, { attachments: got.q.attachments }));

  await vi.waitFor(() => expect(w.db.prepare("SELECT stage FROM hub_messages").get()).toEqual({ stage: "answered" }), { timeout: 10_000 });
  const read = await w.alex("GET", `/hub/v1/rooms/${w.room.id}/messages`);
  const entry = read.json.entries[0];
  expect(entry.files.question).toEqual([expect.objectContaining({ id: png.json.file.id, name: "chart.png", mime: "image/png" })]);
  expect(entry.files.answer).toEqual([expect.objectContaining({ name: "q3-by-region.csv", size: CSV.length, mime: "text/csv" })]);

  const dl = await w.alex("GET", entry.files.answer[0].url);
  expect(dl.status).toBe(200); expect(dl.buf.equals(CSV)).toBe(true);
  expect(dl.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''q3-by-region.csv");
  expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
  expect(dl.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  // Inline only for a magic-checked image, and only when asked.
  expect((await w.alex("GET", `${entry.files.answer[0].url}?inline=1`)).headers.get("content-disposition")).toMatch(/^attachment;/);
  expect((await w.alex("GET", `${entry.files.question[0].url}?inline=1`)).headers.get("content-disposition")).toMatch(/^inline;/);
  // Someone else (the owner) cannot read the asker's room's files.
  expect((await w.olivia("GET", entry.files.answer[0].url)).status).toBe(404);

  const actions = w.audits.map(a => a.action);
  expect(actions.filter(a => a === "file.upload")).toHaveLength(1);
  expect(actions.filter(a => a === "file.transfer")).toHaveLength(2);    // question → member, answer → Hub
  expect(actions.filter(a => a === "file.read")).toHaveLength(3);
  // Stored encrypted: no plaintext bytes in the database.
  const segments = w.db.prepare("SELECT ciphertext FROM hub_attachment_segments").all() as { ciphertext: Buffer }[];
  expect(segments.length).toBeGreaterThanOrEqual(5);
  expect(segments.some(s => s.ciphertext.includes(Buffer.from("north,42")) || s.ciphertext.includes(PNG.subarray(0, 64)))).toBe(false);
});

it("refused types and lookalike images never become files", async () => {
  const w = await world();
  const svg = await w.alex("POST", `/hub/v1/rooms/${w.room.id}/files`, undefined, { bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), name: "logo.svg" });
  expect(svg.status).toBe(415); expect(svg.json.code).toBe("type-not-allowed");
  const fake = await w.alex("POST", `/hub/v1/rooms/${w.room.id}/files`, undefined, { bytes: Buffer.from("not a png"), name: "x.png" });
  expect(fake.status).toBe(415); expect(fake.json.code).toBe("image-mismatch");
  const exe = await w.alex("POST", `/hub/v1/rooms/${w.room.id}/files`, undefined, { bytes: Buffer.from("MZ"), name: "tool.exe" });
  expect(exe.status).toBe(415);
  const big = await w.alex("POST", `/hub/v1/rooms/${w.room.id}/files`, undefined, { bytes: Buffer.alloc(20 * 1024 * 1024 + 1, 1), name: "big.txt" });
  expect(big.status).toBe(413);
  expect(w.db.prepare("SELECT COUNT(*) AS n FROM hub_attachments").get()).toEqual({ n: 0 });
  // Another room's file, or an unknown id, cannot be attached.
  const ok = await w.alex("POST", `/hub/v1/rooms/${w.room.id}/files`, undefined, { bytes: Buffer.from("a,b\n"), name: "t.csv" });
  expect((await w.alex("POST", `/hub/v1/rooms/${w.room.id}/messages`, { idempotencyKey: randomUUID(), text: "hi", files: [randomUUID()] })).status).toBe(404);
  // A file is used once: the second question naming it is refused.
  expect((await w.alex("POST", `/hub/v1/rooms/${w.room.id}/messages`, { idempotencyKey: randomUUID(), text: "one", files: [ok.json.file.id] })).status).toBe(200);
  expect((await w.alex("POST", `/hub/v1/rooms/${w.room.id}/messages`, { idempotencyKey: randomUUID(), text: "two", files: [ok.json.file.id] })).status).toBe(404);
});

it.each([["an older member", { memberCapabilities: ["welcome-caps-v1"] }], ["an older Hub link (offers nothing)", { hubCapabilities: [] as string[] }]] as const)(
  "%s: the room says files are off, an upload is refused, and a text question still works", async (_who, opts) => {
    const w = await world({ ...opts, answer: "text" });
    expect(w.room.features).toEqual([]);
    expect(w.link()!.features.has("attachments-v1")).toBe(false);
    const up = await w.alex("POST", `/hub/v1/rooms/${w.room.id}/files`, undefined, { bytes: Buffer.from("a,b\n"), name: "t.csv" });
    expect(up.status).toBe(400); expect(up.json.code).toBe("incompatible");
    await w.alex("POST", `/hub/v1/rooms/${w.room.id}/messages`, { idempotencyKey: randomUUID(), text: "Plain question" });
    await vi.waitFor(() => expect(w.db.prepare("SELECT stage FROM hub_messages").get()).toEqual({ stage: "answered" }), { timeout: 10_000 });
    expect(w.seen[0]!.q).not.toHaveProperty("attachments");
  });
