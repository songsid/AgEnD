/** Real local OpenSSL/HTTPS, private temporary homes; no service, directory, trust-store or network configuration. */
import { afterEach, describe, expect, it } from "vitest";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer, get } from "node:https";
import { createBrowserCertificate, recoverBrowserCertificate } from "../src/hub/init/browser-certificate.js";
import { checkBrowserTls } from "../src/hub/init/browser-tls.js";
import { tempDir } from "./support/hub-init-fixtures.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home() { const path = tempDir("agend-browser-cert-"); homes.push(path); return path; }

describe("owner-requested browser certificate generation", () => {
  it.each(["https://192.0.2.10:8443", "https://[2001:db8::10]:8443", "https://hub.example.test:8443"])("creates a private matching 30-day server certificate for %s", async origin => {
    const root = home(), material = await createBrowserCertificate(root, origin);
    const certPem = readFileSync(material.certFile, "utf8"), keyPem = readFileSync(material.keyFile, "utf8"), cert = new X509Certificate(certPem);
    expect(checkBrowserTls(certPem, keyPem, origin)).toMatchObject({ ok: true, selfSigned: true });
    expect(checkBrowserTls(certPem, keyPem, "https://other.example.test").problems).toContain("host-not-covered");
    expect(cert.ca).toBe(false); expect(cert.checkPrivateKey(createPrivateKey(keyPem))).toBe(true);
    expect(Date.parse(cert.validTo) - Date.parse(cert.validFrom)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(statSync(dirname(material.certFile)).mode & 0o777).toBe(0o700);
    for (const name of ["cert.pem", "key.pem", "material.json"]) expect(statSync(join(dirname(material.certFile), name)).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toHaveLength(1); expect(existsSync(join(root, "hub"))).toBe(false);
    material.cleanup(); material.cleanup(); expect(readdirSync(root)).toEqual([]);
  });
  it("refuses unsafe/noncanonical origins and a nonprivate home before writing", async () => {
    const root = home();
    for (const origin of ["http://hub.example.test", "https://user:pw@hub.example.test", "https://hub.example.test/path", "https://hub.example.test?a=1", "https://hub.example.test#x", "https://hub.example.test,%0ADNS:other.test", "https://HUB.example.test"]) {
      await expect(createBrowserCertificate(root, origin)).rejects.toThrow(); expect(readdirSync(root)).toEqual([]);
    }
    chmodSync(root, 0o755);
    await expect(createBrowserCertificate(root, "https://hub.example.test")).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  });
  it("serves an IP-SAN certificate on a real loopback HTTPS listener with normal peer verification", async () => {
    const root = home(), origin = "https://127.0.0.1", material = await createBrowserCertificate(root, origin);
    const cert = readFileSync(material.certFile), server = createServer({ cert, key: readFileSync(material.keyFile) }, (_req, res) => res.end("ready"));
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address(); if (!address || typeof address === "string") throw Error("no listener");
      const body = await new Promise<string>((resolve, reject) => {
        get(`https://127.0.0.1:${address.port}`, { ca: cert }, res => { let text = ""; res.on("data", bytes => text += bytes); res.on("end", () => resolve(text)); }).on("error", reject);
      });
      expect(body).toBe("ready");
    } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); material.cleanup(); }
  });
  it("recovers only explicit generated material and refuses changed keys, origins, permissions or links", async () => {
    const root = home(), origin = "https://hub.example.test", material = await createBrowserCertificate(root, origin);
    expect(recoverBrowserCertificate(root, origin, material)).toBeNull();
    const files = { certFile: material.certFile, keyFile: material.keyFile, generated: true as const }, key = readFileSync(material.keyFile);
    expect(() => recoverBrowserCertificate(root, "https://other.example.test", files)).toThrow();
    writeFileSync(material.keyFile, "replacement");
    expect(() => recoverBrowserCertificate(root, origin, files)).toThrow(); expect(() => material.cleanup()).toThrow();
    expect(readFileSync(material.keyFile, "utf8")).toBe("replacement"); writeFileSync(material.keyFile, key);
    chmodSync(material.keyFile, 0o644); expect(() => recoverBrowserCertificate(root, origin, files)).toThrow(); chmodSync(material.keyFile, 0o600);
    const staged = dirname(material.certFile), moved = `${staged}-moved`;
    renameSync(staged, moved); symlinkSync(moved, staged);
    expect(() => recoverBrowserCertificate(root, origin, files)).toThrow(); expect(() => material.cleanup()).toThrow();
    rmSync(staged); renameSync(moved, staged);
    recoverBrowserCertificate(root, origin, files)!.cleanup(); expect(readdirSync(root)).toEqual([]);
  });
  it("does not clean a replacement directory at the same generated path", async () => {
    const root = home(), material = await createBrowserCertificate(root, "https://hub.example.test"), dir = dirname(material.certFile);
    renameSync(dir, `${dir}-original`); mkdirSync(dir, { mode: 0o700 }); writeFileSync(join(dir, "keep"), "owner data");
    expect(() => material.cleanup()).toThrow("browser_certificate_staging_changed");
    expect(readFileSync(join(dir, "keep"), "utf8")).toBe("owner data");
  });
});
