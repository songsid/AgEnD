// The fleet's dashboard port for the test: /health ready and /signin, as the installer's readiness check reads them.
import http from "node:http";
const [, port] = process.argv.slice(2);
http.createServer((req, res) => {
  if (req.url === "/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "ok", startupComplete: true })); return; }
  res.writeHead(req.url === "/signin" ? 200 : 404); res.end();
}).listen(Number(port || 19280), "127.0.0.1");
