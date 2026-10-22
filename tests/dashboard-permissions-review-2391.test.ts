/**
 * #2391 review (Prism r1/r2), carried in: the dashboard switches mean the same thing everywhere they are read.
 *
 * - A feature set to null on an agent follows the default again. With the default switching it off, it stays off live,
 *   in the fleet.yaml Settings writes (the key goes, never a literal null) and after a reload, at both call-time sinks;
 *   a default that allows it is the control (it opens, and only through the confirmation).
 * - A ClassicBot identity (in no `instances` entry; its daemon runs on the defaults) is held to the defaults' switches at
 *   both sinks — the outbound IPC check and the agent endpoint — read at each call, so a change applies to the next one.
 *
 * Driven through the real Settings handler, the real FleetManager loader and saver, and the real sinks; temp homes only
 * (no fleet started, no instance, no tmux).
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { dispatchAgentOperation, ToolNotPermittedError } from "../src/agent-endpoint.js";
import { dashboardFeaturesOffIn } from "../src/dashboard-permissions.js";
import { loadFleetConfig } from "../src/config.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture(source: (dir: string) => string): { dir: string; path: string; fm: FleetManager } {
  const dir = mkdtempSync(join(tmpdir(), "agend-2391-review-"));
  dirs.push(dir);
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, source(dir));
  const fm = new FleetManager(dir);
  fm.loadConfig(path);
  return { dir, path, fm };
}
function call(fm: FleetManager, method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
    req.method = method;
    req.destroy = () => undefined;
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, end(payload: string) { resolve({ status, body: JSON.parse(payload) }); } };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${route}`), fm as unknown as Parameters<typeof handleSettingsRequest>[3])).toBe(true);
      if (body !== undefined) queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    } catch (err) { reject(err); }
  });
}
/** The outbound IPC sink, as the fleet runs it. */
const ipc = (fm: FleetManager, name: string, tool: string): boolean => (fm as any).checkToolPermission("ipc-outbound", name, tool).allowed;
/** The agent endpoint's sink (`agend task …`): allowed when it reaches the handler. */
async function endpoint(fleetConfig: unknown, name: string, tool: string): Promise<boolean> {
  const ctx = { dataDir: tmpdir(), fleetConfig, logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }, handleTaskCrudHttp: vi.fn(async () => ({ ok: true })) };
  const r = await dispatchAgentOperation(ctx as never, name, tool, {}).catch((e) => e);
  if (r instanceof ToolNotPermittedError) return false;
  if (r instanceof Error) throw r;
  return true;
}
const fleetYaml = (defaultTaskBoard: boolean, dir: string) => `defaults:
  dashboard:
    task_board: ${defaultTaskBoard}
instances:
  dev:
    working_directory: ${JSON.stringify(dir)}
    dashboard:
      task_board: false
`;
const effect = (fm: FleetManager, body: unknown) => prepareSettingsEffect("PATCH", "/api/settings/fleet/instances/dev", body, { config: fm.fleetConfig as never, classic: {} }).diff;

describe("#2391 review: null on an agent follows the default, live, saved and after a reload", () => {
  it("default off: Settings applies it directly and the board stays off — at both sinks, in fleet.yaml, after a reload", async () => {
    const { dir, path, fm } = fixture((d) => fleetYaml(false, d));
    expect(effect(fm, { dashboard: { task_board: null } })).toBeNull();                 // nothing opens: no confirmation asked
    const r = await call(fm, "PATCH", "/api/settings/fleet/instances/dev", { dashboard: { task_board: null } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const live = [ipc(fm, "dev", "task"), await endpoint(fm.fleetConfig, "dev", "task")];
    const saved = (yaml.load(readFileSync(path, "utf8")) as any).instances.dev;
    const again = new FleetManager(dir); again.loadConfig(path);
    expect([live, Object.hasOwn(saved.dashboard ?? {}, "task_board"), [ipc(again, "dev", "task"), await endpoint(again.fleetConfig, "dev", "task")]])
      .toEqual([[false, false], false, [false, false]]);
  }, 30_000);                                                                     // the first import of the fleet is slow under load
  it("control — default on: the same null opens the board, so it is confirmed first; once applied, both sinks allow it", async () => {
    const { fm } = fixture((d) => fleetYaml(true, d));
    expect(effect(fm, { dashboard: { task_board: null } })?.summary.join("\n")).toMatch(/instances\.dev\.dashboard\.task\\_board \\\(in effect\\\): false → true/);
    expect([ipc(fm, "dev", "task"), await endpoint(fm.fleetConfig, "dev", "task")]).toEqual([false, false]);
    expect((await call(fm, "PATCH", "/api/settings/fleet/instances/dev", { dashboard: { task_board: null } })).status).toBe(200);
    expect([ipc(fm, "dev", "task"), await endpoint(fm.fleetConfig, "dev", "task")]).toEqual([true, true]);
  }, 30_000);
  it("a literal null already in fleet.yaml (hand-written, or saved by an earlier build) never hides the default's false", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-2391-null-")); dirs.push(dir);
    const path = join(dir, "fleet.yaml");
    writeFileSync(path, `defaults:\n  dashboard:\n    task_board: false\ninstances:\n  dev:\n    working_directory: ${JSON.stringify(dir)}\n    dashboard:\n      task_board: null\n`);
    const loaded = loadFleetConfig(path);
    expect([loaded.instances.dev.dashboard?.task_board, dashboardFeaturesOffIn(loaded, "dev"), dashboardFeaturesOffIn(yaml.load(readFileSync(path, "utf8")), "dev")])
      .toEqual([false, ["task_board"], ["task_board"]]);
  });
});

describe("#2391 review: a ClassicBot identity is held to the defaults at both sinks", () => {
  it("default off: its task call is refused at the IPC check and the endpoint; a configured agent with its own true is the control", async () => {
    const { fm } = fixture((d) => `defaults:\n  dashboard:\n    task_board: false\ninstances:\n  dev:\n    working_directory: ${JSON.stringify(d)}\n    dashboard:\n      task_board: true\n`);
    expect([ipc(fm, "ops-t1", "task"), await endpoint(fm.fleetConfig, "ops-t1", "task"), ipc(fm, "dev", "task"), await endpoint(fm.fleetConfig, "dev", "task")])
      .toEqual([false, false, true, true]);
  }, 30_000);
  it("read at each call: the default switched on lets the next call through, and off again stops the one after", async () => {
    const { fm } = fixture((d) => `defaults:\n  dashboard:\n    task_board: false\ninstances:\n  dev:\n    working_directory: ${JSON.stringify(d)}\n`);
    const seen: boolean[] = [];
    seen.push(ipc(fm, "ops-t1", "task"), await endpoint(fm.fleetConfig, "ops-t1", "task"));
    fm.fleetConfig!.defaults!.dashboard = { task_board: true };
    seen.push(ipc(fm, "ops-t1", "task"), await endpoint(fm.fleetConfig, "ops-t1", "task"));
    fm.fleetConfig!.defaults!.dashboard = { task_board: false };
    seen.push(ipc(fm, "ops-t1", "task"), await endpoint(fm.fleetConfig, "ops-t1", "task"));
    expect(seen).toEqual([false, false, true, true, false, false]);
  }, 30_000);
  it("a name that is no own key (constructor, __proto__) reads the defaults, never an inherited object", () => {
    const fleet = { defaults: { dashboard: { task_board: false } }, instances: {} };
    expect([dashboardFeaturesOffIn(fleet, "constructor"), dashboardFeaturesOffIn(fleet, "__proto__")]).toEqual([["task_board"], ["task_board"]]);
  });
});
