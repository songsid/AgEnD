/** Reissue only the member certificate. The Hub ID, issuer and TLS private key never rotate here. */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { execFile } from "../../child-process.js";
import { canonicalArguments } from "../identity.js";
import { privatePath } from "../private-files.js";
import { hubOrigin, readHubMemberTls, verifyHubCertificate } from "../tls.js";

export async function prepareMemberCertificate(home: string, rawOrigin: string): Promise<string> {
  const origin = hubOrigin(rawOrigin), before = readHubMemberTls({ home });
  try { verifyHubCertificate(before.certificatePem, origin, before.identity.spkiSha256); return before.certificatePem; }
  catch { /* A different hostname needs a new SAN, using exactly the retained key. */ }
  privatePath(home, "", true);
  const dir = mkdtempSync(join(home, ".hub-member-"));
  try {
    const name = new URL(origin).hostname.replace(/^\[|\]$/g, ""), key = join(dir, "key.pem"), config = join(dir, "openssl.cnf");
    // Match the initializer's conservative DNS grammar before producing OpenSSL configuration.
    if (!isIP(name) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(name)) throw Error("Invalid Hub origin");
    writeFileSync(key, before.keyPem, { flag: "wx", mode: 0o600 });
    writeFileSync(config, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=server\n[dn]\nCN=AgEnD Hub\n[server]\nsubjectAltName=${isIP(name) ? "IP" : "DNS"}:${name}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`, { flag: "wx", mode: 0o600 });
    const { stdout: certificate } = await promisify(execFile)("/usr/bin/openssl", ["req", "-new", "-x509", "-sha256", "-days", "365", "-config", config, "-key", key],
      { timeout: 10_000, maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C" } }).catch(() => { throw Error("Hub certificate preparation failed"); });
    const after = readHubMemberTls({ home });
    if (after.metadataText !== before.metadataText || after.keyPem !== before.keyPem || after.certificatePem !== before.certificatePem
      || canonicalArguments(after.identity) !== canonicalArguments(before.identity)) throw Error("Hub identity changed");
    verifyHubCertificate(certificate, origin, before.identity.spkiSha256);
    return certificate;
  } finally {
    privatePath(home, relative(home, dir), true);
    rmSync(dir, { recursive: true });
  }
}
