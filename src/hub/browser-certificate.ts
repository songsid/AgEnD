/** Browser TLS selection only. The sealed Hub/member identity and member pins never change here. */
import type Database from "better-sqlite3";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createSecureContext } from "node:tls";
import { parseHubBrowserCertificateApply, parseHubBrowserCertificatePrepare,
  type HubBrowserCertificateInfo, type HubBrowserCertificateProposal, type HubBrowserCertificateView } from "../hub-browser-certificate-policy.js";
import type { HubAuditStore } from "./audit/index.js";
import type { HubMigration } from "./db.js";
import { createBrowserCertificate, type HubBrowserMaterial } from "./init/browser-certificate.js";
import { checkBrowserTls, pemCertificates } from "./init/browser-tls.js";
import { ensurePrivateDirectory, privatePath, readPrivateFile } from "./private-files.js";

export interface BrowserCertificateMaterial { cert: string; key: string }
export interface HubBrowserCertificateControl {
  read(): HubBrowserCertificateView;
  prepare(input: unknown, binding: string, current: () => boolean): Promise<HubBrowserCertificateProposal>;
  preview(input: unknown, binding: string): HubBrowserCertificateProposal;
  apply(input: unknown, binding: string, current: () => boolean): HubBrowserCertificateView;
}
const HUB_BROWSER_CERTIFICATE_MIGRATION: HubMigration = { component: "s5-browser-tls", version: 1, up(db) {
  db.exec(`CREATE TABLE hub_browser_tls(singleton INTEGER PRIMARY KEY CHECK(singleton=1), hub_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=1), material_id TEXT, material_digest TEXT);`);
} };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Row = { hub_id: string; revision: number; material_id: string | null; material_digest: string | null };
type Owned = { suffix: string; digest: string; ino: number; dev: number; uid: number };
type Candidate = Owned & { reference: string; revision: string; binding: string; deadline: number };

