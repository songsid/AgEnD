// M-3770 slice 2.5, part 7 (design update-wiring-m3770.md §8, §10.7): the scratch end-to-end rig. `agend update`'s
// Phase 2 driver (runTransactionUpdate, the real hands, the real journal, locks and mailbox) runs against a scratch
// home and npm prefix, with STAND-IN fleets — real processes (tests/support/update-rig-fleet.ts) that take fleet.lock
// over by the handoff nonce exactly as claimFleetSingleton does and answer the control mailbox. Never `agend fleet
// start`, never the host's AGEND_HOME, no tmux, no service manager (a detached fleet). npm is a stand-in too.
// The gap the stand-ins leave (a real fleet's trial, its commit hands and hand-back) is the S-261 container run's.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, openSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFleetLockRecord } from "../src/fleet-lock.js";
import { readCurrent, readAttemptRecord } from "../src/update-journal.js";
import { realHostEnv, type HostEnv } from "../src/update-host.js";
import { runTransactionUpdate, type Phase2Env } from "../src/update-phase2.js";
import { selectUpdatePhase } from "../src/update-phase.js";

const REPO = join(import.meta.dirname, "..");
const STAND_IN = join(REPO, "tests", "support", "update-rig-fleet.ts");
const admission = createRequire(import.meta.url)("../launcher/install-admission.cjs") as { processStart(pid: number): string | null; startTicks(pid: number): string | null; bootId(): string | null; exists(pid: number): boolean };
const children: ChildProcess[] = [], dirs: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const until = (ok: () => boolean, ms = 15_000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error("rig: timed out"); sleepSync(50); } };

