/**
 * #2375: an update's launchd plan whose job launchd already runs counts as carried out (#1871), and `agend restart`
 * then restarts that job as an unchanged one. The plan was never removed, so every later restart judged it again and
 * printed "launchd already runs the job an interrupted update planned" (seen after beta.22's update to beta.23).
 * pendingPlan() treats a carried-out plan as nothing to activate, quietly, and never removes the shared record: a refresh
 * may publish a newer plan while launchd is being asked (Prism, #2376 R1). A plan still to carry out is returned.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { consumeCarriedOutPlan, consumeUnchangedPlan, pendingPlan, refreshLaunchdWithoutActivating, SERVICE_PLAN_FILE, SERVICE_PLAN_LOCK, withFsPlanLock } from "../src/service-plan.js";
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
    const lock = join(home, SERVICE_PLAN_LOCK);
    const seen = join(home, "writer-waiting");
    writeFileSync(plan, "A\n");
    const script = `
      const { mkdirSync, rmdirSync, writeFileSync } = require("node:fs");
      const lock = process.argv[1], plan = process.argv[2], seen = process.argv[3];
      const t = Date.now() + 10000;
      let marked = false;
      for (;;) {
        try {
          mkdirSync(lock);
          writeFileSync(plan, "B\\n");
          try { rmdirSync(lock); } catch {}
          process.exit(0);
        } catch (e) {
          if (e.code !== "EEXIST") { console.error(e); process.exit(1); }
          if (!marked) { writeFileSync(seen, "1"); marked = true; }
          if (Date.now() > t) process.exit(2);
        }
      }
    `;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      consumeUnchangedPlan(home, "A\n", {
        readFile: p => {
          const v = readFileSync(p, "utf8");
          if (p === plan && v === "A\n" && !child) {
            child = spawn(process.execPath, ["-e", script, lock, plan, seen], { stdio: "ignore" });
            const wait = Date.now() + 5000;
            while (!existsSync(seen) && Date.now() < wait) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            expect(existsSync(seen)).toBe(true);
          }
          return v;
        },
        removeFile: p => { try { rmSync(p); } catch { /* absent */ } },
        withPlanLock: fn => withFsPlanLock(home, fn),
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        if (!child) { reject(new Error("writer was not started")); return; }
        child.once("exit", (c, s) => resolve(s ? 1 : c));
        child.once("error", reject);
      });
      expect(code).toBe(0);
      expect(readFileSync(plan, "utf8")).toBe("B\n");
    } finally {
      child?.kill();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
