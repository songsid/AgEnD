/** Real setup HTTP + private operator socket, with every native process boundary inert. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const refuse = (...args: unknown[]) => { native.calls.push(String(args[0])); throw Error("native processes forbidden in setup regression"); };
  return { ...real, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});
import { SetupHost } from "../src/setup-host.js";
import { setupHttp, decideSetup } from "./helpers/setup-confirmation-1423.js";
const roots: string[] = [], hosts: SetupHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown(false, "test cleanup").catch(() => {});
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); expect(native.calls.splice(0)).toEqual([]);
});
describe("setup under Ubuntu's umask 0002", () => {
  it.each(["fresh", "affected 0775"])("%s home completes web-only setup and real host confirmation without a fleet", async kind => {
    const root = mkdtempSync(join(tmpdir(), "setup-home-2435-")); roots.push(root);
    const dir = kind === "fresh" ? join(root, "new-home") : root;
    if (kind === "affected 0775") chmodSync(dir, 0o775);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {}), spawnFleet = vi.fn();
    const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, spawnFleet, log: () => {} }); hosts.push(host);
    const mask = process.umask(0o002);
    let started: Awaited<ReturnType<SetupHost["start"]>>;
    try { started = await host.start(); } finally { process.umask(mask); }
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "operator")).mode & 0o777).toBe(0o700);
    expect(warning).toHaveBeenCalledTimes(kind === "fresh" ? 0 : 1);
    const { port, path, code } = started;
    const opened = await setupHttp(port, path + "open", "POST", { code }); expect(opened.status).toBe(200);
    const cookie = String(opened.headers["set-cookie"]).split(";")[0]!;
    const pending = await setupHttp(port, path + "api/settings/quickstart/commit", "POST", {
      web_only: true, backend: "claude-code", working_directory: join(root, "project"), instance_name: "synthetic-agent",
    }, cookie);
    expect(pending.status).toBe(202);
    expect(existsSync(join(dir, "fleet.yaml"))).toBe(false);
    expect((await decideSetup(dir, pending.body.pending_change.id)).pending_change.state).toBe("applied");
    expect(readFileSync(join(dir, "fleet.yaml"), "utf8")).toContain("synthetic-agent");
    expect((await setupHttp(port, path + "setup/finish", "POST", undefined, cookie)).status).toBe(202);
    await host.shutdown(true, "finished"); expect(spawnFleet).toHaveBeenCalledOnce();
  });
});
