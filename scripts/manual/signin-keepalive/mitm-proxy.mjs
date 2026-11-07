// #3292 offline rig: an explicit HTTPS proxy (HTTPS_PROXY) that terminates TLS for the listed hosts with a scratch CA and hands
// the decrypted stream to the mock (mock-oauth.mjs). Every other CONNECT is refused. No iptables, routes or resolv changes:
// the CLI is pointed here by HTTPS_PROXY and trusts the scratch CA through NODE_EXTRA_CA_CERTS. Run inside `unshare -rn`.
import { createServer } from "node:http";
import { TLSSocket, createSecureContext } from "node:tls";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/** A scratch CA and one leaf certificate for `hosts`, written under `dir`. Returns the paths. */
export function makeCa(dir, hosts) {
  const o = (...a) => execFileSync("openssl", a, { stdio: "ignore" });
  const ca = join(dir, "ca.pem"), caKey = join(dir, "ca.key"), key = join(dir, "leaf.key"), csr = join(dir, "leaf.csr"), crt = join(dir, "leaf.pem"), ext = join(dir, "leaf.ext");
  o("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca, "-days", "2", "-subj", "/CN=agend-keepalive-rig-ca");
  o("req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", `/CN=${hosts[0]}`);
  writeFileSync(ext, `subjectAltName=${hosts.map(h => `DNS:${h}`).join(",")}\nextendedKeyUsage=serverAuth\n`);
  o("x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", crt, "-days", "2", "-extfile", ext);
  return { ca, key, crt };
}

/** Start the proxy. `mock`: an http.Server whose handler answers the decrypted requests. */
export function startProxy({ hosts, certs, mock, log }) {
  const context = createSecureContext({ key: readFileSync(certs.key), cert: readFileSync(certs.crt) });
  const proxy = createServer((req, res) => { res.writeHead(405); res.end(); });
  proxy.on("connect", (req, socket, head) => {
    const [host] = String(req.url).split(":");
    if (log) appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), connect: req.url, allowed: hosts.includes(host) }) + "\n");
    if (!hosts.includes(host)) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tls = new TLSSocket(socket, { isServer: true, secureContext: context });
    if (head?.length) socket.unshift(head);
    mock.emit("connection", tls);
  });
  return new Promise(resolve => proxy.listen(0, "127.0.0.1", () => resolve({ proxy, port: proxy.address().port })));
}
