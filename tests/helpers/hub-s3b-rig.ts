/**
 * A rig for AgEnD Hub S3b (createHubHttp) with S5's pieces faked as agreed on cid-hub-s3b-deps:
 * - the unit of work and `hubTxDatabase` (valid only inside `atomic`);
 * - an audit sink that writes inside the caller's transaction (and can be made to fail);
 * - a content store with S5-chosen refs.
 * S1's real HubTransportStore and HubPairingService, a fake directory, a real Ed25519 issuer, and a fake transport
 * that records frames. Nothing listens except the test's own HTTP server on 127.0.0.1.
 */
import Database from "better-sqlite3";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { HubTransportStore, migrateHubTransportStore } from "../../src/hub/store.js";
import { HubPairingService } from "../../src/hub/pairing.js";
import { signAsker, issuerKeyId, personKeyString } from "../../src/hub/identity.js";
import { createHubHttp, HUB_HTTP_MIGRATIONS } from "../../src/hub/http/compose.js";
import { HUB_ATTACHMENTS_MIGRATION, HubAttachmentStore } from "../../src/hub/attachments/store.js";
import type { HubAuditRecord, HubDirectory, HubServerFrame, HubTx, PersonKey } from "../../src/hub/types.js";
import type { HubLinkContext } from "../../src/hub/server.js";

export const WEB_ORIGIN = "https://hub.example.test";
export const person = (): PersonKey => ({ realm: "corp", objectId: randomUUID() });

