// proxy2.mjs: 0.0.0.0:19481 inside the container. A CONNECT to hub.example.test:<port> tunnels to 127.0.0.1:<port> (the rig
// Hub's web listener) so the host's browser can finish a company sign-in; anything else is the dashboard (→ 127.0.0.1:19280).
import { createServer, connect } from "node:net";
createServer((c) => {
  c.once("data", (first) => {
    const m = /^CONNECT hub\.example\.test:(\d+) HTTP\/1\.[01]\r\n/.exec(first.toString("latin1"));
    const s = connect(m ? Number(m[1]) : 19280, "127.0.0.1");
    s.on("error", () => c.destroy()); c.on("error", () => s.destroy());
    if (m) s.once("connect", () => { c.write("HTTP/1.1 200 Connection established\r\n\r\n"); c.pipe(s).pipe(c); });
    else { s.write(first); c.pipe(s).pipe(c); }
  });
}).listen(19481, "0.0.0.0");
