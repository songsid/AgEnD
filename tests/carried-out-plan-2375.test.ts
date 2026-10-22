/**
 * #2375: an update's launchd plan whose job launchd already runs counts as carried out (#1871), and `agend restart`
 * then restarts that job as an unchanged one. The plan was never removed, so every later restart judged it again and
 * printed "launchd already runs the job an interrupted update planned" (seen after beta.22's update to beta.23).
 * pendingPlan() treats a carried-out plan as nothing to activate, quietly, and never removes the shared record: a refresh
 * may publish a newer plan while launchd is being asked (Prism, #2376 R1). A plan still to carry out is returned.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { consumeCarriedOutPlan, consumeUnchangedPlan, pendingPlan, refreshLaunchdWithoutActivating, revokePlan, SERVICE_PLAN_FILE, SERVICE_PLAN_LOCK, withFsPlanLock } from "../src/service-plan.js";
import type { CommandResult } from "../src/update-install.js";

const HOME = "/Users/u/.agend";
const PLAN = `${HOME}/service-plan.json`;
const PKG = "/Users/u/.npm-global/lib/node_modules/@songsid/agend";
const RT = `${PKG}/node_modules/@songsid/agend-node-darwin-arm64/bin/node`;
const ENTRY = `${PKG}/dist/cli.js`;
const PLIST = "/Users/u/Library/LaunchAgents/com.agend.fleet.plist";
const TARGET = "gui/501/com.agend.fleet";
const plist = (args: string[]) => `<?xml version="1.0"?><plist><dict><key>Label</key><string>com.agend.fleet</string><key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`;
const OLD = [`${PKG}/bin/agend`, "fleet", "start"];
const NEW = [RT, ENTRY, "fleet", "start"];
const printed = (args: string[], pid: number): Partial<CommandResult> => ({
  status: 0, stdout: [`${TARGET} = {`, `\tprogram = ${args[0]}`, "\targuments = {", ...args.map(a => `\t\t${a}`), "\t}", "\tenvironment = {", "\t\tPATH => /usr/bin:/bin", "\t}", "\tstate = running", `\tpid = ${pid}`, "}"].join("\n"),
});

/** A plan recorded by the real refresh against the old job (pid 701), as an update's `install --no-activate` does. */
function planned() {
  const files: Record<string, string> = { [PLIST]: plist(OLD) };
  let loaded: Partial<CommandResult> = printed(OLD, 701);
  const removed: string[] = [];
  const deps = {
    run: (_c: string, _a: string[]) => ({ status: 0, signal: null, stdout: "", stderr: "", ...loaded }) as CommandResult,
    readFile: (p: string) => files[p] ?? null,
    writeFile: (p: string, c: string) => { files[p] = c; },
    removeFile: (p: string) => { removed.push(p); delete files[p]; },
    withPlanLock: (fn: () => void) => fn(),
    realpath: (p: string) => ([RT, ENTRY].includes(p) ? p : null),
    isExecutable: () => false,
    now: () => new Date("2026-10-22T02:00:00Z"),
  };
  const out = refreshLaunchdWithoutActivating({ label: "com.agend.fleet", target: TARGET, plistPath: PLIST, newPlist: plist(NEW), expected: { node: RT, entry: ENTRY }, pkgDir: PKG, agendHome: HOME }, deps);
  expect(out).toMatchObject({ ok: true, planned: true });
  removed.length = 0;
  // The deps `agend restart` really has (planDeps: it can write and delete): any removal pendingPlan made would show.
  const restartDeps = deps;
  return { files, removed, deps, restartDeps, load: (next: Partial<CommandResult>) => { loaded = next; } };
}

/** Another CLI waits: a nested withPlanLock is queued until the holder releases (not re-entrant). */
function queuedPlanLock(): (fn: () => void) => void {
  const wait: Array<() => void> = [];
  let held = false;
  const run = (fn: () => void) => {
    if (held) { wait.push(fn); return; }
    held = true;
    try { fn(); }
    finally {
      held = false;
      const next = wait.shift();
      if (next) run(next);
    }
  };
  return run;
}

