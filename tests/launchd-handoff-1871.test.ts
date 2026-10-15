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
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
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
  spawn: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(command, args, options),
  now: () => new Date("2026-10-15T08:26:54Z"),
};

describe("#1871: who hands off", () => {
  it("an agent session does; an operator's shell and the detached copy itself do not", () => {
    expect(shouldHandOff({ AGEND_INSTANCE_NAME: "probe" })).toBe(true);
    expect(shouldHandOff({})).toBe(false);
    expect(shouldHandOff({ AGEND_INSTANCE_NAME: " " })).toBe(false);
    expect(shouldHandOff({ AGEND_INSTANCE_NAME: "probe", [HANDED_OFF_ENV]: "1" })).toBe(false);
  });
});

describe("#1871: the hand-off", () => {
  it("starts a detached copy with its own origin and the no-repeat marker, output to the log", () => {
    const home = scratch();
    const spawned = vi.fn((_c: string, _a: string[], _o: unknown) => ({ unref: vi.fn() }));
    const result = handOff({ agendHome: home, self: { command: "/node", args: ["/pkg/dist/cli.js", "restart"] }, env: { AGEND_INSTANCE_NAME: "probe", PATH: "/bin" }, action: "restart" },
      { ...realDeps, spawn: spawned });
    expect(result).toEqual({ ok: true, log: join(home, HANDOFF_LOG) });
    const [command, args, options] = spawned.mock.calls[0] as [string, string[], { detached: boolean; stdio: unknown[]; env: NodeJS.ProcessEnv }];
    expect([command, args, options.detached, options.stdio[0]]).toEqual(["/node", ["/pkg/dist/cli.js", "restart"], true, "ignore"]);
    expect(options.env).toMatchObject({ PATH: "/bin", AGEND_INSTANCE_NAME: "probe", [HANDED_OFF_ENV]: "1" });
    expect(options.env[ORIGIN_ENV]).toContain("restart");
    expect(readFileSync(join(home, HANDOFF_LOG), "utf8")).toContain("agend restart, handed off from probe's session");
  });

  it("says why when the copy cannot start (the caller then goes on itself)", () => {
    const home = scratch();
    const result = handOff({ agendHome: home, self: { command: "/node", args: [] }, env: { AGEND_INSTANCE_NAME: "probe" }, action: "update" },
      { ...realDeps, spawn: () => { throw new Error("EAGAIN"); } });
    expect(result).toEqual({ ok: false, reason: "the detached copy did not start: EAGAIN" });
    expect(handOff({ agendHome: join(home, "missing"), self: { command: "/node", args: [] }, env: {}, action: "update" }, realDeps).ok).toBe(false);
  });

  it("the copy outlives the pane: the pane's whole process group is SIGKILLed, the copy still finishes", async () => {
    const home = scratch();
    const done = join(home, "done");
    // The "pane": a process group of its own, running node that hands off a copy which finishes 1.5 s later.
    const script = `
      const { handOff } = await import(${JSON.stringify(new URL("../src/launchd-handoff.ts", import.meta.url).href)});
      const fs = await import("node:fs"); const cp = await import("node:child_process");
      const r = handOff({ agendHome: ${JSON.stringify(home)}, self: { command: "sh", args: ["-c", "sleep 1.5; echo finished > ${done}"] }, env: { ...process.env, AGEND_INSTANCE_NAME: "probe" }, action: "restart" },
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
  const PLIST = "/Users/u/Library/LaunchAgents/com.agend.fleet.plist";
  const setup = (plistOnDisk: string, planned: string, plistPath = PLIST) => {
    const home = scratch();
    const files = new Map<string, string>([[PLIST, plistOnDisk], [planPath(home), JSON.stringify({
      kind: "launchd-activation", label: "com.agend.fleet", plistPath, sha256: createHash("sha256").update(planned).digest("hex"),
      preimage: { plist: "<old/>", tuple: { program: "/old" }, pid: 701 }, pkgDir: "/pkg", createdAt: "2026-10-15T08:26:54.000Z",
    })]]);
    const deps = { readFile: (p: string) => files.get(p) ?? null, removeFile: (p: string) => { files.delete(p); } };
    return { home, files, deps };
  };

  it("the plist it loaded is the planned one: the plan goes", () => {
    const w = setup("<new/>", "<new/>");
    expect(dropConsumedPlan(w.home, PLIST, w.deps)).toBe(true);
    expect(w.files.has(planPath(w.home))).toBe(false);
  });

  it("a plist that changed since, or a plan for another file, stays for `agend restart` to judge", () => {
    const changed = setup("<edited/>", "<new/>");
    expect(dropConsumedPlan(changed.home, PLIST, changed.deps)).toBe(false);
    expect(changed.files.has(planPath(changed.home))).toBe(true);
    const other = setup("<new/>", "<new/>", "/elsewhere.plist");
    expect(dropConsumedPlan(other.home, PLIST, other.deps)).toBe(false);
  });
});
