/**
 * #1871: a Mac user's 2.1.12 → 2.2 update, run from an agent's pane, left the fleet down and its launchd plan pending.
 * The new `agend restart` admitted the plan and booted the job out; the fleet's stop then killed the agent's CLI, and
 * the restart with it, before the bootstrap. (Reproduced on the real-Mac test host.)
 * - From an agent session, the activation is handed to a detached copy that survives the pane's process group being
 *   killed; the copy carries its own origin and never hands off again.
 * - `agend start` drops the plan whose plist it has just loaded, so a later `agend restart` is not refused over it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDED_OFF_ENV, HANDOFF_LOG, handOff, shouldHandOff } from "../src/launchd-handoff.js";
import { ORIGIN_ENV } from "../src/fleet-control-audit.js";
import { dropConsumedPlan, planPath } from "../src/service-plan.js";

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

describe("#1871: agend start drops the plan it has just carried out", () => {
  // A real directory: the record is claimed with the real rename(2) and put back with the real link(2).
  const record = (plistPath: string, planned: string) => JSON.stringify({
    kind: "launchd-activation", label: "com.agend.fleet", plistPath, sha256: createHash("sha256").update(planned).digest("hex"),
    preimage: { plist: "<old/>", tuple: { program: "/old" }, pid: 701 }, pkgDir: "/pkg", createdAt: "2026-10-15T08:26:54.000Z",
  });
  const setup = (plistOnDisk: string, planned: string, plannedFor?: string) => {
    const home = scratch();
    const plist = join(home, "com.agend.fleet.plist");
    writeFileSync(plist, plistOnDisk);
    writeFileSync(planPath(home), record(plannedFor ?? plist, planned));
    let claims = 0;
    const deps = {
      readFile: (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
      removeFile: (p: string) => { try { unlinkSync(p); } catch { /* absent */ } },
      rename: (from: string, to: string) => { try { renameSync(from, to); return true; } catch { return false; } },
      link: (from: string, to: string) => { try { linkSync(from, to); return true; } catch { return false; } },
      claimPath: (r: string) => `${r}.consumed-test-${++claims}`,
    };
    /** What a concurrent `install --no-activate` does: revoke the plan, write the new plist, record its plan. */
    const refreshTo = (next: string) => { deps.removeFile(planPath(home)); writeFileSync(plist, next); writeFileSync(planPath(home), record(plist, next)); };
    /** Which plan the record holds now: "A", "B", "C" or null. */
    const pending = () => {
      const p = deps.readFile(planPath(home));
      if (!p) return null;
      const sha = JSON.parse(p).sha256;
      return ["A", "B", "C"].find(x => createHash("sha256").update(`<${x}/>`).digest("hex") === sha) ?? "?";
    };
    const leftovers = () => readdirSync(home).filter(f => f.includes(".consumed-"));
    return { home, plist, deps, refreshTo, pending, leftovers };
  };

  it("control: it bootstrapped A, the plan is A and A is still on disk → the plan goes", () => {
    const w = setup("<A/>", "<A/>");
    expect(dropConsumedPlan(w.home, w.plist, "<A/>", w.deps)).toBe(true);
    expect([existsSync(planPath(w.home)), w.leftovers()]).toEqual([false, []]);
  });

  it("Prism's r1 witness: it bootstrapped A, a refresh meanwhile wrote B and planned B → plan B stays", () => {
    const w = setup("<A/>", "<A/>");
    w.refreshTo("<B/>");
    expect(dropConsumedPlan(w.home, w.plist, "<A/>", w.deps)).toBe(false);
    expect(w.pending()).toBe("B");
  });

  it("Prism's r2 witness: B is published right after the last read saw A → B survives the consume (claimed, judged, put back)", () => {
    const w = setup("<A/>", "<A/>");
    const read = w.deps.readFile;
    let raced = false;
    w.deps.readFile = (p: string) => {
      const text = read(p);
      if (p === w.plist && !raced) { raced = true; w.refreshTo("<B/>"); }   // another process, between the read and what follows
      return text;
    };
    expect(dropConsumedPlan(w.home, w.plist, "<A/>", w.deps)).toBe(false);
    expect([w.pending(), w.leftovers()]).toEqual(["B", []]);
  });

  it("put-back never overwrites: B is claimed, C is published before B could go back → C stays, B goes", () => {
    const w = setup("<A/>", "<A/>");
    const read = w.deps.readFile, rename = w.deps.rename;
    let raced = false;
    w.deps.readFile = (p: string) => { const text = read(p); if (p === w.plist && !raced) { raced = true; w.refreshTo("<B/>"); } return text; };
    w.deps.rename = (from: string, to: string) => { const done = rename(from, to); w.refreshTo("<C/>"); return done; };
    expect(dropConsumedPlan(w.home, w.plist, "<A/>", w.deps)).toBe(false);
    expect([w.pending(), w.leftovers()]).toEqual(["C", []]);
  });

  it("a plan for A whose file has changed since, or a plan for another file, stays for `agend restart` to judge", () => {
    const changed = setup("<edited/>", "<A/>");
    expect(dropConsumedPlan(changed.home, changed.plist, "<A/>", changed.deps)).toBe(false);
    expect(existsSync(planPath(changed.home))).toBe(true);
    const other = setup("<A/>", "<A/>", "/elsewhere.plist");
    expect(dropConsumedPlan(other.home, other.plist, "<A/>", other.deps)).toBe(false);
    expect(existsSync(planPath(other.home))).toBe(true);
  });
});