describe("pendingPlan (#2375)", () => {
  it("carried out (launchd already runs the planned job): nothing to activate, every time — the record is left alone", () => {
    const w = planned();
    w.load(printed(NEW, 41363));
    const record = w.files[PLAN];
    expect(pendingPlan(HOME, TARGET, w.restartDeps)).toBeNull();
    expect(pendingPlan(HOME, TARGET, w.restartDeps)).toBeNull();         // the next restart: the same answer, no note
    expect([w.files[PLAN], w.removed]).toEqual([record, []]);
  });

  it("a newer plan published by a real refresh while launchd is asked survives, and is the next restart's plan (Prism, #2376 R1)", () => {
    const w = planned();
    w.load(printed(NEW, 41363));                                       // plan A is carried out: launchd runs its job
    const OTHER = "/Users/u/other-prefix/lib/node_modules/@songsid/agend";
    const RT2 = `${OTHER}/node_modules/@songsid/agend-node-darwin-arm64/bin/node`, ENTRY2 = `${OTHER}/dist/cli.js`;
    let published = "";
    const interleaved = {
      ...w.deps,
      run: (c: string, a: string[]) => {
        if (!published) {                                              // during pendingPlan's launchctl print: install B
          const out = refreshLaunchdWithoutActivating({ label: "com.agend.fleet", target: TARGET, plistPath: PLIST, newPlist: plist([RT2, ENTRY2, "fleet", "start"]), expected: { node: RT2, entry: ENTRY2 }, pkgDir: OTHER, agendHome: HOME },
            { ...w.deps, realpath: (p: string) => ([RT, ENTRY, RT2, ENTRY2].includes(p) ? p : null) });
          expect(out).toMatchObject({ ok: true, planned: true });
          published = w.files[PLAN]!;
        }
        return w.restartDeps.run(c, a);
      },
    };
    expect(pendingPlan(HOME, TARGET, interleaved)).toBeNull();          // A's answer, judged on what it read
    expect(w.files[PLAN]).toBe(published);                              // B's record is still there…
    expect(w.removed).toEqual([PLAN]);                                  // (B's own refresh revoked A; nothing else removed)
    expect(pendingPlan(HOME, TARGET, w.restartDeps)).toMatchObject({ plistPath: PLIST, sha256: expect.any(String) });   // …and pending
    expect(JSON.parse(published).sha256).not.toBe(undefined);
  });

  it("still to carry out (the planned-from job runs): returned and kept for admitPlan to activate", () => {
    const w = planned();
    const plan = pendingPlan(HOME, TARGET, w.restartDeps);
    expect(plan).toMatchObject({ plistPath: PLIST });
    expect(w.files[PLAN]).toBeDefined();
    expect(w.removed).toEqual([]);
  });

  it("not carried out for any other reason (another job runs, the plist changed, nothing loaded): kept — admitPlan judges it", () => {
    for (const change of [
      (w: ReturnType<typeof planned>) => w.load(printed(OLD, 702)),
      (w: ReturnType<typeof planned>) => { w.files[PLIST] = plist([...NEW, "--other"]); w.load(printed(NEW, 41363)); },
      (w: ReturnType<typeof planned>) => w.load({ status: 113, stdout: "" }),
    ]) {
      const w = planned();
      change(w);
      expect(pendingPlan(HOME, TARGET, w.restartDeps)).not.toBeNull();
      expect(w.removed).toEqual([]);
    }
  });

  it("no plan at all: null, and launchd is not even asked", () => {
    expect(pendingPlan(HOME, TARGET, { readFile: () => null, run: () => { throw new Error("no print without a plan"); } })).toBeNull();
  });

  it("`agend restart` takes its plan from pendingPlan (not with --force), and no longer prints the note", () => {
    // pendingPlan's deps have no removeFile: its type alone keeps it from deleting the shared record.
    const source = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
    expect(source).toContain("const plan = opts.force ? null : pendingPlan(DATA_DIR, target, deps);");
    expect(source).not.toContain("an interrupted update planned; restarting it as it is");
    expect(source).toContain("consumeCarriedOutPlan(DATA_DIR, target, deps)");
    expect(source).toContain("consumeUnchangedPlan(DATA_DIR, published, deps)");
    const planSrc = readFileSync(join(process.cwd(), "src", "service-plan.ts"), "utf8");
    expect(planSrc).toContain('Pick<PlanDeps, "readFile" | "run">');
    expect(planSrc).toContain("deps.withPlanLock(() => {");
    expect(planSrc).toContain("if (deps.readFile(path) === snapshot) deps.removeFile(path);");
  });
});

