/**
 * #1871: a Mac user's 2.1.12 → 2.2 update, run from an agent's pane, left the fleet down and its launchd plan pending.
 * The new `agend restart` admitted the plan and booted the job out; the fleet's stop then killed the agent's CLI, and
 * the restart with it, before the bootstrap. (Reproduced on the real-Mac test host.)
 * - From an agent session, the activation is handed to a detached copy that survives the pane's process group being
 *   killed; the copy carries its own origin and never hands off again.
 * - A plan whose job launchd already runs (the interrupted update, then `agend start`) counts as carried out, so
 *   `agend restart` restarts that job instead of refusing it — read-only, nothing deleted or moved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDED_OFF_ENV, HANDOFF_LOG, handOff, shouldHandOff } from "../src/launchd-handoff.js";
import { ORIGIN_ENV } from "../src/fleet-control-audit.js";
import { planCarriedOut, refreshLaunchdWithoutActivating, type ServicePlan } from "../src/service-plan.js";
import type { CommandResult } from "../src/update-install.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-1871-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const realDeps = {
  open: (path: string) => openSync(path, "a", 0o600),
  write: (fd: number, text: string) => { writeSync(fd, text); },
  close: (fd: number) => closeSync(fd),
  spawn: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(command, args, options!),
  now: () => new Date("2026-10-15T08:26:54Z"),
};

/** A ChildProcess stand-in that reports its launch the way Node does: an event, after spawn() has returned. */
function fakeChild(outcome: "spawn" | Error) {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  setImmediate(() => { if (outcome === "spawn") child.emit("spawn"); else child.emit("error", outcome); });
  return child;
}

describe("#1871: who hands off", () => {
  it("an agent session does; an operator's shell and the detached copy itself do not", () => {
    expect(shouldHandOff({ AGEND_INSTANCE_NAME: "probe" })).toBe(true);
    expect(shouldHandOff({})).toBe(false);
    expect(shouldHandOff({ AGEND_INSTANCE_NAME: " " })).toBe(false);
    expect(shouldHandOff({ AGEND_INSTANCE_NAME: "probe", [HANDED_OFF_ENV]: "1" })).toBe(false);
  });
});

describe("#1871: the hand-off", () => {
  it("starts a detached copy with its own origin and the no-repeat marker, output to the log", async () => {
    const home = scratch();
    const child = fakeChild("spawn");
    const spawned = vi.fn((_c: string, _a: string[], _o: unknown) => child);
    const result = await handOff({ agendHome: home, self: { command: "/node", args: ["/pkg/dist/cli.js", "restart"] }, env: { AGEND_INSTANCE_NAME: "probe", PATH: "/bin" }, action: "restart" },
      { ...realDeps, spawn: spawned });
    expect(result).toEqual({ ok: true, log: join(home, HANDOFF_LOG) });
    const [command, args, options] = spawned.mock.calls[0] as [string, string[], { detached: boolean; stdio: unknown[]; env: NodeJS.ProcessEnv }];
    expect([command, args, options.detached, options.stdio[0]]).toEqual(["/node", ["/pkg/dist/cli.js", "restart"], true, "ignore"]);
    expect(options.env).toMatchObject({ PATH: "/bin", AGEND_INSTANCE_NAME: "probe", [HANDED_OFF_ENV]: "1" });
    expect(options.env[ORIGIN_ENV]).toContain("restart");
    expect(readFileSync(join(home, HANDOFF_LOG), "utf8")).toContain("agend restart, handed off from probe's session");
    expect(child.unref).toHaveBeenCalled();
  });

  it("a launch that fails is reported, not handed off — also when Node reports it as an event after spawn() returned", async () => {
    const home = scratch();
    const late = fakeChild(Object.assign(new Error("spawn /node EAGAIN"), { code: "EAGAIN" }));
    const result = await handOff({ agendHome: home, self: { command: "/node", args: [] }, env: { AGEND_INSTANCE_NAME: "probe" }, action: "update" },
      { ...realDeps, spawn: () => late });
    expect(result).toEqual({ ok: false, reason: "the detached copy did not start: spawn /node EAGAIN" });
    expect(late.unref).not.toHaveBeenCalled();
    // The real thing: a missing executable is an `error` event (ENOENT), never an exception, and never ok.
    const missing = await handOff({ agendHome: home, self: { command: join(home, "no-such-node"), args: [] }, env: { AGEND_INSTANCE_NAME: "probe" }, action: "restart" }, realDeps);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.reason).toContain("ENOENT");
    const thrown = await handOff({ agendHome: home, self: { command: "/node", args: [] }, env: { AGEND_INSTANCE_NAME: "probe" }, action: "update" },
      { ...realDeps, spawn: () => { throw new Error("EINVAL"); } });
    expect(thrown).toEqual({ ok: false, reason: "the detached copy did not start: EINVAL" });
    expect((await handOff({ agendHome: join(home, "missing"), self: { command: "/node", args: [] }, env: {}, action: "update" }, realDeps)).ok).toBe(false);
  });

  it("the copy outlives the pane: the pane's whole process group is SIGKILLed, the copy still finishes", async () => {
    const home = scratch();
    const done = join(home, "done");
    // The "pane": a process group of its own, running node that hands off a copy which finishes 1.5 s later.
    const script = `
      const { handOff } = await import(${JSON.stringify(new URL("../src/launchd-handoff.ts", import.meta.url).href)});
      const fs = await import("node:fs"); const cp = await import("node:child_process");
      const r = await handOff({ agendHome: ${JSON.stringify(home)}, self: { command: "sh", args: ["-c", "sleep 1.5; echo finished > ${done}"] }, env: { ...process.env, AGEND_INSTANCE_NAME: "probe" }, action: "restart" },
        { open: p => fs.openSync(p, "a"), write: (fd, t) => fs.writeSync(fd, t), close: fd => fs.closeSync(fd), spawn: (c, a, o) => cp.spawn(c, a, o), now: () => new Date() });
      console.log(JSON.stringify(r)); setInterval(() => {}, 1000);`;
    const pane = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
    const printed = await new Promise<string>(resolve => pane.stdout!.once("data", chunk => resolve(String(chunk))));
    expect(JSON.parse(printed).ok).toBe(true);
    process.kill(-pane.pid!, "SIGKILL");          // what the fleet's stop does to an agent's CLI
    await new Promise(resolve => setTimeout(resolve, 2500));
    expect(existsSync(done) && readFileSync(done, "utf8").trim()).toBe("finished");
  }, 15_000);
});

