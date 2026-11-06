/** Explicit owner-requested browser certificate preparation; no network, shell, trust-store or Hub identity changes. */
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, lstatSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { execFile } from "../../child-process.js";
import { privatePath, readPrivateFile } from "../private-files.js";
import { checkBrowserTls } from "./browser-tls.js";
import type { HubInitPlan } from "./types.js";

export interface HubBrowserMaterial { certFile: string; keyFile: string; cleanup(): void }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Recover only material explicitly generated for this saved init plan; imported files are never owned here. */
export function recoverBrowserCertificate(home: string, origin: string, files: HubInitPlan["webTls"]): HubBrowserMaterial | null {
  if (files.generated !== true) return null;
  const dir = dirname(files.certFile);
  if (dirname(dir) !== resolve(home) || !/^\.hub-browser-[a-zA-Z0-9]{6}$/.test(basename(dir))
    || files.certFile !== join(dir, "cert.pem") || files.keyFile !== join(dir, "key.pem")) throw Error("browser_certificate_staging_changed");
  const suffix = relative(home, dir);
  privatePath(home, suffix, true);
  const identity = lstatSync(dir);
  const validate = () => {
    const marker = JSON.parse(readPrivateFile(home, `${suffix}/material.json`, 1024));
    const cert = readPrivateFile(home, `${suffix}/cert.pem`), key = readPrivateFile(home, `${suffix}/key.pem`);
    if (marker?.v !== 1 || marker.origin !== origin || marker.certSha256 !== digest(cert) || marker.keySha256 !== digest(key))
      throw Error("browser_certificate_staging_changed");
  };
  validate();
  return { certFile: files.certFile, keyFile: files.keyFile, cleanup() {
    let current;
    try { current = lstatSync(dir); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev || current.uid !== identity.uid)
      throw Error("browser_certificate_staging_changed");
    validate();
    rmSync(dir, { recursive: true });
  } };
}

export async function createBrowserCertificate(home: string, origin: string): Promise<HubBrowserMaterial> {
  const u = new URL(origin), host = u.hostname.replace(/^\[|\]$/g, "");
  const dns = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/"
    || u.origin !== origin.replace(/\/$/, "") || (!isIP(host) && !dns.test(host))) throw Error("invalid_browser_origin");
  privatePath(home, "", true);
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dir = mkdtempSync(join(home, ".hub-browser-")), identity = lstatSync(dir);
  const files = { certFile: join(dir, "cert.pem"), keyFile: join(dir, "key.pem"), generated: true as const };
  try {
    // OpenSSL's key loader needs a file on supported builds. Only its private path is in argv, never key bytes.
    writeFileSync(files.keyFile, key, { flag: "wx", mode: 0o600 });
    const { stdout: cert } = await promisify(execFile)("/usr/bin/openssl", ["req", "-new", "-x509", "-sha256", "-days", "30", "-config", "/dev/null",
      "-key", files.keyFile, "-subj", "/CN=AgEnD Hub", "-addext", `subjectAltName=${isIP(host) ? "IP" : "DNS"}:${host}`,
      "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "keyUsage=critical,digitalSignature", "-addext", "extendedKeyUsage=serverAuth"],
    { timeout: 10_000, maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C" } }).catch(() => { throw Error("browser_certificate_generation_failed"); });
    if (!checkBrowserTls(cert, key, u.origin, Date.now()).ok) throw Error("browser_certificate_generation_failed");
    writeFileSync(files.certFile, cert, { flag: "wx", mode: 0o600 });
    writeFileSync(join(dir, "material.json"), JSON.stringify({ v: 1, origin: u.origin, certSha256: digest(cert), keySha256: digest(key) }), { flag: "wx", mode: 0o600 });
    return recoverBrowserCertificate(home, u.origin, files)!;
  } catch (err) {
    const current = lstatSync(dir);
    if (current.isDirectory() && !current.isSymbolicLink() && current.ino === identity.ino && current.dev === identity.dev) rmSync(dir, { recursive: true });
    throw err;
  }
}
