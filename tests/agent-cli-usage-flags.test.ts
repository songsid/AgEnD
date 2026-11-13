/** Real CLI boundary, isolated HOME and a loopback HTTP peer; no daemon/vendor/CLI backend. */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
const run = promisify(execFile);
const owned: Array<{ root: string; server: Server }> = [];
afterEach(async () => {
  for (const h of owned.splice(0)) {
    await new Promise<void>((resolve, reject) => h.server.close(e => e ? reject(e) : resolve()));
    rmSync(h.root, { recursive: true, force: true });
  }
});
async function client() {
  const root = mkdtempSync(join(tmpdir(), "agend-cli-usage-")); const requests: any[] = [];
  const answer = { formatted: "legacy full text", providers: [] };
  const server = createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => { requests.push(JSON.parse(body)); res.end(JSON.stringify(answer)); });
  });
  owned.push({ root, server });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  for (const name of ["agent-cli", "cli-flags", "agent-token-header", "agent-file-read", "instance-names", "web-asset-parts", "bundled-skills", "web-experimental"]) {
    writeFileSync(join(root, name + ".js"), ts.transpileModule(readFileSync(join(import.meta.dirname, "../src/" + name + ".ts"), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  }
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const invoke = (...args: string[]) => run(process.execPath, [join(root, "agent-cli.js"), "usage", ...args], {
    cwd: root, env: { HOME: root, AGEND_HOME: root, AGEND_PORT: String((server.address() as { port: number }).port), AGEND_INSTANCE_NAME: "worker" }, timeout: 10000,
  });
  return { invoke, requests, answer };
}
describe("agend-agent usage compact/detail flags", () => {
  it.each([[], ["--force"], ["--detail"], ["--detail", "--force"], ["--force", "--detail"]].map(flags => ({ flags })))("forwards flags %j and prints structured JSON, including full detail", async ({ flags }) => {
    const c = await client(); const result = await c.invoke(...flags);
    expect(c.requests).toEqual([{ instance: "worker", op: "usage", args: { ...(flags.includes("--detail") ? { detail: true } : {}), ...(flags.includes("--force") ? { force: true } : {}) } }]);
    expect(JSON.parse(result.stdout)).toEqual(c.answer);
  });
  it("unknown options fail before any request", async () => {
    const c = await client();
    await expect(c.invoke("--details")).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("Unknown usage option") });
    expect(c.requests).toEqual([]);
  });
});