describe("consumeCarriedOutPlan (#2439)", () => {
  it("a carried-out plan is removed after the job already runs (the leftover a normal launchd update left)", () => {
    const w = planned();
    w.load(printed(NEW, 41363));
    expect(pendingPlan(HOME, TARGET, w.restartDeps)).toBeNull();
    expect(w.files[PLAN]).toBeDefined();
    consumeCarriedOutPlan(HOME, TARGET, w.restartDeps);
    expect(w.files[PLAN]).toBeUndefined();
    expect(w.removed).toEqual([PLAN]);
  });

  it("a newer plan published while launchd is asked is left (Prism, #2376)", () => {
    const w = planned();
    w.load(printed(NEW, 41363));
    const OTHER = "/Users/u/other-prefix/lib/node_modules/@songsid/agend";
    const RT2 = `${OTHER}/node_modules/@songsid/agend-node-darwin-arm64/bin/node`, ENTRY2 = `${OTHER}/dist/cli.js`;
    let published = "";
    const interleaved = {
      ...w.restartDeps,
      run: (c: string, a: string[]) => {
        if (!published) {
          const out = refreshLaunchdWithoutActivating({ label: "com.agend.fleet", target: TARGET, plistPath: PLIST, newPlist: plist([RT2, ENTRY2, "fleet", "start"]), expected: { node: RT2, entry: ENTRY2 }, pkgDir: OTHER, agendHome: HOME },
            { ...w.deps, realpath: (p: string) => ([RT, ENTRY, RT2, ENTRY2].includes(p) ? p : null) });
          expect(out).toMatchObject({ ok: true, planned: true });
          published = w.files[PLAN]!;
        }
        return w.restartDeps.run(c, a);
      },
    };
    consumeCarriedOutPlan(HOME, TARGET, interleaved);
    expect(w.files[PLAN]).toBe(published);
    expect(pendingPlan(HOME, TARGET, w.restartDeps)).toMatchObject({ plistPath: PLIST });
  });

  it("a plan still to carry out is not removed", () => {
    const w = planned();
    const record = w.files[PLAN];
    consumeCarriedOutPlan(HOME, TARGET, w.restartDeps);
    expect(w.files[PLAN]).toBe(record);
    expect(w.removed).toEqual([]);
  });

  it("consumeUnchangedPlan leaves a replacement published after the snapshot", () => {
    const w = planned();
    const snapshot = w.files[PLAN]!;
    w.files[PLAN] = snapshot.replace(PKG, "/other");
    consumeUnchangedPlan(HOME, snapshot, w.restartDeps);
    expect(w.files[PLAN]).toBe(snapshot.replace(PKG, "/other"));
    expect(w.removed).toEqual([]);
    consumeUnchangedPlan(HOME, w.files[PLAN]!, w.restartDeps);
    expect(w.files[PLAN]).toBeUndefined();
  });

  it("a newer plan published after the comparison read is left (final-read/publication)", () => {
    const w = planned();
    w.load(printed(NEW, 41363));
    const snapshot = w.files[PLAN]!;
    const OTHER = "/Users/u/other-prefix/lib/node_modules/@songsid/agend";
    const RT2 = `${OTHER}/node_modules/@songsid/agend-node-darwin-arm64/bin/node`, ENTRY2 = `${OTHER}/dist/cli.js`;
    const withPlanLock = queuedPlanLock();
    const refreshDeps = {
      ...w.deps,
      withPlanLock,
      realpath: (p: string) => ([RT, ENTRY, RT2, ENTRY2].includes(p) ? p : null),
    };
    const publishB = () => {
      const out = refreshLaunchdWithoutActivating({
        label: "com.agend.fleet", target: TARGET, plistPath: PLIST, newPlist: plist([RT2, ENTRY2, "fleet", "start"]),
        expected: { node: RT2, entry: ENTRY2 }, pkgDir: OTHER, agendHome: HOME,
      }, refreshDeps);
      expect(out).toMatchObject({ ok: true, planned: true });
    };
    const interleaved = {
      ...w.restartDeps,
      withPlanLock,
      readFile: (p: string) => {
        const v = w.restartDeps.readFile(p);
        if (p === PLAN && v === snapshot) publishB();
        return v;
      },
    };
    consumeUnchangedPlan(HOME, snapshot, interleaved);
    expect(w.files[PLAN]).toBeDefined();
    expect(JSON.parse(w.files[PLAN]!).pkgDir).toBe(OTHER);
    expect(pendingPlan(HOME, TARGET, w.restartDeps)).toMatchObject({ plistPath: PLIST, pkgDir: OTHER });
  });

  it("consumeCarriedOutPlan: a newer plan published after the comparison read is left", () => {
    const w = planned();
    w.load(printed(NEW, 41363));
    const snapshot = w.files[PLAN]!;
    const OTHER = "/Users/u/other-prefix/lib/node_modules/@songsid/agend";
    const RT2 = `${OTHER}/node_modules/@songsid/agend-node-darwin-arm64/bin/node`, ENTRY2 = `${OTHER}/dist/cli.js`;
    const withPlanLock = queuedPlanLock();
    let planReads = 0;
    const refreshDeps = {
      ...w.deps,
      withPlanLock,
      realpath: (p: string) => ([RT, ENTRY, RT2, ENTRY2].includes(p) ? p : null),
    };
    const interleaved = {
      ...w.restartDeps,
      withPlanLock,
      readFile: (p: string) => {
        const v = w.restartDeps.readFile(p);
        if (p === PLAN) {
          planReads++;
          if (planReads === 2 && v === snapshot) {
            const out = refreshLaunchdWithoutActivating({
              label: "com.agend.fleet", target: TARGET, plistPath: PLIST, newPlist: plist([RT2, ENTRY2, "fleet", "start"]),
              expected: { node: RT2, entry: ENTRY2 }, pkgDir: OTHER, agendHome: HOME,
            }, refreshDeps);
            expect(out).toMatchObject({ ok: true, planned: true });
          }
        }
        return v;
      },
    };
    consumeCarriedOutPlan(HOME, TARGET, interleaved);
    expect(JSON.parse(w.files[PLAN]!).pkgDir).toBe(OTHER);
    expect(pendingPlan(HOME, TARGET, w.restartDeps)).toMatchObject({ pkgDir: OTHER });
  });
});

