/** Kill only our own child controller; the container must independently stop and lose its tmpfs. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { promisify } from "node:util";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn, execFile } from "../../../src/child-process.js";
const run = promisify(execFile), imageId = process.env.IMAGE_ID ?? readFileSync(".artifacts/hub-s4b-work/image-config-id", "utf8").trim();
const out = process.env.OUT ?? ".artifacts/hub-s4b-work/crash"; mkdirSync(out, { recursive: true });
const results = await Promise.all(["claude", "codex"].map(async backend => {
  const worker = spawn(process.execPath, ["--import", "tsx", "scripts/manual/hub-provider/crash-worker.mts", backend, imageId], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(worker, "close"); let container: string | undefined, buffer = "", stderr = "";
  worker.stderr!.on("data", (b: Buffer) => { stderr += b; });
  try {
    const contextId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`worker startup timeout ${stderr}`)), 20_000);
      worker.on("error", reject); worker.on("close", () => { clearTimeout(timer); reject(Error(`worker exited early ${stderr}`)); });
      worker.stdout!.on("data", (b: Buffer) => { buffer += b; if (buffer.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(buffer.split("\n")[0]).contextId); } });
    });
    container = (await run("docker", ["ps", "--filter", `label=org.agend.hub.context=${contextId}`, "--format", "{{.ID}}"], { timeout: 10_000 })).stdout.trim(); assert(/^[0-9a-f]{12,64}$/.test(container));
    const before = JSON.parse((await run("docker", ["inspect", container], { timeout: 10_000 })).stdout)[0]; assert.equal(before.Image, imageId); assert.equal(before.Config.Labels["org.agend.hub.context"], contextId);
    const start = Date.now(); worker.kill("SIGKILL"); await exited;
    let after;
    for (;;) {
      after = JSON.parse((await run("docker", ["inspect", container], { timeout: 10_000 })).stdout)[0];
      if (!after.State.Running) break;
      assert(Date.now() - start < 135_000, "runner must independently stop after lost controller"); await new Promise(r => setTimeout(r, 1000));
    }
    assert.notEqual(after.State.ExitCode, 0); assert.equal(after.HostConfig.ReadonlyRootfs, true); assert.equal(after.HostConfig.LogConfig.Type, "none"); assert.deepEqual(after.Mounts, []);
    const row = { backend, contextId, elapsed: Date.now() - start, exitCode: after.State.ExitCode, stopped: true, noPersistentDataMounts: true };
    console.log(`PASS ${backend} controller death; independently stopped (${row.elapsed}ms)`); return row;
  } finally { worker.kill("SIGKILL"); if (container) await run("docker", ["rm", "-f", container], { timeout: 10_000 }); }
}));
writeFileSync(`${out}/result.json`, JSON.stringify({ imageId, results }, null, 2));
