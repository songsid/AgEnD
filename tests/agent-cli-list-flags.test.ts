import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const run = promisify(execFile);
const own: Array<{ root: string; server: Server }> = [];
afterEach(async () => {
  for (const h of own.splice(0)) { await new Promise<void>((r, j) => h.server.close(e => e ? j(e) : r())); rmSync(h.root, { recursive: true, force: true }); }
});
async function client() {
  const root = mkdtempSync(join(tmpdir(), "agend-cli-forward-")); const requests: any[] = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => { requests.push(JSON.parse(body)); res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"accepted":true}'); });
  });
  own.push({ root, server });
  await new Promise<void>((r, j) => { server.once("error", j); server.listen(0, "127.0.0.1", r); });
  const port = (server.address() as { port: number }).port;
  // Real client source transpiled to its own private module tree. Only a loopback stub HTTP server is reachable.
  for (const name of ["agent-cli", "cli-flags", "agent-token-header", "agent-file-read", "instance-names", "web-asset-parts", "bundled-skills", "web-experimental"]) {   // #2163: `skill` reads bundled skills   // #1629: theme asset reads its file here and sends it in parts
    const source = readFileSync(join(import.meta.dirname, "../src/" + name + ".ts"), "utf8");
    writeFileSync(join(root, name + ".js"), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  }
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const invoke = async (...args: string[]) => run(process.execPath, [join(root, "agent-cli.js"), ...args], {
    cwd: root, env: { HOME: root, AGEND_HOME: root, AGEND_PORT: String(port), AGEND_INSTANCE_NAME: "leader" }, timeout: 10000,
  });
  return { invoke, requests };
}
describe("CLI compact list flags",()=>{
 it.each([
  ["schedule-list", "dev", "--limit", "7", "--cursor", "next"],
  ["decision-list", "true", "--limit", "7", "--cursor", "next"],
  ["task", "list", "dev", "claimed", "--limit", "7", "--cursor", "next"]
 ])("paging flags reach the existing endpoint without replacing filters: %s",async(...args)=>{
  const h=await client();await h.invoke(...args);expect(h.requests).toHaveLength(1);expect(h.requests[0].args).toMatchObject({limit:7,cursor:"next"});
  if(args[0]==="schedule-list")expect(h.requests[0].args.target).toBe("dev");
  if(args[0]==="decision-list")expect(h.requests[0].args.include_archived).toBe(true);
  if(args[0]==="task")expect(h.requests[0].args).toMatchObject({filter_assignee:"dev",filter_status:"claimed"});
 });
 it.each([["task","get","M-3","--detail"],["decision-get","abcdef","--detail"],["schedule-list","--detail"]])("full detail is explicit: %s",async(...args)=>{
  const h=await client();await h.invoke(...args);expect(h.requests[0].args.detail).toBe(true);
 });
 it("missing cursor and unknown options fail without an HTTP request",async()=>{
  const h=await client();await expect(h.invoke("task","list","--cursor")).rejects.toThrow();await expect(h.invoke("decision-list","--bogus")).rejects.toThrow();expect(h.requests).toHaveLength(0);
 });
});
