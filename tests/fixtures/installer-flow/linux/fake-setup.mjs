// `agend setup` for the test: binds 127.0.0.1:<port> (as 2.3.1), prints the page and code lines after listen, and
// finishes when the page is posted to (the test's "person" does that), then starts the fleet on the same port.
import http from "node:http"; import fs from "node:fs"; import { spawn } from "node:child_process";
const [home, port] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  if (req.url === "/s/flowsid/finish") {
    res.end("ok");
    fs.writeFileSync(home + "/fleet.yaml", fs.readFileSync(home + "/fleet.yaml", "utf8") + "instances:\n  general: {}\n");
    fs.writeFileSync(home + "/.setup-complete", "");
    server.close(() => {
      console.log("Setup complete");
      spawn(process.execPath, ["/opt/stubs/fake-fleet.mjs", home, port], { detached: true, stdio: "ignore" }).unref();
      setTimeout(() => process.exit(0), 300);
    });
    return;
  }
  res.writeHead(req.url.startsWith("/s/flowsid/") ? 200 : 404); res.end();
});
server.listen(Number(port), "127.0.0.1", () => {
  console.log(`\n  Setup page: http://127.0.0.1:${port}/s/flowsid/`);
  console.log("  Setup code: GR7K-2QXM");
});
