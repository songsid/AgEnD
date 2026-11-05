/**
 * The Hub's browser-facing HTTPS certificate (S-48, hub.md §2 "Origins, keys and bootstrap"). It is separate from the
 * member transport certificate S1 generates: colleagues' browsers must trust it, so it comes from the operator
 * (an organisation-issued certificate, or one their browsers are otherwise set up to trust). There is no plaintext
 * fallback: without a usable certificate the wizard stops and the Hub stays off.
 */
import { X509Certificate, createPrivateKey, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

export type BrowserTlsProblem =
  | "cert-unreadable" // not PEM certificate text
  | "key-unreadable" // not a PEM private key (or encrypted)
  | "key-mismatch" // the key does not belong to the certificate
  | "host-not-covered" // the web address's host is not in the certificate
  | "not-yet-valid"
  | "expired"
  | "ca-certificate"; // the leaf is a CA certificate, not a server certificate

export interface BrowserTlsCheck {
  readonly ok: boolean;
  readonly problems: readonly BrowserTlsProblem[];
  /** Advisory only: browsers will warn unless this certificate is trusted some other way. */
  readonly selfSigned: boolean;
  readonly subject?: string;
  readonly issuer?: string;
  readonly validTo?: string;
  readonly fingerprint256?: string;
}

/** Split a PEM bundle into its certificates (leaf first, as servers send them). */
export function pemCertificates(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
}

/**
 * Check a certificate chain + private key for the Hub's web address. Pure: the caller reads the files. The key text is
 * never echoed or returned.
 */
export function checkBrowserTls(certPem: string, keyPem: string, webOrigin: string, nowMs: number = Date.now()): BrowserTlsCheck {
  const problems: BrowserTlsProblem[] = [];
  const pems = pemCertificates(certPem);
  let leaf: X509Certificate | undefined;
  try {
    if (pems.length > 0) leaf = new X509Certificate(pems[0]!);
  } catch {
    leaf = undefined;
  }
  if (!leaf) return { ok: false, problems: ["cert-unreadable"], selfSigned: false };

  let key: KeyObject | undefined;
  try {
    key = createPrivateKey({ key: keyPem, format: "pem" });
  } catch {
    problems.push("key-unreadable");
  }
  if (key && !leaf.checkPrivateKey(key)) problems.push("key-mismatch");

  const host = new URL(webOrigin).hostname.replace(/^\[(.*)\]$/, "$1");
  const covered = isIP(host) ? leaf.checkIP(host) !== undefined : leaf.checkHost(host, { subject: "never" }) !== undefined;
  if (!covered) problems.push("host-not-covered");

  if (Date.parse(leaf.validFrom) > nowMs) problems.push("not-yet-valid");
  if (Date.parse(leaf.validTo) <= nowMs) problems.push("expired");
  const selfSigned = leaf.issuer === leaf.subject && leaf.verify(leaf.publicKey);
  // A CA-issued leaf that is itself a CA is the wrong certificate (usually the chain in the wrong order). Self-signed
  // server certificates commonly carry CA:TRUE (openssl's default), so for them it is not a problem by itself.
  if (leaf.ca && !selfSigned) problems.push("ca-certificate");
  return {
    ok: problems.length === 0,
    problems,
    selfSigned,
    subject: leaf.subject,
    issuer: leaf.issuer,
    validTo: leaf.validTo,
    fingerprint256: leaf.fingerprint256,
  };
}
