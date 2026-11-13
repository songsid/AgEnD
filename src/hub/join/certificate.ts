/** Fleet-local pilot trust. Only an explicitly chosen, valid self-signed leaf bypasses OS roots. */
import { Agent } from "node:https";
import { connect, type TLSSocket } from "node:tls";
import { isIP, type LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import { sha256 } from "../identity.js";
import { hash, validated } from "../validation.js";
import { hubOrigin, verifyHubCertificate } from "../tls.js";

class PilotCertificateError extends Error { readonly code = "ERR_AGEND_PILOT_CERTIFICATE"; }
export interface PilotCertificate { fingerprint: string; expiresAt: number }
export function inspectPilotCertificate(raw: Buffer, origin: string, now = Date.now()): PilotCertificate {
  const cert = verifyHubCertificate(raw, origin, undefined, now);
  if (cert.subject !== cert.issuer || !cert.verify(cert.publicKey)) throw Error("Not a self-signed Hub certificate");
  return { fingerprint: sha256(cert.raw), expiresAt: Date.parse(cert.validTo) };
}
function connectPilot(origin: string, current: () => boolean, lookup: LookupFunction | undefined,
  now: () => number, done: (error: Error | null, socket: TLSSocket, certificate?: PilotCertificate) => void): void {
  const url = new URL(hubOrigin(origin)), host = url.hostname.replace(/^\[|\]$/g, "");
  let finished = false;
  const finish = (error: Error | null, certificate?: PilotCertificate) => {
    if (finished) return; finished = true; clearTimeout(timer);
    if (error) socket.destroy();
    done(error, socket, certificate);
  };
  const socket = connect({ host, port: Number(url.port || 443), servername: isIP(host) ? undefined : host,
    lookup, rejectUnauthorized: false, minVersion: "TLSv1.2" }, () => {
    try {
      if (!current()) throw Error("Hub request changed");
      finish(null, inspectPilotCertificate(socket.getPeerCertificate().raw, origin, now()));
    } catch { finish(new PilotCertificateError("Hub certificate unavailable")); }
  });
  const timer = setTimeout(() => finish(Error("Hub certificate unavailable")), 5_000);
  socket.once("error", () => finish(Error("Hub certificate unavailable")));
}
/** TLS only: no HTTP, sign-in, metadata request or saved trust. */
export function presentedPilotCertificate(origin: string, current: () => boolean, lookup?: LookupFunction, now = Date.now): Promise<PilotCertificate> {
  return new Promise((resolve, reject) => connectPilot(origin, current, lookup, now, (error, socket, certificate) => {
    socket.destroy();
    if (error || !certificate) reject(error ?? Error("Hub certificate unavailable")); else resolve(certificate);
  }));
}
export function pilotCertificateAgent(origin: string, fingerprint: string, current: () => boolean, lookup?: LookupFunction, now = Date.now): Agent {
  const expected = validated(hash, fingerprint), agent = new Agent({ keepAlive: false });
  agent.createConnection = (_options, callback) => {
    connectPilot(origin, current, lookup, now, (error, socket, certificate) => {
      if (!error && certificate?.fingerprint !== expected) { error = new PilotCertificateError("Hub certificate changed"); socket.destroy(); }
      callback?.(error, socket);
    });
    return undefined as unknown as Duplex;
  };
  return agent;
}
