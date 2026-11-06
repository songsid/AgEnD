/** Local initializer bootstrap only. No runtime directory-verification switch, credential-bearing inspection or URL fetching. */
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import * as tls from "node:tls";
import type { Client } from "ldapts";
import { resolveDirectoryConfig } from "../directory/config.js";
import { pemCertificates } from "./browser-tls.js";

export interface DirectoryCertificateInfo { fingerprint256: string; subject: string; issuer: string; validTo: string }
export interface DirectoryCertificateProbe { url: string; leafPem: string; chain: string[]; certificate: DirectoryCertificateInfo }
export interface DirectoryCaBundle { pem: string; certificates: DirectoryCertificateInfo[] }
const TIMEOUT = 5000, MAX_BYTES = 256 * 1024;
const error = (code = "directory_ca_unavailable") => Error(code);
const clean = (s: string) => s.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ").slice(0, 512);
const fingerprint = (s: string) => s.replace(/[ :]/g, "").toUpperCase();
export function sameDirectoryFingerprint(expected: string, supplied: string): boolean {
  return /^[0-9A-F]{64}$/.test(fingerprint(supplied)) && fingerprint(expected) === fingerprint(supplied);
}
const endpoint = (url: string) => resolveDirectoryConfig({ realm: "bootstrap", url, baseDn: "cn=bootstrap", bindDn: "cn=bootstrap", profile: "ad" });
const info = (c: X509Certificate): DirectoryCertificateInfo => ({ fingerprint256: c.fingerprint256, subject: clean(c.subject), issuer: clean(c.issuer), validTo: c.validTo });
function valid(c: X509Certificate, now = Date.now()) {
  if (Date.parse(c.validFrom) > now || Date.parse(c.validTo) <= now) throw error("directory_ca_expired");
}
export function directoryCaInfo(pem: string, now = Date.now()): DirectoryCaBundle {
  if (Buffer.byteLength(pem) > 64 * 1024) throw error("directory_ca_invalid");
  const certificates = pemCertificates(pem);
  if (!certificates.length || certificates.length > 4 || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) throw error("directory_ca_invalid");
  return { pem, certificates: certificates.map(p => {
    const c = new X509Certificate(p); valid(c, now);
    if (!c.ca) throw error("directory_ca_invalid");
    return info(c);
  }) };
}
function host(c: X509Certificate, name: string) {
  if (!(isIP(name) ? c.checkIP(name) : c.checkHost(name, { subject: "never" }))) throw error("directory_ca_hostname");
  valid(c);
}
/** Inspect TLS only: no LDAP client exists and no application bytes or credentials are sent. */
export async function inspectDirectoryCertificate(url: string): Promise<DirectoryCertificateProbe> {
  const cfg = endpoint(url);
  const socket = tls.connect({ host: cfg.host, port: cfg.port, ...(isIP(cfg.host) ? {} : { servername: cfg.host }), minVersion: "TLSv1.2", rejectUnauthorized: false });
  try {
    await connected(socket);
    const peer = socket.getPeerCertificate(true);
    if (!peer.raw || peer.raw.length > 64 * 1024) throw error();
    const leaf = new X509Certificate(peer.raw); host(leaf, cfg.host);
    const chain: string[] = [], seen = new Set<string>();
    let next: tls.DetailedPeerCertificate | undefined = peer.issuerCertificate;
    while (next?.raw && chain.length < 4) {
      if (next.raw.length > 64 * 1024) throw error();
      const c = new X509Certificate(next.raw);
      if (seen.has(c.fingerprint256) || c.fingerprint256 === leaf.fingerprint256) break;
      seen.add(c.fingerprint256); chain.push(c.toString()); next = next.issuerCertificate;
    }
    return { url: cfg.url, leafPem: leaf.toString(), chain, certificate: info(leaf) };
  } catch (err) { throw known(err); } finally { socket.destroy(); }
}
function known(err: unknown): Error {
  return err instanceof Error && /^directory_ca_(?:unavailable|invalid|expired|hostname|pin|auth_required|unsupported|aia)$/.test(err.message) ? err : error();
}
async function connected(socket: tls.TLSSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.destroy(); reject(error()); }, TIMEOUT);
    const failed = () => { clearTimeout(timeout); reject(error()); };
    socket.once("error", failed);
    socket.once("close", failed);
    socket.once("secureConnect", () => { clearTimeout(timeout); socket.removeListener("close", failed); resolve(); });
  });
}
/** LDAP AIA is a base DN on this same directory. Never follow a host, referral, HTTP URL or arbitrary query. */
function issuerDn(c: X509Certificate, name: string): string {
  const locations = (c.infoAccess ?? "").split("\n").filter(s => s.startsWith("CA Issuers - URI:ldap:"));
  if (locations.length !== 1) throw error("directory_ca_aia");
  let uri: URL;
  try { uri = new URL(locations[0]!.slice("CA Issuers - URI:".length)); } catch { throw error("directory_ca_aia"); }
  const [attribute, scope, filter, extension] = uri.search.slice(1).split("?");
  if (uri.protocol !== "ldap:" || uri.username || uri.password || uri.hash || uri.hostname && uri.hostname.toLowerCase() !== name.toLowerCase()
    || uri.port && uri.port !== "389" || attribute?.toLowerCase() !== "cacertificate" || scope !== "base"
    || filter && filter !== "objectClass=certificationAuthority" && filter !== "(objectClass=certificationAuthority)" || extension) throw error("directory_ca_aia");
  let dn: string; try { dn = decodeURIComponent(uri.pathname.slice(1)); } catch { throw error("directory_ca_aia"); }
  if (!dn || dn.length > 1024 || /[\x00-\x1f\x7f]/.test(dn)) throw error("directory_ca_aia");
  return dn;
}
async function pinned(probe: DirectoryCertificateProbe, pin: string): Promise<tls.TLSSocket> {
  const cfg = endpoint(probe.url), leaf = new X509Certificate(probe.leafPem);
  if (!sameDirectoryFingerprint(leaf.fingerprint256, pin)) throw error("directory_ca_pin");
  host(leaf, cfg.host);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major! < 22 || major === 22 && minor! < 9) throw error("directory_ca_unsupported");
  // The owner explicitly trusted this exact leaf. Normal TLS verification remains ON before any LDAP bytes.
  // Node's partial-chain support: https://nodejs.org/download/release/v22.23.3/docs/api/tls.html#tlscreatesecurecontextoptions
  const socket = tls.connect({ host: cfg.host, port: cfg.port, ...(isIP(cfg.host) ? {} : { servername: cfg.host }), minVersion: "TLSv1.2",
    ca: leaf.toString(), allowPartialTrustChain: true, rejectUnauthorized: true,
    checkServerIdentity(name, cert) {
      if (!cert.raw || fingerprint(new X509Certificate(cert.raw).fingerprint256) !== fingerprint(pin)) return error("directory_ca_pin");
      return tls.checkServerIdentity(name, cert);
    } });
  try {
    await connected(socket);
    if (!socket.authorized || !socket.encrypted || socket.destroyed || !socket.getPeerCertificate().raw
      || fingerprint(new X509Certificate(socket.getPeerCertificate().raw).fingerprint256) !== fingerprint(pin)) throw error("directory_ca_pin");
    return socket;
  } catch (err) { socket.destroy(); throw known(err); }
}
export async function fetchDirectoryCa(probe: DirectoryCertificateProbe, confirmedLeafFingerprint: string,
  credentials?: { bindDn: string; password: string }): Promise<DirectoryCaBundle> {
  const cfg = endpoint(probe.url), leaf = new X509Certificate(probe.leafPem);
  if (credentials && (!credentials.bindDn || credentials.bindDn.length > 1024 || /[\x00-\x1f\x7f]/.test(credentials.bindDn)
    || !credentials.password || credentials.password.length > 1024 || credentials.password.includes("\0"))) throw error("directory_ca_invalid");
  if (!Array.isArray(probe.chain) || probe.chain.length > 4 || probe.chain.some(p => typeof p !== "string" || Buffer.byteLength(p) > 64 * 1024)) throw error("directory_ca_invalid");
  const socket = await pinned(probe, confirmedLeafFingerprint);
  let client: Client | undefined, claimed = false;
  const assert = () => { if (socket.destroyed || !socket.authorized || !socket.encrypted) throw error(); };
  try {
    const { Client } = await import("ldapts");
    client = new Client({ url: cfg.url, timeout: TIMEOUT, connectTimeout: TIMEOUT, strictDN: true, autoRebind: false,
      createConnection: (() => { throw error(); }) as never,
      createSecureConnection: (() => { assert(); if (claimed) throw error(); claimed = true; return socket; }) as never });
    let read = 0;
    socket.on("data", chunk => { read += chunk.length; if (read > MAX_BYTES) socket.destroy(error()); });
    const chain: X509Certificate[] = [], seen = new Set<string>();
    let current = leaf;
    for (let depth = 0; depth < 4; depth++) {
      valid(current);
      if (current.ca && current.subject === current.issuer && current.verify(current.publicKey)) { if (!chain.length) chain.push(current); break; }
      let issuers = probe.chain.map(p => new X509Certificate(p)).filter(c => c.ca && current.checkIssued(c) && current.verify(c.publicKey));
      if (!issuers.length) {
        const base = issuerDn(current, cfg.host);
        assert();
        if (!client.isConnected) await client.bind(credentials?.bindDn ?? "", credentials?.password ?? "");
        assert();
        const result = await client.search(base, { scope: "base", filter: "(objectClass=*)", derefAliases: "never", sizeLimit: 1, timeLimit: 3,
          attributes: ["cACertificate;binary", "cACertificate"], explicitBufferAttributes: ["cACertificate;binary", "cACertificate"] });
        assert();
        if (result.searchReferences.length || result.searchEntries.length !== 1) throw error("directory_ca_aia");
        const values = Object.entries(result.searchEntries[0]!).filter(([name]) => /^(?:cacertificate)(?:;binary)?$/i.test(name))
          .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
        if (!values.length || values.length > 4 || values.some(v => !Buffer.isBuffer(v) || v.length > 64 * 1024)) throw error("directory_ca_invalid");
        issuers = values.map(v => new X509Certificate(v as Buffer)).filter(c => c.ca && current.checkIssued(c) && current.verify(c.publicKey));
      }
      issuers = [...new Map(issuers.map(c => [c.fingerprint256, c])).values()];
      if (issuers.length !== 1 || seen.has(issuers[0]!.fingerprint256)) throw error("directory_ca_invalid");
      current = issuers[0]!; valid(current); seen.add(current.fingerprint256); chain.push(current);
    }
    if (!chain.length || !current.ca || current.subject !== current.issuer || !current.verify(current.publicKey)) throw error("directory_ca_invalid");
    const bundle = directoryCaInfo(chain.map(c => c.toString()).join("\n"));
    // Prove normal runtime verification with the fetched CA before returning it for owner confirmation/configuration.
    const verified = tls.connect({ host: cfg.host, port: cfg.port, ...(isIP(cfg.host) ? {} : { servername: cfg.host }), minVersion: "TLSv1.2",
      ca: bundle.pem, rejectUnauthorized: true });
    try { await connected(verified); if (!verified.authorized) throw error(); } finally { verified.destroy(); }
    return bundle;
  } catch (err) {
    if (!credentials && [1, 48, 50].includes(Number((err as { code?: number }).code))) throw error("directory_ca_auth_required");
    throw known(err);
  } finally { socket.destroy(); if (client) await client.unbind().catch(() => {}); }
}
