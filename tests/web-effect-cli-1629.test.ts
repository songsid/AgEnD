import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pino from "pino";
import { handleAgentRequest } from "../src/agent-endpoint.js";
const run = promisify(execFile);
const owned: Array<{ dir: string; server: Server }> = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const x of owned.splice(0)) { x.server.closeAllConnections(); await new Promise<void>((r, j) => x.server.close(e => e ? j(e) : r())); rmSync(x.dir, { recursive: true, force: true }); }
});
async function fixture() {
  const parent = join(process.cwd(), ".artifacts"); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "effect-cli-")), state = join(dir, "state"), workspace = join(dir, "workspace");
  mkdirSync(join(state, "instances", "own"), { recursive: true }); mkdirSync(join(workspace, "effect"), { recursive: true });
  writeFileSync(join(state, "instances", "own", "agent.token"), "private-fixture-token"); vi.stubEnv("AGEND_HOME", state);
  const { FleetManager } = await import("../src/fleet-manager.js"); const fm = new FleetManager(state) as any;
  fm.logger = pino({ level: "silent" }); fm.fleetConfig = { defaults: {}, instances: { own: { working_directory: workspace, tool_set: "standard" } }, web: { experimental: { canvas_worker: true }, themes: { agent_edit: true } } };
  vi.spyOn(fm, "startAll").mockRejectedValue(Error("must not start a fleet")); vi.spyOn(fm, "startInstance").mockRejectedValue(Error("must not spawn an instance"));
  vi.spyOn(fm, "emitSseEvent").mockImplementation(() => {});
  const requests: string[] = [];
  const server = createServer((req, res) => { requests.push(req.headers["x-agend-instance-token"] as string); handleAgentRequest(req, res, fm); });
  owned.push({ dir, server }); await new Promise<void>((r, j) => { server.once("error", j); server.listen(0, "127.0.0.1", r); });
  const port = (server.address() as { port: number }).port;
  const invoke = async (...args: string[]) => {
    const { stdout } = await run(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("src/agent-cli.ts"), "effect", ...args], {
      cwd: workspace, env: { HOME: dir, PATH: process.env.PATH, AGEND_HOME: state, AGEND_PORT: String(port), AGEND_INSTANCE_NAME: "own", NODE_PATH: resolve("node_modules") }, timeout: 15000,
    }).catch((e: {message: string; stderr?: string; stdout?: string; code?: string; signal?: string}) => { throw Error(`${e.message} stderr=${e.stderr} stdout=${e.stdout} code=${e.code} signal=${e.signal}`); });
    return JSON.parse(stdout);
  };
  writeFileSync(join(workspace, "effect", "effect.json"), JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title: "Fixture", regions: ["chat"], layer: "behind", wants: [], params: { count: { type: "number", min: 1, max: 4, default: 2 } } }));
  writeFileSync(join(workspace, "effect", "worker.js"), "// Only snapshotted and compiled, never executed.\nagend.ready()");
  return { fm, dir, state, workspace, invoke, requests };
}
describe("#1629 real agend-agent effect client → authenticated loopback → Fleet", () => {
  it("uploads bytes, lists and applies typed params without exposing a fleet-side path", async () => {
    const h = await fixture(), result = await h.invoke("upload", "effect");
    expect(result).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect((await h.invoke("list")).effects).toEqual([expect.objectContaining({ id: result.id })]);
    expect(await h.invoke("apply", result.id, '{"count":3}')).toMatchObject({ id: result.id, params: { count: 3 }, region: "chat" });
    expect(h.fm.themeStore.get("own").placements.effects).toEqual([{ id: result.id, params: { count: 3 }, by: "agent", at: expect.any(Number) }]);
    expect(h.requests.length).toBe(3); expect(new Set(h.requests)).toEqual(new Set(["own:private-fixture-token"]));
    expect(h.fm.startAll).not.toHaveBeenCalled(); expect(h.fm.startInstance).not.toHaveBeenCalled();
  }, 30000);
  it("refuses invalid params and malformed ids before changing placements", async () => {
    const h = await fixture(), { id } = await h.invoke("upload", "effect");
    expect(await h.invoke("apply", id, '{"count":99}')).toMatchObject({ error: "effect_params" });
    expect(h.fm.themeStore.get("own").placements.effects).toEqual([]);
    const before = h.requests.length; await expect(h.invoke("delete", "../other")).rejects.toThrow(); expect(h.requests).toHaveLength(before);
    expect(await h.invoke("remove")).toMatchObject({ removed: [] });
    expect(await h.invoke("delete", id)).toMatchObject({ deleted: id }); expect((await h.invoke("list")).effects).toEqual([]);
  }, 30000);
  it("does not admit an upload when the private token is wrong", async () => {
    const h = await fixture(); writeFileSync(join(h.state, "instances", "own", "agent.token"), "different");
    // The endpoint owns its token check; make the CLI's read stale while the server still sees the real file.
    const tokenCheck = vi.spyOn(h.fm, "handleWebThemeHttp");
    const response = await fetch(`http://127.0.0.1:${(owned.at(-1)!.server.address() as { port: number }).port}/agent`, { method: "POST", headers: { "X-Agend-Instance-Token": "own:private-fixture-token", "Content-Type": "application/json" }, body: JSON.stringify({ instance: "own", op: "effect-list", args: {} }) });
    expect(response.status).toBe(401); expect(tokenCheck).not.toHaveBeenCalled(); expect(h.fm.effectLibrary.list({ kind: "agent", id: "own" }).entries).toEqual([]);
  });
});
