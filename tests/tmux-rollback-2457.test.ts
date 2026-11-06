/**
 * M-2457 PR C §7: `agend rollback <2.3.x>`. Each step must succeed before the next: stop the fleet (and see it gone),
 * close AgEnD's own tmux server with its recorded client and confirm it (pid gone, socket refusing, every pane process
 * exited), write rollback.json, and only then install the older version and start it. A failed or unknown close stops
 * before npm runs. Isolation: temp dirs, fake probes and steps (nothing is stopped, installed or started).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RollbackDeps, rollback } from "../src/tmux-rollback.js";
import { type ServerProbes, sha256File, writeServerRecord } from "../src/tmux-server.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function world(o: { record?: boolean; alive?: boolean; serverExits?: boolean; panesExit?: boolean; stopOk?: boolean; gone?: boolean; installOk?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "agend-rollback-")); roots.push(home);
  const bin = join(home, "tmux", "3.8-aaaaaaaaaaaa", "bin", "tmux");
  mkdirSync(join(home, "tmux", "3.8-aaaaaaaaaaaa", "bin"), { recursive: true });
  writeFileSync(bin, "#!/bin/sh\n"); chmodSync(bin, 0o755);
  if (o.record !== false) writeServerRecord(home, { socket: "agend", binary: bin, version: "3.8", sha256: sha256File(bin), serverPid: 4242, serverStart: 1_800_000_000 });
  const steps: string[] = [];
  let ended = false;
  const panes = new Set([5001, 5002]);
  const probes: ServerProbes = {
    async accepts() { return (o.alive ?? true) && !(ended && o.serverExits !== false); },
    async run(b, args) {
      steps.push(`tmux ${args.slice(2).join(" ")}`);
      if (args.includes("list-panes")) return "5001\n5002\n";
      if (args.includes("kill-server")) { ended = true; if (o.panesExit !== false) panes.clear(); return ""; }
      return "3.8 4242 1800000000";
    },
    async proc(pid) {
      if (pid === 4242) return ended && o.serverExits !== false ? null : { start: null, exe: null };
      return panes.has(pid) ? { start: null, exe: null } : null;
    },
    kill(pid, sig) { steps.push(`kill ${sig} ${pid}`); },
    async sleep() { /* instant */ },
    now: (() => { let t = 0; return () => (t += 100); })(),
  };
  const deps: RollbackDeps = {
    agendHome: home, from: "2.4.0", to: "2.3.4", socket: "agend", probes,
    async stopFleet() { steps.push("stop"); return { ok: o.stopOk ?? true, detail: "agend stop exited 1" }; },
    async fleetGone() { steps.push("gone?"); return o.gone ?? true; },
    async install(v) { steps.push(`npm ${v}`); return { ok: o.installOk ?? true, detail: "npm exited 1" }; },
    async startService() { steps.push("start"); return { ok: true, detail: "" }; },
    out: () => {},
  };
  return { home, deps, steps };
}

describe("agend rollback", () => {
  it("in order: stop, see it gone, close through the recorded client (confirmed), write rollback.json, then npm, then start", async () => {
    const w = world();
    expect(await rollback(w.deps)).toEqual({ ok: true });
    expect(w.steps).toEqual(["stop", "gone?", "tmux list-panes -a -F #{pane_pid}", "tmux display-message -p #{version} #{pid} #{start_time}", "tmux kill-server", "npm 2.3.4", "start"]);
    expect(JSON.parse(readFileSync(join(w.home, "rollback.json"), "utf8"))).toMatchObject({ from: "2.4.0", to: "2.3.4" });
  });

  it.each<[string, Parameters<typeof world>[0], RegExp]>([
    ["no record and no provable pid", { record: false }, /can't be verified: no record of the server AgEnD started/],
    ["a server that does not exit", { serverExits: false }, /did not exit after kill-server/],
    ["agent processes still running after the server went", { panesExit: false }, /agent processes 5001, 5002 from AgEnD's tmux are still running/],
  ])("a failed or unknown close stops before npm: %s", async (_why, o, msg) => {
    const w = world(o);
    const r = await rollback(w.deps);
    expect(r).toMatchObject({ ok: false, stage: "close" });
    expect((r as { message: string }).message).toMatch(msg);
    expect((r as { message: string }).message).toMatch(/Still on 2\.4\.0/);
    expect(w.steps.some(s => s.startsWith("npm") || s === "start")).toBe(false);
    expect(existsSync(join(w.home, "rollback.json"))).toBe(false);
  });

  it("a fleet that does not stop (or stays running): nothing else happens", async () => {
    for (const o of [{ stopOk: false }, { gone: false }]) {
      const w = world(o);
      expect(await rollback(w.deps)).toMatchObject({ ok: false, stage: "stop" });
      expect(w.steps.filter(s => s.startsWith("tmux") || s.startsWith("npm"))).toEqual([]);
    }
  });

  it("no private server running (a systemd stop ended it): straight on to npm", async () => {
    const w = world({ alive: false });
    expect(await rollback(w.deps)).toEqual({ ok: true });
    expect(w.steps).toEqual(["stop", "gone?", "npm 2.3.4", "start"]);
  });

  it("npm fails: still on this version with the fleet stopped, and says how to bring it back", async () => {
    const w = world({ installOk: false });
    expect(await rollback(w.deps)).toEqual({ ok: false, stage: "install", message: "npm could not install 2.3.4 (npm exited 1). Still on 2.4.0 with the fleet stopped; agend start brings it back." });
    expect(w.steps.includes("start")).toBe(false);
  });

  it("refuses what is not a version, before stopping anything", async () => {
    const w = world();
    expect(await rollback({ ...w.deps, to: "latest; rm -rf /" })).toMatchObject({ ok: false });
    expect(w.steps).toEqual([]);
  });
});