function installPackage(pkgDir: string, binDir: string, version: string) {
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(join(pkgDir, "dist"), { recursive: true }); mkdirSync(join(pkgDir, "launcher"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@songsid/agend", version, agend: { updateTx: 1 }, bin: { agend: "launcher/agend", "agend-agent": "launcher/agend-agent" } }));
  writeFileSync(join(pkgDir, "dist", "cli.js"), `// ${version}\n`);
  writeFileSync(join(pkgDir, "dist", "recover.cjs"), "// the recovery runner (a stand-in)\n");
  for (const name of ["agend", "agend-agent"]) {
    writeFileSync(join(pkgDir, "launcher", name), `#!/bin/sh\n# ${version}\n`); chmodSync(join(pkgDir, "launcher", name), 0o755);
    rmSync(join(binDir, name), { force: true }); symlinkSync(join(pkgDir, "launcher", name), join(binDir, name));
  }
}

function rig(o: { busy?: boolean; unhealthy?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rig-"))); dirs.push(root);
  const home = join(root, "home"), prefix = join(root, "prefix"), binDir = join(prefix, "bin");
  const pkgDir = join(prefix, "lib", "node_modules", "@songsid", "agend");
  for (const d of [home, binDir, join(prefix, "lib", "node_modules", "@songsid")]) mkdirSync(d, { recursive: true });
  installPackage(pkgDir, binDir, "2.5.0");
  writeFileSync(join(home, "fleet.yaml"), "version: old\n");
  // The Node this install "runs on" (a detached fleet: the updater's own): a stand-in that runs alone, for the kit.
  const node = join(root, "node"); writeFileSync(node, "#!/bin/sh\nexit 0\n"); chmodSync(node, 0o755);
  const spawned: { label: string; argv: string[]; env: Record<string, string> }[] = [];
  const startFleet = (label: string, env: Record<string, string> = {}) => {
    const err = openSync(join(root, `${label}.stderr`), "a");
    const child = spawn(process.execPath, ["--import", "tsx", STAND_IN, home, label], { cwd: REPO, detached: true, stdio: ["ignore", err, err],
      env: { ...process.env, ...env, ...(label === "trial" && o.unhealthy ? { RIG_UNHEALTHY: "1" } : {}), ...(o.busy ? { RIG_BUSY: "1" } : {}) } });
    child.unref(); children.push(child);
    return child;
  };
  const events = () => { try { return readFileSync(join(home, "rig-events.log"), "utf8").trim().split("\n").map(l => l.split(" ").filter((_, i) => i !== 1).join(" ")); } catch { return []; } };
  const host: HostEnv = { ...realHostEnv(), execPath: node,
    spawnDetached: (command, args, env) => {
      const label = spawned.length === 0 ? "trial" : "old-again";
      spawned.push({ label, argv: [command, ...args], env });
      startFleet(label, env);
      return true;
    } };
  const processStart = admission.processStart(process.pid)!;
  const self = { pid: process.pid, start: { processStart } };
  const liveness = { processStart: admission.processStart, startTicks: admission.startTicks, bootId: admission.bootId, exists: admission.exists };
  const npmCalls: string[] = [];
  const env: Phase2Env = {
    host, liveness, self, hex8: () => "e7e7e7e7", date: () => new Date(),
    lockDeps: { ...liveness, startTicks: () => null, bootId: () => null, pid: process.pid, newToken: () => "f".repeat(32), now: () => new Date(), log: () => {} },
    installEnv: { run: (command, args, opts) => { npmCalls.push(`${command} ${args.join(" ")} token=${opts.env.AGEND_INSTALL_TOKEN ? "yes" : "no"}`); installPackage(pkgDir, binDir, "2.5.1"); return { status: 0 }; } },
    proveWritersGone: () => ({ ok: true }),
    waitHandedBack: done => { try { until(done, 15_000); return true; } catch { return false; } },
    proveMs: 3000, log: line => appendFileSync(join(root, "updater.log"), line + "\n"),
    progress: stage => appendFileSync(join(root, "updater.log"), `stage ${stage}\n`),
  };
  const input = { home, target: { name: "@songsid/agend", version: "2.5.1" }, prefix, service: null, cliEntry: join(pkgDir, "dist", "cli.js") };
  const version = () => (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string }).version;
  return { root, home, prefix, pkgDir, node, spawned, startFleet, events, env, input, npmCalls, version };
}

describe("M-3770 2.5 part 7: the scratch end-to-end rig (stand-in fleets, a detached fleet)", () => {
  it("success: barrier held, the old fleet stopped, snapshot, install, the trial taken over by its nonce and proven, committed; the trial is the fleet now", () => {
    const r = rig();
    const old = r.startFleet("old");
    until(() => readFleetLockRecord(r.home)?.pid === old.pid);
    const out = runTransactionUpdate(r.input, r.env);
    expect(out.ran && out.result.ok, JSON.stringify(out)).toBe(true);
    expect(r.version()).toBe("2.5.1");
    expect(readCurrent(r.home).state).toBe("none");
    const trialPid = readFleetLockRecord(r.home)!.pid;
    expect(trialPid).not.toBe(old.pid);
    // The trial started as the transaction proved it: the tuple's Node and entry, with the handoff.
    expect(r.spawned.map(s => [s.label, s.argv])).toEqual([["trial", [r.node, join(r.pkgDir, "dist", "cli.js"), "fleet", "start"]]]);
    expect(r.spawned[0]!.env.AGEND_UPDATE_HANDOFF).toMatch(/^[0-9a-f]{32}$/);
    expect(r.events()).toEqual(expect.arrayContaining(["old barrier held", "old stopped", "trial prove healthy",
      "trial commit leaveTrial", "trial commit startAgents", "trial commit deliverInbox", "trial commit runDeferred"]));
    expect(r.npmCalls).toEqual(["npm exec --yes --package @songsid/agend@2.5.1 -- agend-install --install-only --target 2.5.1 token=yes"]);
    for (const lock of [".update.lock", ".service.lock"]) expect(existsSync(join(r.home, lock)), lock).toBe(false);
    expect(existsSync(join(r.prefix, ".agend-install.lock"))).toBe(false);
  });

  it("failure: the trial doesn't prove itself — rolled back: the previous package and home back, the old version restarted by its own nonce", () => {
    const r = rig({ unhealthy: true });
    const old = r.startFleet("old");
    until(() => readFleetLockRecord(r.home)?.pid === old.pid);
    const out = runTransactionUpdate(r.input, r.env);
    expect(out.ran && !out.result.ok && out.result.outcome, JSON.stringify(out)).toBe("rolled-back");
    expect(r.version()).toBe("2.5.0");
    expect(readFileSync(join(r.home, "fleet.yaml"), "utf8")).toBe("version: old\n");
    expect(readCurrent(r.home).state).toBe("none");
    expect(r.spawned.map(s => s.label)).toEqual(["trial", "old-again"]);
    until(() => r.events().some(e => e.startsWith("old-again up")));
    expect(readFleetLockRecord(r.home)?.role).toBe("fleet");
  });

  it("abandon: the old fleet is busy — nothing installed, the old fleet never stopped, the attempt closed abandoned", () => {
    const r = rig({ busy: true });
    const old = r.startFleet("old");
    until(() => readFleetLockRecord(r.home)?.pid === old.pid);
    const out = runTransactionUpdate(r.input, r.env);
    expect(out.ran && !out.result.ok && out.result.outcome, JSON.stringify(out)).toBe("abandoned");
    expect(r.version()).toBe("2.5.0");
    expect(r.npmCalls).toEqual([]);
    expect(readFleetLockRecord(r.home)?.pid).toBe(old.pid);
    expect(r.events()).not.toContain("old stopped");
    expect(readCurrent(r.home).state).toBe("none");
    const id = r.events().length ? out.ran && out.result.attempt.id : "";
    expect(id && readAttemptRecord(r.home, id)?.stage).toBe("abandoned");
  });

  it("launchd-shaped (S-260's baseline): selection keeps today's updater; nothing of the transaction runs", () => {
    expect(selectUpdatePhase({ switchedOn: true, preflightClass: "self", runningTx: 1, targetTx: 1, service: "launchd", requestContext: "off", journal: "none" }))
      .toEqual({ phase: 1, why: "macOS service installs keep today's updater for now (S-260)" });
  });
});
