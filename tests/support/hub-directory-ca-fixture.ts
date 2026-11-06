/** Inert loopback LDAPS wire fixture. Real TLS and ldapts BER, no directory/account/container service. */
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import { BerReader, BerWriter } from "ldapts";

export const CA_DN = "CN=Example Root,CN=AIA,DC=example,DC=test";
export function directoryCertificates() {
  const home = mkdtempSync(join(tmpdir(), "agend-ca-cert-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: home, stdio: "ignore" });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  run(["req", "-x509", ...ec, "-days", "2", "-subj", "/CN=Example Root", "-keyout", "ca.key", "-out", "ca.pem"]);
  const leaf = (name: string, san: string, aia: string, days = "2") => {
    run(["req", ...ec, "-subj", `/CN=${name}`, "-keyout", `${name}.key`, "-out", `${name}.csr`]);
    writeFileSync(join(home, `${name}.ext`), `subjectAltName=${san}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nauthorityInfoAccess=@aia\n[aia]\ncaIssuers;URI.0=${aia}\n`);
    run(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", days, "-extfile", `${name}.ext`, "-out", `${name}.pem`]);
    return { cert: readFileSync(join(home, `${name}.pem`), "utf8"), key: readFileSync(join(home, `${name}.key`), "utf8") };
  };
  const uri = `ldap:///${encodeURIComponent(CA_DN)}?cACertificate?base?objectClass=certificationAuthority`;
  const ca = readFileSync(join(home, "ca.pem"), "utf8");
  run(["req", "-x509", ...ec, "-days", "2", "-subj", "/CN=Unrelated Directory", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", "unrelated.key", "-out", "unrelated.pem"]);
  const unrelated = { cert: readFileSync(join(home, "unrelated.pem"), "utf8"), key: readFileSync(join(home, "unrelated.key"), "utf8") };
  return { ca, unrelated, leaf: leaf("directory", "IP:127.0.0.1,DNS:localhost", uri), alternate: leaf("alternate", "IP:127.0.0.1,DNS:localhost", uri),
    wrongHost: leaf("wrong", "DNS:other.invalid", uri), expired: leaf("expired", "IP:127.0.0.1", uri, "-1"),
    external: leaf("external", "IP:127.0.0.1", "ldap://other.invalid/cn=outside?cACertificate?base"),
    cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
export async function directoryCaFixture(material: { cert: string; key: string }, caPem: string, mode: {
  requireBind?: boolean; dropAfterBind?: boolean; wrongCa?: boolean; referral?: string; duplicate?: boolean; oversized?: boolean; afterSearch?: () => void;
} = {}) {
  const sockets = new Set<TLSSocket>(), binds: Array<{ dn: string; password: string }> = [], searches: any[] = [];
  let connections = 0, rawConnections = 0, applicationBytes = 0;
  const rawSockets = new Set<import("node:net").Socket>();
  const server = createServer(material, socket => {
    connections++; sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0), bound = false;
    const reply = (id: number, tag: number, write: (w: BerWriter) => void) => {
      const w = new BerWriter(); w.startSequence(); w.writeInt(id); w.startSequence(tag); write(w); w.endSequence(); w.endSequence(); socket.write(w.buffer);
    };
    const status = (id: number, tag: number, code = 0) => reply(id, tag, w => { w.writeEnumeration(code); w.writeString(""); w.writeString(""); });
    socket.on("data", chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      applicationBytes += bytes.length; buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length) {
        const r = new BerReader(buffer); r.readSequence(); if (r.remain < r.length) return;
        const size = r.offset + r.length, id = r.readInt()!, tag = r.readSequence();
        if (tag === 0x60) {
          r.readInt(); const dn = r.readString()!, password = r.readString(0x80)!; binds.push({ dn, password }); bound = !!dn;
          status(id, 0x61); if (mode.dropAfterBind) socket.end();
        } else if (tag === 0x63) {
          const base = r.readString(), scope = r.readEnumeration(), deref = r.readEnumeration(), sizeLimit = r.readInt(), timeLimit = r.readInt(), typesOnly = r.readBoolean();
          const filterTag = r.peek(); const attribute = r.readString(filterTag ?? undefined);
          const filter = filterTag === 0x87 ? `(${attribute}=*)` : `unexpected-${filterTag}`; r.readSequence(); const end = r.offset + r.length, attributes: string[] = [];
          while (r.offset < end) attributes.push(r.readString()!);
          searches.push({ base, scope, deref, sizeLimit, timeLimit, typesOnly, filter, attributes });
          if (mode.requireBind && !bound) status(id, 0x65, 50);
          else {
            if (mode.referral) reply(id, 0x73, w => w.writeString(mode.referral!));
            reply(id, 0x64, w => {
              w.writeString(CA_DN); w.startSequence(); w.startSequence(); w.writeString("cACertificate;binary"); w.startSequence(0x31);
              const der = new X509Certificate(mode.wrongCa ? material.cert : caPem).raw;
              w.writeBuffer(der, 0x04); if (mode.duplicate) w.writeBuffer(der, 0x04);
              w.endSequence(); w.endSequence();
              if (mode.oversized) { w.startSequence(); w.writeString("description"); w.startSequence(0x31); w.writeString("x".repeat(300 * 1024)); w.endSequence(); w.endSequence(); }
              w.endSequence();
            });
            status(id, 0x65);
          }
          mode.afterSearch?.();
        } else if (tag === 0x42) socket.end();
        else socket.destroy();
        buffer = buffer.subarray(size);
      }
    });
  });
  server.on("tlsClientError", () => {});
  server.on("connection", s => { rawConnections++; rawSockets.add(s); s.on("close", () => rawSockets.delete(s)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `ldaps://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, binds, searches, connections: () => connections, rawConnections: () => rawConnections, applicationBytes: () => applicationBytes, rotate: (pair: { cert: string; key: string }) => server.setSecureContext(pair),
    close: async () => { for (const s of rawSockets) s.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
