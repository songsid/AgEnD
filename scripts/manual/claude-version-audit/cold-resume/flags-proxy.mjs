// The cold-resume rig's flag server. Claude reads its server flags (GrowthBook remote eval, POST
// https://api.anthropic.com/api/eval/<key>) through HTTPS_PROXY; this proxy terminates TLS for api.anthropic.com only, with
// a scratch CA the CLI trusts through NODE_EXTRA_CA_CERTS, and answers the eval with the flags in $FLAGS (a JSON file of
// {key: value}, re-read per request). Every other request gets a 404, every other CONNECT a 403. Public builds ignore
// CLAUDE_INTERNAL_FC_OVERRIDES (getEnvironmentOverrides() returns null) and rewrite a seeded flag cache, so this is the
// only offline way to reach a server-gated screen. Run inside `unshare -rn` (rig.sh); no iptables, routes or resolv.
//   DIR=<rig dir> FLAGS=<flags.json> node flags-proxy.mjs   → writes <dir>/proxy.port and <dir>/ca.pem
import { createServer } from "node:http";
import { TLSSocket, createSecureContext } from "node:tls";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.DIR, flagsFile = process.env.FLAGS, log = join(dir, "flags.log"), HOST = "api.anthropic.com";
const o = (...a) => execFileSync("openssl", a, { stdio: "ignore" });
const ca = join(dir, "ca.pem"), caKey = join(dir, "ca.key"), key = join(dir, "leaf.key"), csr = join(dir, "leaf.csr"), crt = join(dir, "leaf.pem"), ext = join(dir, "leaf.ext");
o("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca, "-days", "2", "-subj", "/CN=agend-cold-resume-rig-ca");
o("req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", `/CN=${HOST}`);
writeFileSync(ext, `subjectAltName=DNS:${HOST}\nextendedKeyUsage=serverAuth\n`);
o("x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", crt, "-days", "2", "-extfile", ext);

const mock = createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c).on("end", () => {
    const isEval = /^\/api\/eval(-authed)?\//.test(req.url);
    appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, eval: isEval }) + "\n");
    if (!isEval) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"rig"}'); return; }
    const flags = JSON.parse(readFileSync(flagsFile, "utf8"));
    const features = Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, { defaultValue: v, value: v, on: !!v, off: !v, source: "force" }]));
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ features }));
  });
});
const context = createSecureContext({ key: readFileSync(key), cert: readFileSync(crt) });
const proxy = createServer((_req, res) => { res.writeHead(405); res.end(); });
proxy.on("connect", (req, socket, head) => {
  const [host] = String(req.url).split(":");
  appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), connect: req.url, allowed: host === HOST }) + "\n");
  if (host !== HOST) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  const tls = new TLSSocket(socket, { isServer: true, secureContext: context });
  if (head?.length) socket.unshift(head);
  mock.emit("connection", tls);
});
proxy.listen(0, "127.0.0.1", () => {
  writeFileSync(join(dir, "proxy.port"), String(proxy.address().port));
  console.log("FLAGS PROXY", proxy.address().port);
});
