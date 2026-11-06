/** A fake private host in an owned child: listener cleanup alone is not physical process-exit proof. */
import { expect, it, vi } from "vitest";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { RuntimePaneLink } from "../src/runtime-pane-link.js";
import { readPaneHostDescriptor } from "../src/runtime-pane-private.js";
import { runtimeJobDigest } from "../src/runtime-client-store.js";
it.each(["discovered", "retained"] as const)("requires the exact owned %s host process to exit after descriptor, lock and listener disappear", async mode => {
  const directory = mkdtempSync(join(tmpdir(), "agend-update-host-exit-"));
  const options = { directory, server: "http://127.0.0.1:19280", machineId: "12345678-1234-4321-abcd-123456789012", online: () => true, maxAgents: () => 4 };
  const scope = runtimeJobDigest({ server: options.server, machineId: options.machineId });
  const script = `
    import {createServer} from 'node:http'; import {mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
    import {randomUUID} from 'node:crypto'; import {join} from 'node:path';
    import ws from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("ws")).href)};
    const directory=join(${JSON.stringify(directory)},'pane-host');mkdirSync(directory,{mode:0o700});
    const server=createServer(), peers=new ws.WebSocketServer({server}), boot=randomUUID();
    const lock=join(directory,'runtime.lock'), descriptor=join(directory,'host.json');
    writeFileSync(lock,JSON.stringify({pid:process.pid,bootId:boot}),{mode:0o600});
    peers.on('connection',socket=>{socket.send(JSON.stringify({type:'hello',hostBootId:boot,idleShutdown:1}));
      socket.on('message',bytes=>{const value=JSON.parse(bytes);if(value.type!=='request')return;
        const shutdown=value.request.action==='shutdown';
        socket.send(JSON.stringify({type:'response',id:value.id,ok:true,result:shutdown?{hostBootId:boot,shutdown:true}:{hostBootId:boot,panes:[]}}),()=>{
          if(shutdown){for(const peer of peers.clients)peer.terminate();peers.close();server.close(()=>{
            unlinkSync(descriptor);unlinkSync(lock);process.send('listener-closed');});}
        });
      });});
    server.listen(0,'127.0.0.1',()=>{writeFileSync(descriptor,JSON.stringify({version:1,scope:${JSON.stringify(scope)},hostBootId:boot,pid:process.pid,port:server.address().port,token:'b'.repeat(64)}),{mode:0o600});process.send('ready');});
    process.on('message',message=>{if(message==='exit')process.exit(0);});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let error = ""; child.stderr!.on("data", data => { error += data.toString(); });
  const exit = once(child, "close"), kill = vi.spyOn(process, "kill");
  let retained: RuntimePaneLink | undefined;
  try {
    const [ready] = await Promise.race([once(child, "message"), exit.then(() => { throw Error(`Fake host failed: ${error}`); })]);
    expect(ready).toBe("ready");
    if (mode === "retained") retained = await RuntimePaneLink.attach(readPaneHostDescriptor(join(directory, "pane-host"), scope)!, options);
    const closed = once(child, "message"); let complete = false;
    const drained = RuntimePaneLink.drainExistingForUpdate(options, () => true, retained).then(() => { complete = true; });
    expect((await closed)[0]).toBe("listener-closed");
    await vi.waitFor(() => expect(kill.mock.calls.filter(args => args[0] === child.pid && args[1] === 0).length).toBeGreaterThanOrEqual(2));
    expect(complete).toBe(false); child.send("exit"); await exit; await drained;
    expect(complete).toBe(true);
  } finally { await retained?.stop(); kill.mockRestore(); if (child.exitCode === null) { child.kill(); await exit; } rmSync(directory, { recursive: true, force: true }); }
});