export function createHubBrowserCertificateControl(options: {
  db: Database.Database; home: string; hubId: string; origin: string; initial: { certificateFile: string; keyFile: string };
  audit: Pick<HubAuditStore, "appendInTransaction">; current(): boolean; now(): number;
  activate(material: BrowserCertificateMaterial): void;
  generate?(home: string, origin: string): Promise<HubBrowserMaterial>;
  monotonic?: () => number;
}) {
  const { db, home } = options, clock = options.monotonic ?? (() => performance.now());
  let closed = false, active: string | null = null, activeDigest: string | null = null;
  const candidates = new Map<string, Candidate>(), owned = new Set<Owned>(), stages = new Set<HubBrowserMaterial>(), work = new Set<Promise<unknown>>();
  const assert = (current = () => true) => { if (closed || !options.current() || !current()) throw Error("unavailable"); };
  const materialInfo = (material: BrowserCertificateMaterial): HubBrowserCertificateInfo => {
    const leaf = new X509Certificate(pemCertificates(material.cert)[0]!);
    return { fingerprint256: leaf.fingerprint256, validFrom: leaf.validFrom, validTo: leaf.validTo,
      selfSigned: leaf.subject === leaf.issuer && leaf.verify(leaf.publicKey) };
  };
  const validate = (material: BrowserCertificateMaterial) => {
    if (!checkBrowserTls(material.cert, material.key, options.origin, options.now()).ok) throw Error("invalid_browser_certificate");
    createSecureContext(material); // Check the entire PEM chain, not just the first leaf.
    return material;
  };
  const row = (): Row => {
    const r = db.prepare("SELECT * FROM hub_browser_tls WHERE singleton=1").get() as Row | undefined;
    if (!r || r.hub_id !== options.hubId || !Number.isSafeInteger(r.revision) || r.revision < 1
      || (r.material_id === null ? r.material_digest !== null : !uuid.test(r.material_id) || !/^[0-9a-f]{64}$/.test(r.material_digest ?? "")))
      throw Error("browser_certificate_unavailable");
    return r;
  };
  const load = (r: Row): { material: BrowserCertificateMaterial; digest: string } => {
    const text = r.material_id === null ? JSON.stringify({ cert: readPrivateFile(home, options.initial.certificateFile), key: readPrivateFile(home, options.initial.keyFile) })
      : readPrivateFile(home, `hub/web-tls/versions/${r.material_id}/material.json`, 128 * 1024);
    const digest = hash(text);
    if (r.material_digest !== null && digest !== r.material_digest) throw Error("browser_certificate_unavailable");
    const material = JSON.parse(text) as BrowserCertificateMaterial;
    if (typeof material.cert !== "string" || typeof material.key !== "string") throw Error("browser_certificate_unavailable");
    // Permit an expired selected certificate to be displayed and renewed. A new selection must be currently valid.
    createSecureContext(material);
    materialInfo(material);
    return { material, digest };
  };
  const snapshot = () => { assert(); const r = row(), m = load(r); return { ...m, row: r, revision: hash(JSON.stringify([r.revision, m.digest])) }; };
  const read = (): HubBrowserCertificateView => {
    const s = snapshot(), selected = materialInfo(s.material);
    return { revision: s.revision, selected, activeFingerprint256: active, restartRequired: activeDigest !== s.digest };
  };
  const remove = (o: Owned) => {
    const dir = join(home, o.suffix);
    let stat;
    try { stat = lstatSync(dir); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") { owned.delete(o); return; } throw err; }
    privatePath(home, o.suffix, true);
    if (stat.ino !== o.ino || stat.dev !== o.dev || stat.uid !== o.uid || hash(readPrivateFile(home, `${o.suffix}/material.json`, 128 * 1024)) !== o.digest)
      throw Error("browser_certificate_staging_changed");
    rmSync(dir, { recursive: true }); owned.delete(o);
  };
  const prune = () => { for (const [id, c] of candidates) if (clock() >= c.deadline) { remove(c); candidates.delete(id); } };
  const candidate = (input: unknown, binding: string): Candidate => {
    assert(); const p = parseHubBrowserCertificateApply(input), c = candidates.get(p.reference);
    if (!c || !binding || c.binding !== binding || clock() >= c.deadline || c.revision !== p.revision || snapshot().revision !== p.revision) throw Error("conflict");
    if (hash(readPrivateFile(home, `${c.suffix}/material.json`, 128 * 1024)) !== c.digest) throw Error("conflict");
    return c;
  };
  const preview = (input: unknown, binding: string): HubBrowserCertificateProposal => {
    const c = candidate(input, binding), material = JSON.parse(readPrivateFile(home, `${c.suffix}/material.json`, 128 * 1024));
    validate(material);
    return { reference: c.reference, revision: c.revision, certificate: materialInfo(material) };
  };
  snapshot(); // Existing initialized DB state must be present and intact; never silently reset it.
  const control: HubBrowserCertificateControl = {
    read, preview,
    prepare(input, binding, current) {
      try { assert(current); prune(); } catch (err) { return Promise.reject(err); }
      if (work.size + candidates.size >= 8) return Promise.reject(Error("browser_certificate_busy"));
      // Own physical work BEFORE a generator callback can synchronously re-enter close().
      const job = Promise.resolve().then(async () => {
        assert(current); prune();
        const p = parseHubBrowserCertificatePrepare(input);
        if (!binding || snapshot().revision !== p.revision) throw Error("conflict");
        if (candidates.size >= 8) throw Error("browser_certificate_busy");
        let generated: HubBrowserMaterial | undefined;
        let c: Candidate | undefined;
        try {
          let material: BrowserCertificateMaterial;
          if (p.mode === "generate") {
            generated = await (options.generate ?? createBrowserCertificate)(home, options.origin);
            stages.add(generated);
            assert(current);
            material = { cert: readPrivateFile(home, relative(home, generated.certFile)), key: readPrivateFile(home, relative(home, generated.keyFile)) };
          } else material = { cert: readPrivateFile(home, p.certificateFile), key: readPrivateFile(home, p.keyFile) };
          validate(material); assert(current);
          if (snapshot().revision !== p.revision) throw Error("conflict");
          const reference = randomUUID(), suffix = `hub/web-tls/versions/${reference}`, text = JSON.stringify(material);
          if (Buffer.byteLength(text) > 128 * 1024) throw Error("invalid_browser_certificate");
          ensurePrivateDirectory(home, "hub/web-tls/versions");
          const dir = join(home, suffix); mkdirSync(dir, { mode: 0o700 });
          const stat = lstatSync(dir);
          c = { suffix, digest: hash(text), ino: stat.ino, dev: stat.dev, uid: stat.uid, reference, revision: p.revision, binding, deadline: clock() + 600_000 };
          // Material becomes durable before its DB pointer can be committed. An incomplete write is never selected.
          owned.add(c);
          const fd = openSync(join(dir, "material.json"), "wx", 0o600);
          try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
          for (const path of [dir, join(home, "hub/web-tls/versions"), join(home, "hub/web-tls"), join(home, "hub"), home]) {
            const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
          }
          assert(current);
          if (generated) { generated.cleanup(); stages.delete(generated); generated = undefined; }
          candidates.set(reference, c);
          return preview({ reference, revision: p.revision }, binding);
        } catch (err) {
          if (c && owned.has(c)) remove(c);
          throw err;
        } finally { if (generated) { generated.cleanup(); stages.delete(generated); } }
      });
      work.add(job); void job.then(() => work.delete(job), () => work.delete(job));
      return job;
    },
    apply(input, binding, current) {
      const c = candidate(input, binding);
      const material = validate(JSON.parse(readPrivateFile(home, `${c.suffix}/material.json`, 128 * 1024)));
      const info = materialInfo(material);
      db.transaction(() => {
        assert(current); candidate(input, binding);
        const before = row(); if (before.revision >= Number.MAX_SAFE_INTEGER) throw Error("conflict");
        const result: unknown = options.audit.appendInTransaction({ id: randomUUID(), sequence: before.revision + 1, at: options.now(), requestId: randomUUID(),
          actor: { kind: "local-host" }, action: "browser-certificate.selected", result: "completed", policyVersion: before.revision + 1,
          reasonCode: info.fingerprint256 }, db);
        if (result && typeof (result as { then?: unknown }).then === "function") throw Error("browser_certificate_audit_unavailable");
        assert(current); candidate(input, binding);
        db.prepare("UPDATE hub_browser_tls SET revision=?, material_id=?, material_digest=? WHERE singleton=1").run(before.revision + 1, c.reference, c.digest);
      }).immediate();
      candidates.delete(c.reference); owned.delete(c); // Selected versions survive shutdown and restart.
      try { options.activate(material); active = info.fingerprint256; activeDigest = c.digest; } catch { /* Selection is saved; read() truthfully reports restartRequired. */ }
      return read();
    },
  };
  return Object.assign(control, {
    material: () => snapshot().material,
    activate() { const s = snapshot(); options.activate(s.material); active = materialInfo(s.material).fingerprint256; activeDigest = s.digest; },
    async close() {
      closed = true;
      await Promise.allSettled([...work]);
      for (const stage of stages) { stage.cleanup(); stages.delete(stage); }
      for (const o of owned) { remove(o); for (const [id, c] of candidates) if (c === o) candidates.delete(id); }
    },
  });
}

/** Seed only when the migration itself runs, including an older initialized Hub's first upgrade. */
export function browserCertificateMigration(hubId: string): HubMigration {
  return { ...HUB_BROWSER_CERTIFICATE_MIGRATION, up(db) {
    HUB_BROWSER_CERTIFICATE_MIGRATION.up(db);
    db.prepare("INSERT INTO hub_browser_tls VALUES(1, ?, 1, NULL, NULL)").run(hubId);
  } };
}
