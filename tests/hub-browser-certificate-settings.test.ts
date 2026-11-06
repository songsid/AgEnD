import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserCertificateMigration, createHubBrowserCertificateControl } from "../src/hub/browser-certificate.js";
import { createBrowserCertificate } from "../src/hub/init/browser-certificate.js";
import { parseHubBrowserCertificateApply, parseHubBrowserCertificatePrepare } from "../src/hub-browser-certificate-policy.js";
import { isSettingsMutation, prepareSettingsEffect } from "../src/settings-effect.js";
import type { FleetConfig } from "../src/types.js";

const roots: string[] = [], cleanups: Array<() => Promise<void>> = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), "agend-browser-settings-")); roots.push(p); return p; };
let cert: string, key: string;
beforeAll(async () => {
  const home = root(), generated = await createBrowserCertificate(home, "https://127.0.0.1:19477");
  cert = readFileSync(generated.certFile, "utf8"); key = readFileSync(generated.keyFile, "utf8"); generated.cleanup();
});
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
afterAll(() => { for (const p of roots) rmSync(p, { recursive: true, force: true }); });
function setup() {
  const home = root(), db = new Database(":memory:"), hubId = randomUUID();
  for (const [name, text] of [["cert.pem", cert], ["key.pem", key]]) writeFileSync(join(home, name!), text!, { mode: 0o600 });
  browserCertificateMigration(hubId).up(db); db.exec("CREATE TABLE audit(action TEXT)");
  let live = true, clock = 0;
  const audit = { appendInTransaction: vi.fn((_record: unknown, database: Database.Database) => {
    expect(database).toBe(db); expect(db.inTransaction).toBe(true); db.prepare("INSERT INTO audit VALUES('selected')").run();
  }) };
  const activate = vi.fn();
  const options = { db, home, hubId, origin: "https://127.0.0.1:19477", initial: { certificateFile: "cert.pem", keyFile: "key.pem" },
    audit, activate, current: () => live, now: () => Date.now(), monotonic: () => clock };
  const control = createHubBrowserCertificateControl(options);
  cleanups.push(async () => { await control.close(); db.close(); });
  const imported = () => control.prepare({ mode: "import", revision: control.read().revision, ...options.initial }, "owner", () => true);
  return { home, db, options, control, imported, activate, audit, fence: () => { live = false; }, advance: () => { clock += 600_001; } };
}
describe.skipIf(process.platform === "win32")("confirmed browser certificate replacement", () => {
  it("strictly parses bounded requests without accepting file bytes, foreign keys or coerced revisions", () => {
    const revision = "a".repeat(64), reference = randomUUID();
    expect(parseHubBrowserCertificateApply({ reference, revision })).toEqual({ reference, revision });
    for (const input of [null, [], {}, { revision: 1, mode: "generate" }, { revision, mode: "generate", key: "secret" },
      { revision, mode: "import", certificateFile: "cert", keyFile: "\0" }, { revision, mode: "import", certificateFile: "x".repeat(4097), keyFile: "key" }])
      expect(() => parseHubBrowserCertificatePrepare(input)).toThrow("invalid_browser_certificate");
    for (const input of [{ reference, revision, extra: 1 }, { reference: "../key", revision }, { reference, revision: 0 }])
      expect(() => parseHubBrowserCertificateApply(input)).toThrow("invalid_browser_certificate");
  });
  it("generates a fresh private pair, confirms metadata only, commits same-DB audit and preserves it on reopen", async () => {
    const s = setup(), before = s.control.read(); s.control.activate();
    const p = await s.control.prepare({ mode: "generate", revision: before.revision }, "owner", () => true);
    expect(p.certificate.fingerprint256).not.toBe(before.selected.fingerprint256);
    expect(JSON.stringify(p)).not.toContain("PRIVATE KEY");
    expect(s.control.read().revision).toBe(before.revision); expect(s.audit.appendInTransaction).not.toHaveBeenCalled();
    const after = s.control.apply({ reference: p.reference, revision: p.revision }, "owner", () => true);
    expect(after).toMatchObject({ selected: p.certificate, activeFingerprint256: p.certificate.fingerprint256, restartRequired: false });
    expect(after.revision).not.toBe(before.revision); expect(s.audit.appendInTransaction).toHaveBeenCalledOnce();
    expect(s.audit.appendInTransaction.mock.calls[0]![0]).toMatchObject({ action: "browser-certificate.selected", actor: { kind: "local-host" }, reasonCode: p.certificate.fingerprint256 });
    const path = join(s.home, "hub/web-tls/versions", p.reference, "material.json");
    expect(readFileSync(path, "utf8")).toContain("PRIVATE KEY");
    await s.control.close(); expect(existsSync(path)).toBe(true);
    const reopened = createHubBrowserCertificateControl(s.options);
    expect(reopened.read().selected).toEqual(p.certificate); await reopened.close();
    expect(readFileSync(join(s.home, "cert.pem"), "utf8")).toBe(cert);
  });
  it("binds a proposal to the exact owner session, current certificate bytes, revision and finite lifetime", async () => {
    const s = setup(), p = await s.imported(), apply = { reference: p.reference, revision: p.revision };
    expect(() => s.control.apply(apply, "other-owner", () => true)).toThrow("conflict");
    writeFileSync(join(s.home, "cert.pem"), `${cert}\n`);
    expect(() => s.control.apply(apply, "owner", () => true)).toThrow("conflict");
    writeFileSync(join(s.home, "cert.pem"), cert);
    s.advance(); expect(() => s.control.preview(apply, "owner")).toThrow("conflict");
    expect(s.audit.appendInTransaction).not.toHaveBeenCalled();
  });
  it("rejects reuse and stale proposals after a successful selection", async () => {
    const s = setup(), a = await s.imported(), b = await s.imported();
    s.control.apply({ reference: a.reference, revision: a.revision }, "owner", () => true);
    for (const p of [a, b]) expect(() => s.control.apply({ reference: p.reference, revision: p.revision }, "owner", () => true)).toThrow("conflict");
  });
  it("rolls back required audit exceptions and thenables, including reentrant authority loss", async () => {
    const s = setup(), p = await s.imported(), apply = { reference: p.reference, revision: p.revision }, before = s.control.read();
    for (const audit of [() => { s.db.prepare("INSERT INTO audit VALUES('failed')").run(); throw Error("disk full"); }, () => Promise.resolve() as never]) {
      s.audit.appendInTransaction.mockImplementationOnce(audit);
      expect(() => s.control.apply(apply, "owner", () => true)).toThrow();
      expect(s.control.read()).toEqual(before); expect(s.db.prepare("SELECT count(*) n FROM audit").get()).toEqual({ n: 0 });
    }
    let current = true; s.audit.appendInTransaction.mockImplementationOnce(() => { current = false; });
    expect(() => s.control.apply(apply, "owner", () => current)).toThrow("unavailable");
    expect(s.control.read()).toEqual(before); expect(s.activate).not.toHaveBeenCalled();
  });
  it("reports a durably selected certificate as restart-needed if HTTPS activation fails", async () => {
    const s = setup(); s.control.activate();
    writeFileSync(join(s.home, "replacement.pem"), cert + "\n", { mode: 0o600 });
    const p = await s.control.prepare({ mode: "import", revision: s.control.read().revision, certificateFile: "replacement.pem", keyFile: "key.pem" }, "owner", () => true);
    expect(p.certificate.fingerprint256).toBe(s.control.read().activeFingerprint256);
    s.activate.mockImplementation(() => { throw Error("listener gone"); });
    expect(s.control.apply({ reference: p.reference, revision: p.revision }, "owner", () => true)).toMatchObject({ selected: p.certificate, restartRequired: true });
    expect(s.db.prepare("SELECT material_id FROM hub_browser_tls").get()).toEqual({ material_id: p.reference });
  });
  it("confines imports to private home files, never deletes them, and rejects a mismatched key or host", async () => {
    const s = setup(), revision = s.control.read().revision;
    const prepare = (certificateFile: string, keyFile = "key.pem") => s.control.prepare({ mode: "import", revision, certificateFile, keyFile }, "owner", () => true);
    symlinkSync(join(s.home, "cert.pem"), join(s.home, "link.pem"));
    for (const path of ["../cert.pem", join(s.home, "cert.pem"), "link.pem"]) await expect(prepare(path)).rejects.toThrow();
    chmodSync(join(s.home, "key.pem"), 0o644); await expect(prepare("cert.pem")).rejects.toThrow(); chmodSync(join(s.home, "key.pem"), 0o600);
    const other = await createBrowserCertificate(s.home, "https://other.invalid");
    writeFileSync(join(s.home, "other.pem"), readFileSync(other.certFile), { mode: 0o600 });
    await expect(prepare("other.pem")).rejects.toThrow("invalid_browser_certificate");
    writeFileSync(join(s.home, "other.key"), readFileSync(other.keyFile), { mode: 0o600 });
    await expect(prepare("other.pem", "other.key")).rejects.toThrow("invalid_browser_certificate"); other.cleanup();
    await s.imported(); await s.control.close();
    expect(existsSync(join(s.home, "cert.pem"))).toBe(true); expect(existsSync(join(s.home, "key.pem"))).toBe(true);
    expect(readdirSync(join(s.home, "hub/web-tls/versions"))).toEqual([]);
  });
  it("bounds proposals, prunes expired material, and refuses expired or no-longer-current imports", async () => {
    const s = setup(), input = { mode: "import", revision: s.control.read().revision, ...s.options.initial };
    const eight = Array.from({ length: 8 }, () => s.control.prepare(input, "owner", () => true));
    await expect(s.control.prepare(input, "owner", () => true)).rejects.toThrow("browser_certificate_busy");
    await Promise.all(eight); s.advance();
    await s.imported(); expect(readdirSync(join(s.home, "hub/web-tls/versions"))).toHaveLength(1);
    const expired = createHubBrowserCertificateControl({ ...s.options, now: () => Date.now() + 31 * 86_400_000 });
    await expect(expired.prepare(input, "owner", () => true)).rejects.toThrow("invalid_browser_certificate"); await expired.close();
    await expect(s.control.prepare(input, "owner", () => false)).rejects.toThrow("unavailable");
    s.fence(); await expect(s.control.prepare(input, "owner", () => true)).rejects.toThrow("unavailable");
  });
  it("refuses changed committed material instead of loading a different pair or resetting the selection", async () => {
    const s = setup(), p = await s.imported(); s.control.apply({ reference: p.reference, revision: p.revision }, "owner", () => true);
    const file = join(s.home, "hub/web-tls/versions", p.reference, "material.json"), original = readFileSync(file, "utf8");
    writeFileSync(file, original + "\n"); expect(() => s.control.read()).toThrow("browser_certificate_unavailable");
    expect(() => createHubBrowserCertificateControl(s.options)).toThrow("browser_certificate_unavailable");
    writeFileSync(file, original);
  });
  it("refuses edited prepared material and retains ownership when cleanup cannot prove it unchanged", async () => {
    const s = setup(), p = await s.imported(), file = join(s.home, "hub/web-tls/versions", p.reference, "material.json");
    const original = readFileSync(file, "utf8"); writeFileSync(file, original + "\n");
    expect(() => s.control.apply({ reference: p.reference, revision: p.revision }, "owner", () => true)).toThrow("conflict");
    await expect(s.control.close()).rejects.toThrow("browser_certificate_staging_changed"); expect(existsSync(file)).toBe(true);
    writeFileSync(file, original); await s.control.close(); expect(existsSync(file)).toBe(false);
  });
  it("will not delete a replaced staging directory even if its material bytes match", async () => {
    const s = setup(), p = await s.imported(), dir = join(s.home, "hub/web-tls/versions", p.reference), saved = dir + ".saved";
    renameSync(dir, saved); cpSync(saved, dir, { recursive: true }); chmodSync(dir, 0o700); chmodSync(join(dir, "material.json"), 0o600);
    await expect(s.control.close()).rejects.toThrow("browser_certificate_staging_changed"); expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true }); renameSync(saved, dir); await s.control.close(); expect(existsSync(dir)).toBe(false);
  });
  it("owns a generator before synchronous reentrant close and waits for its physical completion", async () => {
    const s = setup(); let resolve!: (m: Awaited<ReturnType<typeof createBrowserCertificate>>) => void, close!: Promise<void>, settled = false;
    const material = await createBrowserCertificate(s.home, s.options.origin);
    const c = createHubBrowserCertificateControl({ ...s.options, generate: () => {
      close = c.close().then(() => { settled = true; }); return new Promise(r => { resolve = r; });
    } });
    const pending = c.prepare({ mode: "generate", revision: c.read().revision }, "owner", () => true);
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
    resolve(material); await expect(pending).rejects.toThrow("unavailable"); await close;
    expect(settled).toBe(true); expect(existsSync(material.certFile)).toBe(false);
  });
  it("rechecks the session after generation and refuses missing/foreign selected state without resetting it", async () => {
    const s = setup(); let current = true;
    const c = createHubBrowserCertificateControl({ ...s.options, generate: async (...args) => {
      const m = await createBrowserCertificate(...args); current = false; return m;
    } });
    await expect(c.prepare({ mode: "generate", revision: c.read().revision }, "owner", () => current)).rejects.toThrow("unavailable");
    await c.close(); expect(s.audit.appendInTransaction).not.toHaveBeenCalled();
    s.db.prepare("UPDATE hub_browser_tls SET hub_id=?").run(randomUUID());
    expect(() => s.control.read()).toThrow("browser_certificate_unavailable");
    s.db.exec("DELETE FROM hub_browser_tls"); expect(() => createHubBrowserCertificateControl(s.options)).toThrow("browser_certificate_unavailable");
  });
  it("requires existing Settings confirmation, previews the exact session-bound fingerprint and includes it in the effect", async () => {
    const s = setup(), p = await s.imported(), path = "/api/settings/hub/browser-certificate/apply", input = { reference: p.reference, revision: p.revision };
    const context = { config: { defaults: {}, instances: {} } as FleetConfig, classic: {}, hubBrowserCertificate: s.control.preview };
    expect(isSettingsMutation("POST", path)).toBe(true);
    const diff = prepareSettingsEffect("POST", path, input, context, "owner").diff!;
    expect(diff).toMatchObject({ section: "access", authority: { connections: [], primaryGeneral: false, unknown: false } });
    expect(diff.summary.join(" ")).toContain(p.certificate.fingerprint256); expect(diff.summary.join(" ")).toContain(p.certificate.validTo);
    expect(diff.summary.join(" ")).toContain("self-signed");
    expect(() => prepareSettingsEffect("POST", path, input, context, "other-owner")).toThrow("conflict");
    const changed = { ...context, hubBrowserCertificate: () => ({ ...p, certificate: { ...p.certificate, fingerprint256: "other" } }) };
    expect(prepareSettingsEffect("POST", path, input, changed, "owner").diff!.fingerprint).not.toBe(diff.fingerprint);
  });
});