const PLAN_LOCK_MOD = pathToFileURL(join(process.cwd(), "src/service-plan.ts")).href;
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function waitFor(path: string, ms = 5000): void {
  const until = Date.now() + ms;
  while (!existsSync(path) && Date.now() < until) sleepSync(20);
}
function childExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const finish = (c: number | null, s: NodeJS.Signals | null) => resolve(s ? 1 : c);
    child.once("exit", finish);
    child.once("error", reject);
    if (child.exitCode !== null || child.signalCode) finish(child.exitCode, child.signalCode);
  });
}
function lockChild(home: string, body: string): ReturnType<typeof spawn> {
  const script = `
    const { withFsPlanLock } = await import(${JSON.stringify(PLAN_LOCK_MOD)});
    const fs = await import("node:fs");
    const home = process.env.AGEND_TEST_HOME;
    const { writeFileSync, readFileSync, existsSync } = fs;
    ${body}
  `;
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), stdio: "ignore", env: { ...process.env, AGEND_TEST_HOME: home },
  });
}
function exitedPid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (!pid) throw new Error("no pid");
  return pid;
}
function plantDeadLock(home: string, pid = exitedPid()): string {
  const lock = join(home, SERVICE_PLAN_LOCK);
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, String(pid)), `${pid}\n`, { mode: 0o600 });
  return lock;
}