describe("#1871: a plan whose job launchd already runs is carried out (read-only)", () => {
  const PKG = "/Users/u/.npm-global/lib/node_modules/@songsid/agend";
  const RT = `${PKG}/node_modules/@songsid/agend-node-darwin-arm64/bin/node`;
  const ENTRY = `${PKG}/dist/cli.js`;
  const PLIST = "/Users/u/Library/LaunchAgents/com.agend.fleet.plist";
  const TARGET = "gui/501/com.agend.fleet";
  const plist = (args: string[]) => `<?xml version="1.0"?><plist><dict><key>Label</key><string>com.agend.fleet</string><key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`;
  const OLD = [`${PKG}/bin/agend`, "fleet", "start"];             // 2.1.12's plist: the bin script
  const NEW = [RT, ENTRY, "fleet", "start"];
  const printed = (args: string[], pid: number): Partial<CommandResult> => ({
    status: 0, stdout: [`${TARGET} = {`, `\tprogram = ${args[0]}`, "\targuments = {", ...args.map(a => `\t\t${a}`), "\t}", "\tenvironment = {", "\t\tPATH => /usr/bin:/bin", "\t}", "\tstate = running", `\tpid = ${pid}`, "}"].join("\n"),
  });
  /** The plan the old updater's `install --no-activate` records against the 2.1.12 job (pid 701), by the real refresh. */
  function planned() {
    const files: Record<string, string> = { [PLIST]: plist(OLD) };
    let loaded: Partial<CommandResult> = printed(OLD, 701);
    const deps = {
      run: (_c: string, _a: string[]) => ({ status: 0, signal: null, stdout: "", stderr: "", ...loaded }) as CommandResult,
      readFile: (p: string) => files[p] ?? null,
      writeFile: (p: string, c: string) => { files[p] = c; },
      removeFile: (p: string) => { delete files[p]; },
      realpath: (p: string) => ([RT, ENTRY].includes(p) ? p : null),
      isExecutable: () => false,
      now: () => new Date("2026-10-15T08:26:54Z"),
    };
    const out = refreshLaunchdWithoutActivating({ label: "com.agend.fleet", target: TARGET, plistPath: PLIST, newPlist: plist(NEW), expected: { node: RT, entry: ENTRY }, pkgDir: PKG, agendHome: "/Users/u/.agend" }, deps);
    expect(out).toMatchObject({ ok: true, planned: true });
    const plan = JSON.parse(files["/Users/u/.agend/service-plan.json"]!) as ServicePlan;
    // Only what planCarriedOut may use: a read and a print. Anything that writes, deletes or moves is absent.
    const readOnly = { readFile: deps.readFile, run: deps.run };
    return { plan, files, readOnly, load: (next: Partial<CommandResult>) => { loaded = next; } };
  }

  it("#1871's state: the update died after bootout, `agend start` loaded the planned plist → carried out", () => {
    const w = planned();
    w.load(printed(NEW, 41363));
    expect(planCarriedOut(w.plan, TARGET, w.readOnly)).toBe(true);
    expect(Object.keys(w.files).sort()).toEqual(["/Users/u/.agend/service-plan.json", PLIST]);   // nothing deleted
  });

  it("the planned-from job still runs with its recorded pid → not carried out (admitPlan activates it)", () => {
    const w = planned();
    expect(planCarriedOut(w.plan, TARGET, w.readOnly)).toBe(false);
  });

  it("launchd runs anything but the planned job (the old job respawned, another pid) → not carried out (admitPlan refuses)", () => {
    const w = planned();
    w.load(printed(OLD, 702));
    expect(planCarriedOut(w.plan, TARGET, w.readOnly)).toBe(false);
  });

  it("the plist changed since the plan — even with launchd running the changed one — or nothing is loaded → not carried out", () => {
    const w = planned();
    const other = [RT, ENTRY, "fleet", "start", "--other"];
    w.files[PLIST] = plist(other);
    w.load(printed(NEW, 41363));
    expect(planCarriedOut(w.plan, TARGET, w.readOnly)).toBe(false);
    w.load(printed(other, 41363));                                  // a plan about another plist: admitPlan reports the change
    expect(planCarriedOut(w.plan, TARGET, w.readOnly)).toBe(false);
    const n = planned();
    n.load({ status: 113, stdout: "" });
    expect(planCarriedOut(n.plan, TARGET, n.readOnly)).toBe(false);
  });
});
