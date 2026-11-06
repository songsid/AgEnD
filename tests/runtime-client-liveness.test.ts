import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { compilePortableRuntime } from "./support/runtime-portable-compile.js";

describe("standalone runtime foreground lifetime", () => {
  it("keeps an idle child with closed stdin alive across a dropped socket and reconnects before stopping", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agend-runtime-liveness-"));
    const server = createServer(), sockets = new WebSocketServer({ server });
    let child: ChildProcess | undefined;
    try {
      const compiled = join(directory, "compiled"), bundle = join(directory, "bundle");
      compilePortableRuntime(compiled);
      // Match postbuild: the portable builder consumes the built program assets too.
      cpSync(resolve("src/general-knowledge"), join(compiled, "general-knowledge"), { recursive: true });
      execFileSync(process.execPath, [resolve("scripts/build-runtime.mjs"), bundle, compiled], { cwd: process.cwd(), stdio: "pipe", timeout: 10_000 });
      const machineId = randomUUID(); let connections = 0, helloCount = 0;
      sockets.on("connection", socket => {
        const connection = ++connections;
        socket.on("message", raw => {
          const frame = JSON.parse(raw.toString()); if (frame.type !== "hello") return;
          helloCount++;
          socket.send(JSON.stringify({ v: 1, type: "welcome", machineId, generation: connection }));
          // The child must have no live socket while its reconnect timer waits. The test server's timers live
          // in this parent process, so they cannot conceal a missing lifetime reference inside the child.
          if (connection === 1) setTimeout(() => socket.terminate(), 100);
          else setTimeout(() => socket.close(1008, "Fixture revoked after successful reconnect"), 100);
        });
      });
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
      const profile = join(directory, "profile");
      new RuntimeClientStore(profile).saveCredentials({ server: `http://127.0.0.1:${address.port}`, machineId, credential: "a".repeat(64), name: "Liveness fixture" });
      const entry = join(directory, "idle-client.mjs");
      writeFileSync(entry, `import {RuntimeClient} from ${JSON.stringify(pathToFileURL(join(bundle, "dist/runtime-client.js")).href)};
import {RuntimeClientStore} from ${JSON.stringify(pathToFileURL(join(bundle, "dist/runtime-client-store.js")).href)};
const bridge={probe:async()=>({home:'C:\\\\fixture',clis:[]}),prepareWorkspace:async()=>{throw Error('unused');},start(){throw Error('no CLI may run in this fixture');},get(){return null;},cancel(){throw Error('unused');},close(){},releaseUnknown(){}};
const client=new RuntimeClient({store:new RuntimeClientStore(${JSON.stringify(profile)}),bridge,reconnectMs:350,pollMs:50});
process.once('SIGTERM',()=>{void client.stop();});
void client.start().then(()=>client.waitUntilStopped()).catch(error=>{process.stderr.write(error.message+'\\n');process.exitCode=1;});
`);
      child = spawn(process.execPath, [entry], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = ""; child.stdout?.resume(); child.stderr?.setEncoding("utf8").on("data", text => { stderr += text; });
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
        const timeout = setTimeout(() => { child?.kill(); reject(Error("Standalone runtime did not reconnect and stop within the fixture deadline")); }, 10_000);
        child!.once("error", error => { clearTimeout(timeout); reject(error); });
        child!.once("close", (code, signal) => { clearTimeout(timeout); accept({ code, signal }); });
      });
      expect({ connections, helloCount, stderr, ...exit }).toEqual({ connections: 2, helloCount: 2, stderr: "", code: 0, signal: null });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "close").catch(() => {}); }
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(done => sockets.close(() => done()));
      await new Promise<void>(done => server.close(() => done()));
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected runtime liveness fixture path");
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