describe("withFsPlanLock (#2441)", () => {
  it("uncontended consume removes the snapshot and drops the lock dir", () => {
    const home = mkdtempSync(join(tmpdir(), "agend-2439-"));
    try {
      writeFileSync(join(home, SERVICE_PLAN_FILE), "A\n");
      consumeUnchangedPlan(home, "A\n", {
        readFile: p => { try { return readFileSync(p, "utf8"); } catch { return null; } },
        removeFile: p => { try { rmSync(p); } catch { /* absent */ } },
        withPlanLock: fn => withFsPlanLock(home, fn),
      });
      expect(existsSync(join(home, SERVICE_PLAN_FILE))).toBe(false);
      expect(existsSync(join(home, SERVICE_PLAN_LOCK))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("an independent writer after the comparison read keeps its replacement", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-2439-"));
    const plan = join(home, SERVICE_PLAN_FILE);
    const seen = join(home, "writer-waiting");
    writeFileSync(plan, "A\n");
    let child: ReturnType<typeof spawn> | undefined;
    let childDone: Promise<number | null> | undefined;
    try {
      consumeUnchangedPlan(home, "A\n", {
        readFile: p => {
          const v = readFileSync(p, "utf8");
          if (p === plan && v === "A\n" && !child) {
            child = lockChild(home, `
              writeFileSync(${JSON.stringify(seen)}, "1");
              withFsPlanLock(home, () => writeFileSync(${JSON.stringify(plan)}, "B\\n"));
            `);
            childDone = childExit(child);
            waitFor(seen);
            expect(existsSync(seen)).toBe(true);
          }
          return v;
        },
        removeFile: p => { try { rmSync(p); } catch { /* absent */ } },
        withPlanLock: fn => withFsPlanLock(home, fn),
      });
      if (!childDone) throw new Error("writer was not started");
      expect(await childDone).toBe(0);
      expect(readFileSync(plan, "utf8")).toBe("B\n");
    } finally {
      child?.kill();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("competing reclaimers of a dead lock do not enter the section together", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-2439-"));
    const overlap = join(home, "overlap");
    const holder = join(home, "holder");
    plantDeadLock(home);
    const body = `
      withFsPlanLock(home, () => {
        writeFileSync(${JSON.stringify(holder)}, String(process.pid));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        if (readFileSync(${JSON.stringify(holder)}, "utf8") !== String(process.pid)) {
          writeFileSync(${JSON.stringify(overlap)}, "1");
        }
      });
    `;
    const a = lockChild(home, body), b = lockChild(home, body);
    const aDone = childExit(a), bDone = childExit(b);
    try {
      expect(await aDone).toBe(0);
      expect(await bDone).toBe(0);
      expect(existsSync(overlap)).toBe(false);
      expect(existsSync(join(home, SERVICE_PLAN_LOCK))).toBe(false);
    } finally {
      a.kill(); b.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  it("a stale reclaim of a dead generation cannot drop a live successor (real lock)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-2439-"));
    const holding = join(home, "holding");
    const second = join(home, "second");
    const release = join(home, "release");
    const dead = exitedPid();
    const lock = plantDeadLock(home, dead);
    const holder = lockChild(home, `
      withFsPlanLock(home, () => {
        writeFileSync(${JSON.stringify(holding)}, String(process.pid));
        const t = Date.now() + 8000;
        while (!existsSync(${JSON.stringify(release)}) && Date.now() < t) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      });
    `);
    const holderDone = childExit(holder);
    let waiter: ReturnType<typeof spawn> | undefined;
    let waiterDone: Promise<number | null> | undefined;
    try {
      waitFor(holding);
      const successor = readFileSync(holding, "utf8").trim();
      try { rmSync(join(lock, String(dead))); } catch { /* already reclaimed */ }
      try { rmdirSync(lock); } catch (e) {
        expect((e as NodeJS.ErrnoException).code).toBe("ENOTEMPTY");
      }
      expect(existsSync(lock)).toBe(true);
      expect(readdirSync(lock)).toContain(successor);
      waiter = lockChild(home, `
        withFsPlanLock(home, () => writeFileSync(${JSON.stringify(second)}, String(process.pid)));
      `);
      waiterDone = childExit(waiter);
      sleepSync(400);
      expect(existsSync(second)).toBe(false);
      writeFileSync(release, "1");
      expect(await holderDone).toBe(0);
      expect(await waiterDone).toBe(0);
      expect(existsSync(second)).toBe(true);
    } finally {
      holder.kill(); waiter?.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  it("a live holder is not stolen (control)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-2439-"));
    const holding = join(home, "holding");
    const second = join(home, "second");
    const release = join(home, "release");
    const holder = lockChild(home, `
      withFsPlanLock(home, () => {
        writeFileSync(${JSON.stringify(holding)}, String(process.pid));
        const t = Date.now() + 8000;
        while (!existsSync(${JSON.stringify(release)}) && Date.now() < t) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      });
    `);
    const holderDone = childExit(holder);
    let waiter: ReturnType<typeof spawn> | undefined;
    let waiterDone: Promise<number | null> | undefined;
    try {
      waitFor(holding);
      waiter = lockChild(home, `
        withFsPlanLock(home, () => writeFileSync(${JSON.stringify(second)}, String(process.pid)));
      `);
      waiterDone = childExit(waiter);
      sleepSync(400);
      expect(existsSync(second)).toBe(false);
      writeFileSync(release, "1");
      expect(await holderDone).toBe(0);
      expect(await waiterDone).toBe(0);
      expect(existsSync(second)).toBe(true);
    } finally {
      holder.kill(); waiter?.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  it("an empty lock left after mkdir (crash before pid) is recovered without waiting out the timeout", () => {
    const home = mkdtempSync(join(tmpdir(), "agend-2439-"));
    try {
      mkdirSync(join(home, SERVICE_PLAN_LOCK), { mode: 0o700 });
      let ran = false;
      const t0 = Date.now();
      withFsPlanLock(home, () => { ran = true; });
      expect(ran).toBe(true);
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(existsSync(join(home, SERVICE_PLAN_LOCK))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("invalid leftover pid content is recovered without waiting out the timeout", () => {
    const home = mkdtempSync(join(tmpdir(), "agend-2439-"));
    try {
      const lock = join(home, SERVICE_PLAN_LOCK);
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "pid"), "\n", { mode: 0o600 });
      let ran = false;
      const t0 = Date.now();
      withFsPlanLock(home, () => { ran = true; });
      expect(ran).toBe(true);
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("revokePlan on a missing AGEND_HOME creates it privately and does not throw", () => {
    const root = mkdtempSync(join(tmpdir(), "agend-2439-"));
    const home = join(root, "missing");
    try {
      expect(existsSync(home)).toBe(false);
      revokePlan(home, {
        removeFile: p => { try { rmSync(p); } catch { /* absent */ } },
        withPlanLock: fn => withFsPlanLock(home, fn),
      });
      expect(existsSync(home)).toBe(true);
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(existsSync(join(home, SERVICE_PLAN_LOCK))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
