/**
 * #1450 C6 restart path 2 — launchd's planned activation. A refresh that must not activate (`agend install
 * --no-activate`, as the old 2.1.12 updater runs it) writes and proves the new plist and records a plan; a failed proof
 * leaves the preimage and no plan. `agend restart` admits the plan only when everything still agrees, then performs ONE
 * bootout + bootstrap, rolling back to the RECORDED preimage (the file on disk is already the new plist).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { activateService } from "../src/service-activation.js";
import { admitPlan, planPath, readPlan, refreshLaunchdWithoutActivating, type PlanDeps, type ServicePlan } from "../src/service-plan.js";
import type { ExpectedTuple } from "../src/restart-guard.js";
import type { CommandResult } from "../src/update-install.js";

const PKG = "/Users/u/.npm-global/lib/node_modules/@songsid/agend";
const RT = `${PKG}/node_modules/@songsid/agend-node-darwin-arm64/bin/node`;
const ENTRY = `${PKG}/dist/cli.js`;
const expected: ExpectedTuple = { node: RT, entry: ENTRY };
const PLIST = "/Users/u/Library/LaunchAgents/com.agend.fleet.plist";
const HOME = "/Users/u/.agend";
const TARGET = "gui/501/com.agend.fleet";

const plist = (args: string[]) => `<?xml version="1.0"?><plist><dict><key>Label</key><string>com.agend.fleet</string><key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`;
const OLD_ARGS = [ENTRY, "fleet", "start"];                      // the 2.1 format: the entry as a script
const NEW_ARGS = [RT, ENTRY, "fleet", "start"];
const printed = (args: string[], pid: number, state = "running"): Partial<CommandResult> => ({
  status: 0, stdout: [`${TARGET} = {`, `\tprogram = ${args[0]}`, "\targuments = {", ...args.map(a => `\t\t${a}`), "\t}", "\tenvironment = {", "\t\tPATH => /usr/bin:/bin", "\t}", `\tstate = ${state}`, `\tpid = ${pid}`, "}"].join("\n"),
});

function world(files: Record<string, string>, answers: Array<[RegExp, Partial<CommandResult> | (() => Partial<CommandResult>)]>) {
  const calls: string[] = [];
  // launchd: once a bootout succeeded, the job is gone — the next print says so (113).
  let bootedOut = false;
  const deps: PlanDeps = {
    run: (command, args) => {
      const line = [command, ...args].join(" ");
      calls.push(line);
      if (bootedOut && /^launchctl print/.test(line)) { bootedOut = false; return { status: 113, signal: null, stdout: "", stderr: "Could not find service" }; }
      const a = answers.find(([re]) => re.test(line))?.[1];
      const result = { status: 0, signal: null, stdout: "", stderr: "", ...(typeof a === "function" ? a() : a ?? {}) };
      if (/^launchctl bootout/.test(line) && result.status === 0) bootedOut = true;
      return result;
    },
    readFile: p => files[p] ?? null,
    writeFile: (p, c) => { files[p] = c; calls.push(`write ${p}`); },
    removeFile: p => { delete files[p]; },
    realpath: p => ([RT, ENTRY].includes(p) ? p : null),
    isExecutable: () => false,
    now: () => new Date("2026-10-09T00:00:00Z"),
  };
  return { deps, files, calls };
}
const refresh = (w: ReturnType<typeof world>, newPlist = plist(NEW_ARGS)) =>
  refreshLaunchdWithoutActivating({ label: "com.agend.fleet", target: TARGET, plistPath: PLIST, newPlist, expected, pkgDir: PKG, agendHome: HOME }, w.deps);

describe("the refresh that must not activate (agend install --no-activate on launchd)", () => {
  it("old job loaded = its plist: writes the proven new plist and records the plan (preimage + pid); never bootstraps", () => {
    const w = world({ [PLIST]: plist(OLD_ARGS) }, [[/print/, printed(OLD_ARGS, 701)]]);
    expect(refresh(w)).toMatchObject({ ok: true, planned: true });
    expect(w.files[PLIST]).toBe(plist(NEW_ARGS));
    const plan = readPlan(HOME, w.deps)!;
    expect(plan).toMatchObject({ plistPath: PLIST, pkgDir: PKG, sha256: createHash("sha256").update(plist(NEW_ARGS)).digest("hex"), preimage: { plist: plist(OLD_ARGS), pid: 701 } });
    expect(w.calls.some(c => /bootout|bootstrap|kickstart/.test(c))).toBe(false);
  });

  it.each([[113, "no such service"], [125, "no gui domain in this session (SSH, nobody logged in)"]])("nothing loaded (%s, %s): the plist is written, nothing is planned", (status) => {
    const w = world({}, [[/print/, { status }]]);
    expect(refresh(w)).toMatchObject({ ok: true, planned: false });
    expect(w.files[planPath(HOME)]).toBeUndefined();
  });
  it("any other print exit is uncertainty: refused, nothing written", () => {
    const w = world({ [PLIST]: plist(OLD_ARGS) }, [[/print/, { status: 5 }]]);
    expect(refresh(w)).toMatchObject({ ok: false, message: expect.stringContaining("could not tell") });
    expect(w.files[PLIST]).toBe(plist(OLD_ARGS));
  });

  it.each([
    ["the loaded job is not its plist", [[/print/, printed([RT, "/elsewhere/cli.js", "fleet", "start"], 7)]], "no job to roll back to"],
    ["launchctl print timed out", [[/print/, { status: null, signal: "SIGTERM" }]], "could not tell"],
  ] as const)("refused with nothing changed: %s", (_n, answers, why) => {
    const w = world({ [PLIST]: plist(OLD_ARGS) }, answers as never);
    expect(refresh(w)).toMatchObject({ ok: false, message: expect.stringContaining(why) });
    expect(w.files[PLIST]).toBe(plist(OLD_ARGS));
    expect(w.files[planPath(HOME)]).toBeUndefined();
  });

  // #1473 review: a refresh revokes the previous plan FIRST — a refusal must not leave an older plan admissible.
  it.each([
    ["an uncertain launchctl print", [[/print/, { status: 5 }]]],
    ["a print whose job cannot be read", [[/print/, { status: 0, stdout: "gui/501/com.agend.fleet = {\n\tstate = running\n}" }]]],
    ["a loaded job that is not its plist (owner mismatch)", [[/print/, printed([RT, "/elsewhere/cli.js", "fleet", "start"], 7)]]],
  ] as const)("a refused refresh leaves no earlier plan behind: %s", (_n, answers) => {
    const w = world({ [PLIST]: plist(OLD_ARGS) }, [[/print/, printed(OLD_ARGS, 701)]]);
    expect(refresh(w)).toMatchObject({ ok: true, planned: true });
    expect(readPlan(HOME, w.deps)).not.toBeNull();
    const again = world(w.files, answers as never);
    expect(refresh(again, plist(NEW_ARGS))).toMatchObject({ ok: false });
    expect(again.files[planPath(HOME)]).toBeUndefined();
  });

  it.each([
    ["plutil -lint fails", [[/plutil/, { status: 1 }]], plist(NEW_ARGS), "plutil -lint"],
    ["the new plist leaves its Node to PATH", [], plist(OLD_ARGS), "as a script"],
  ] as const)("a failed proof puts the preimage back and leaves NO plan: %s", (_n, extra, newPlist, why) => {
    const w = world({ [PLIST]: plist(OLD_ARGS), [planPath(HOME)]: "{\"stale\":true}" }, [...(extra as unknown as never[]), [/print/, printed(OLD_ARGS, 701)]]);
    expect(refresh(w, newPlist)).toMatchObject({ ok: false, message: expect.stringContaining(why) });
    expect(w.files[PLIST]).toBe(plist(OLD_ARGS));
    expect(w.files[planPath(HOME)]).toBeUndefined();
  });
});

describe("restart path 2: admitting the plan", () => {
  const planned = () => {
    const w = world({ [PLIST]: plist(OLD_ARGS) }, [[/print/, printed(OLD_ARGS, 701)]]);
    refresh(w);
    return { w, plan: readPlan(HOME, w.deps) as ServicePlan };
  };
  it("everything agrees → admitted", () => {
    const { w, plan } = planned();
    expect(admitPlan(plan, { target: TARGET, expected, pkgDir: PKG }, w.deps)).toEqual({ ok: true });
  });
  it.each([
    ["the plist changed since planning", (w: ReturnType<typeof world>) => { w.files[PLIST] = plist(NEW_ARGS) + " "; }, {}, "changed since"],
    ["another install's plan", () => {}, { pkgDir: "/opt/other" }, "another install"],
    ["the loaded job's pid changed (someone restarted it)", (w: ReturnType<typeof world>) => { w.deps.run = () => ({ status: 0, signal: null, stderr: "", stdout: printed(OLD_ARGS, 702).stdout! }); }, {}, "changed since the activation was planned"],
    ["this package now expects another Node", () => {}, { expected: { node: "/opt/node22/bin/node", entry: ENTRY } }, "not the selected Node"],
  ] as const)("refused: %s", (_n, mutate, override, why) => {
    const { w, plan } = planned();
    mutate(w as never);
    expect(admitPlan(plan, { target: TARGET, expected, pkgDir: PKG, ...override }, w.deps)).toMatchObject({ ok: false, reason: expect.stringContaining(why) });
  });
});

describe("the planned activation itself: one bootout + bootstrap; recovery uses the RECORDED preimage", () => {
  function activate(afterBootstrap: Partial<CommandResult>, recovered: Partial<CommandResult>) {
    let prints = 0;
    const seq = [printed(OLD_ARGS, 701), afterBootstrap, recovered];
    const w = world({ [PLIST]: plist(OLD_ARGS) }, [[/print/, () => seq[Math.min(prints++, seq.length - 1)]!], [/getenv/, { stdout: "" }]]);
    refresh(w);
    prints = 0;
    const plan = readPlan(HOME, w.deps)!;
    const outcome = activateService({ kind: "launchd", label: "com.agend.fleet", plistPath: PLIST, domain: "gui/501" },
      { bin: ENTRY, entry: ENTRY, node: RT, dir: PKG }, {
        ...w.deps, readFirstLine: () => null, isExecutable: () => false,
        refresh: () => { throw new Error("path 2 never refreshes"); }, restart: () => {}, log: () => {}, launchdPreimage: plan.preimage.plist,
        sleep: () => {}, monotonicNow: () => 0,
        restorePackage: () => { w.calls.push("restore-package"); return "The previous package is back in place"; },
      });
    return { w, outcome };
  }
  it("success: exactly one bootout and one bootstrap, no kickstart; the new plist stays", () => {
    const { w, outcome } = activate(printed(NEW_ARGS, 900), {});
    expect(outcome).toEqual({ ok: true, via: "launchd-activation" });
    expect(w.calls.filter(c => /bootout/.test(c))).toHaveLength(1);
    expect(w.calls.filter(c => /bootstrap/.test(c))).toHaveLength(1);
    expect(w.calls.some(c => /kickstart/.test(c))).toBe(false);
    expect(w.files[PLIST]).toBe(plist(NEW_ARGS));
  });
  it("the new job does not run: the RECORDED preimage plist is put back and bootstrapped, and proven running", () => {
    const { w, outcome } = activate({ status: 0, stdout: printed(NEW_ARGS, 0, "exited").stdout!.replace(/\tpid = 0\n/, "") }, printed(OLD_ARGS, 950));
    expect(outcome).toMatchObject({ ok: false, stopped: true, message: expect.stringContaining("Rolled back to the previous job, which is running") });
    expect(w.files[PLIST]).toBe(plist(OLD_ARGS));
    expect(w.calls.filter(c => /bootstrap/.test(c))).toHaveLength(2);
    // The previous job's plist names files inside the package: the package is back BEFORE that job is bootstrapped.
    const restoredAt = w.calls.indexOf("restore-package");
    const rebootAt = w.calls.map((c, i) => [c, i] as const).filter(([c]) => /bootstrap/.test(c))[1]![1];
    expect(restoredAt).toBeGreaterThan(-1);
    expect(restoredAt).toBeLessThan(rebootAt);
    expect(outcome).toMatchObject({ message: expect.stringContaining("The previous package is back in place") });
  });
  it("success: the package is never restored", () => {
    const { w, outcome } = activate(printed(NEW_ARGS, 900), {});
    expect(outcome.ok).toBe(true);
    expect(w.calls).not.toContain("restore-package");
  });
});