export async function s3bRig(opts: { now?: () => number; webOrigin?: string; administrator?: PersonKey; attachments?: boolean;
  /** #3226 E: what the Hub shell says about previews (hubPreviewView); the smoke serves the /frame listener itself. */
  preview?: Readonly<import("../../src/hub/preview.js").HubPreviewView> } = {}) {
  const webOrigin = opts.webOrigin ?? WEB_ORIGIN;
  const db = new Database(":memory:");
  migrateHubTransportStore(db);
  for (const m of HUB_HTTP_MIGRATIONS) m.up(db);
  if (opts.attachments) HUB_ATTACHMENTS_MIGRATION.up(db);
  const attachments = opts.attachments ? new HubAttachmentStore({ contentKey: randomBytes(32), ...(opts.now ? { now: opts.now } : {}) }) : undefined;
  db.exec("CREATE TABLE audit_rows (value TEXT NOT NULL)");
  const live = new WeakMap<HubTx, Database.Database>();
  let auditFails = false;
  let auditFailAction: string | undefined;
  const audits: HubAuditRecord[] = [];
  const uow = {
    atomic<T>(work: (tx: HubTx) => T): T {
      return db.transaction(() => {
        const tx: HubTx = { id: randomUUID() };
        live.set(tx, db);
        try { return work(tx); } finally { live.delete(tx); }
      }).immediate();
    },
  };
  const sql = (tx: HubTx) => { const d = live.get(tx); if (!d) throw new Error("tx is not running"); return d; };
  const audit = {
    append(tx: HubTx, record: HubAuditRecord) {
      if (auditFails && (!auditFailAction || auditFailAction === record.action)) throw new Error("disk full");
      sql(tx).prepare("INSERT INTO audit_rows VALUES(?)").run(JSON.stringify(record));
      audits.push(record);
    },
    async read() { return []; },
    async readContent(): Promise<never> { throw new Error("not in this rig"); },
  };
  const contents = new Map<string, { question?: string; answer?: string }>();
  const content = {
    put(tx: HubTx, payload: { question?: string; answer?: string }) { sql(tx); const ref = randomBytes(16).toString("hex"); contents.set(ref, { ...payload }); return ref; },
    get(ref: string) { const v = contents.get(ref); return v ? { ...v } : undefined; },
  };
  let floor = 0;
  const store = new HubTransportStore(db, { floor: { read: () => floor, raise: (n) => { floor = n; } },
    appendAudit: (record, d) => { d.prepare("INSERT INTO audit_rows VALUES(?)").run(JSON.stringify(record)); } });
  store.initialize();

  // The directory: people by login with a password; eligibility switchable per person.
  const people = new Map<string, { key: PersonKey; login: string; password: string; name: string; eligible: boolean }>();
  let directoryCalls = 0;
  const directory: HubDirectory = {
    realm: "corp",
    async signIn(login, password) {
      const p = [...people.values()].find((x) => x.login.toLowerCase() === login.toLowerCase());
      if (!p || p.password !== password) return { ok: false, reason: "invalid-credentials" };
      if (!p.eligible) return { ok: false, reason: "not-eligible" };
      return { ok: true, person: { key: p.key, login: p.login, dn: "private", displayName: p.name, groups: [] } };
    },
    async checkEligibility(key) {
      directoryCalls++;
      const p = [...people.values()].find((x) => personKeyString(x.key) === personKeyString(key));
      return p && p.eligible ? { eligible: true, person: { key: p.key, login: p.login, dn: "private", groups: [] } } : { eligible: false, reason: "disabled" };
    },
    async close() {},
  };
  const addPerson = (login: string, name = login, key = person()) => { people.set(login, { key, login, password: `pw-${login}`, name, eligible: true }); return key; };
  const admin = addPerson("admin", "Hub Admin", opts.administrator);

  const hubId = randomUUID();
  const keys = generateKeyPairSync("ed25519");
  const issuer = { keyId: issuerKeyId(keys.publicKey), sign: (e: Parameters<typeof signAsker>[0]) => signAsker(e, keys.privateKey) };
  let enabled = true;
  const sent: { fleetId: string; frame: HubServerFrame }[] = [];
  let transportOn = true, sendFails = false;
  const transport = { start: async () => {}, close: async () => {},
    send: async (fleetId: string, frame: HubServerFrame) => { if (sendFails) throw new Error("not ready"); sent.push({ fleetId, frame }); } };
  const pairing = new HubPairingService({ store, directory, enabled: () => enabled,
    identity: { hubId, memberOrigin: "https://127.0.0.1:9", webOrigin, spkiSha256: "a".repeat(64), issuerPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() },
    fenceFleet: () => {}, now: opts.now });
  const config = Object.freeze({ hubId, name: "Team Hub", webOrigin, administrator: admin });
  const http = createHubHttp({ uow, audit, directory, pairing, store, config, issuer, content, ...(attachments ? { attachments } : {}), ...(opts.preview ? { preview: opts.preview } : {}),
    transport: () => (transportOn && enabled ? transport : null), current: () => ({ serverEnabled: () => enabled, memberEnabled: () => false, epoch: () => 0 }), now: opts.now }, sql);

  const server: Server = createServer((req, res) => { if (!http.handle(req, res)) { res.writeHead(404); res.end("fleet-404"); } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  /** A signed-in browser: its Hub cookie and CSRF token. */
  const signIn = async (login: string) => {
    const r = await fetch(`${base}/hub/v1/session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: webOrigin }, body: JSON.stringify({ login, password: `pw-${login}` }) });
    const body = await r.json() as { csrf: string };
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
    return { status: r.status, cookie, csrf: body.csrf, body };
  };
  type Browser = { cookie: string; csrf: string };
  const call = async (b: Browser | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { Origin: webOrigin, ...(b ? { Cookie: b.cookie, "X-AgEnD-Hub-CSRF": b.csrf } : {}), ...extra };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  /** An authenticated member link as S1 would hand it over. */
  const fleets = new Map<string, HubLinkContext & { alive: boolean }>();
  /** `features`: the link's enabled optional features (none by default, as for an older member). */
  const link = (fleetId: string, owner: PersonKey, linkEpoch = 1, features: readonly string[] = []) => {
    const l = { fleetId, owner, linkEpoch, alive: true, features: new Set(features), current: () => l.alive && enabled } as HubLinkContext & { alive: boolean };
    fleets.set(fleetId, l); return l;
  };
  const frame = <T extends string, P>(type: T, payload: P, l: HubLinkContext) => ({ v: 1 as const, type, requestId: randomUUID(), linkEpoch: l.linkEpoch, payload });

  return {
    db, http, base, hubId, admin, addPerson, people, directory, issuer, keys, store, pairing, audits, contents, sent, signIn, call, link, frame, config,
    get directoryCalls() { return directoryCalls; },
    setEligible: (login: string, v: boolean) => { people.get(login)!.eligible = v; },
    /** The directory renames an account (its key stays); the old login may later be given to someone else. */
    rename: (from: string, to: string) => { const p = people.get(from)!; people.delete(from); p.login = to; p.password = `pw-${to}`; people.set(to, p); },
    setAuditFails: (v: boolean, action?: string) => { auditFails = v; auditFailAction = action; },
    setTransport: (v: boolean) => { transportOn = v; },
    setSendFails: (v: boolean) => { sendFails = v; },
    disable: () => { enabled = false; },
    close: async () => { await http.close(); await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); },
  };
}
