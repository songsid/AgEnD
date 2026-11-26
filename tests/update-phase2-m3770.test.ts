// M-3770 slice 2.5, wiring part 5 (design update-wiring-m3770.md §14): `agend update`'s Phase 2 driver — the three locks
// in order (and released, whatever happens), the attempt opened only on a proven install, and the words it says. The
// full forward run on a scratch home with stand-in fleets is part 7's rig; here nothing reaches npm or a fleet.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCurrent } from "../src/update-journal.js";
import { phase2Words, runTransactionUpdate, type Phase2Env } from "../src/update-phase2.js";
import type { HostEnv } from "../src/update-host.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const START = { processStart: "Thu Nov 27 18:00:00 2026" };
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "phase2-")); dirs.push(root);
  const home = join(root, "home"), prefix = join(root, "prefix");
  mkdirSync(home); mkdirSync(prefix);
  return { root, home, prefix };
}
function env(s: ReturnType<typeof scratch>): Phase2Env {
  const host: HostEnv = { run: () => ({ status: 1, stdout: "" }), uid: () => 1000, sleep: () => {}, now: () => 0, realpath: p => p, readFile: () => null,
    exists: pid => pid === process.pid, kill: () => true, spawnDetached: () => true, execPath: "/n/node", unlink: () => true };
  const lockDeps = { pid: process.pid, processStart: (pid: number) => (pid === process.pid ? START.processStart : null), exists: (pid: number) => pid === process.pid,
    newToken: () => "f".repeat(32), now: () => new Date(), log: () => {} };
  return { host, liveness: lockDeps, lockDeps, self: { pid: process.pid, start: START }, hex8: () => "a1b2c3d4", date: () => new Date("2026-11-27T18:00:00Z"),
    installEnv: { run: () => ({ status: 0 }) }, proveWritersGone: () => ({ ok: true }), waitHandedBack: () => true, log: () => {} };
}
const input = (s: ReturnType<typeof scratch>) => ({ home: s.home, target: { name: "@songsid/agend", version: "2.5.1" }, prefix: s.prefix, service: null, cliEntry: join(s.prefix, "dist", "cli.js") });
const lockFiles = (s: ReturnType<typeof scratch>) => [...readdirSync(s.home).filter(n => n.endsWith(".lock")), ...readdirSync(s.prefix).filter(n => n.endsWith(".lock"))];

describe("M-3770 2.5 wiring part 5: agend update's Phase 2 driver", () => {
  it("an install that can't be proven: not run, no attempt opened, every lock released", () => {
    const s = scratch();
    const r = runTransactionUpdate(input(s), env(s));
    expect(r).toMatchObject({ ran: false, reason: expect.stringMatching(/^the install can't be proven: /) });
    expect(readCurrent(s.home).state).toBe("none");
    expect(lockFiles(s)).toEqual([]);
  });

  it("another live update's home lock: refused before anything else is taken", () => {
    const s = scratch();
    writeFileSync(join(s.home, ".update.lock"), JSON.stringify({ pid: process.pid, processStart: START.processStart, prefix: s.home, targetSpec: "x", agendHome: s.home,
      token: "e".repeat(32), createdAt: new Date().toISOString() }) + "\n");
    const r = runTransactionUpdate(input(s), { ...env(s), lockDeps: { ...env(s).lockDeps, pid: 999999 } });
    expect(r.ran).toBe(false);
    expect(existsSync(join(s.prefix, ".agend-install.lock"))).toBe(false);
    expect(readCurrent(s.home).state).toBe("none");
  });

  it("the words: refused, each way back, committed with a refreshed or a failed definition (a warning naming the command, never a failure)", () => {
    const at = { id: "x" } as never;
    expect(phase2Words({ ran: false, reason: "the install can't be proven: x" }, "2.5.1")).toEqual({ lines: ["  ✗ Not updated: the install can't be proven: x. Nothing was changed."], exitCode: 1, notice: null });
    expect(phase2Words({ ran: true, result: { ok: false, outcome: "rolled-back", reason: "the trial failed", attempt: at } }, "2.5.1").lines)
      .toEqual(["  ✗ Not updated to v2.5.1: the trial failed — the previous version runs again."]);
    expect(phase2Words({ ran: true, result: { ok: false, outcome: "retry", reason: "r", attempt: at } }, "2.5.1").lines[0]).toContain("it resumes on the next fleet start");
    expect(phase2Words({ ran: true, result: { ok: true, attempt: at }, refresh: { kind: "refreshed", reloaded: true, note: "the service definition was refreshed; it applies at the next restart" } }, "2.5.1"))
      .toEqual({ lines: ["  ✓ Updated to v2.5.1.", "  the service definition was refreshed; it applies at the next restart"], exitCode: 0, notice: null });
    const failed = phase2Words({ ran: true, result: { ok: true, attempt: at }, refresh: { kind: "failed", warning: "the service definition couldn't be refreshed (exit 1)", command: "/p/bin/agend install --no-activate" } }, "2.5.1");
    expect(failed.exitCode).toBe(0);
    expect(failed.notice).toBe("the service definition couldn't be refreshed (exit 1). Run `/p/bin/agend install --no-activate` to refresh it.");
    expect(failed.command).toBe("/p/bin/agend install --no-activate");
  });
});

describe("M-3770 2.5 wiring part 5: agend update selects its path first", () => {
  it("cli.ts: selection before today's installer — the journal refuses either updater; with the switch off nothing more is asked; Phase 2 runs the transaction and returns", async () => {
    const { readFileSync } = await import("node:fs");
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const at = cli.indexOf("── M-3770 2.5: the update transaction (Phase 2)"), installer = cli.indexOf("── #2264: the target release installs itself ──");
    expect(at).toBeGreaterThan(cli.indexOf("── Check if npm global needs sudo"));
    expect(installer).toBeGreaterThan(at);
    const block = cli.slice(at, installer);
    expect(block).toMatch(/const switchedOn = process\.env\.AGEND_UPDATE_TX === "1";/);
    expect(block).toMatch(/preflightClass: switchedOn && targetVersion \? /);
    expect(block).toMatch(/targetTx: switchedOn && targetVersion \? phase\.targetUpdateTx\(/);
    expect(block).toMatch(/if \("refuse" in choice\) \{[\s\S]*?process\.exitCode = 1;\s*return;\s*\}/);
    expect(block).toMatch(/if \(choice\.phase === 2 && targetVersion && npmPrefixFound && !needsSudo\) \{[\s\S]*runTransactionUpdate\([\s\S]*?return;\s*\}/);
  });
});

describe("M-3770 2.5 wiring part 5 (Fable (c)): the service driven is the one running the fleet", () => {
  it("both a user and a system unit, the system one running the fleet: the user unit's MainPID isn't fleet.lock's holder — not run, nothing opened, locks released", () => {
    const s = scratch();
    writeFileSync(join(s.home, "fleet.lock"), JSON.stringify({ pid: process.pid, nonce: "a".repeat(32), createdAt: new Date().toISOString(), role: "fleet" }) + "\n");
    const e = env(s);
    const asked: string[] = [];
    e.host = { ...e.host, run: (c, a) => { asked.push(`${c} ${a.join(" ")}`); return a.includes("MainPID") ? { status: 0, stdout: "0\n" } : { status: 1, stdout: "" }; } };
    const unit = join(s.root, "com.agend.fleet.service"); writeFileSync(unit, "[Service]\n");
    const r = runTransactionUpdate({ ...input(s), service: { kind: "systemd", unit: "com.agend.fleet.service", fragmentPath: unit } }, e);
    expect(r).toEqual({ ran: false, reason: `the running fleet (pid ${process.pid}) isn't com.agend.fleet.service's (its MainPID is unreadable)` });
    expect(asked).toEqual(["systemctl --user show -p MainPID --value com.agend.fleet.service"]);
    expect(readCurrent(s.home).state).toBe("none");
    expect(lockFiles(s)).toEqual(["fleet.lock"]);
  });

  it("cli.ts: a transaction that can't run here (nothing opened) falls back to today's updater, saying why", async () => {
    const { readFileSync } = await import("node:fs");
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const block = cli.slice(cli.indexOf("── M-3770 2.5: the update transaction (Phase 2)"), cli.indexOf("── #2264: the target release installs itself ──"));
    expect(block).toMatch(/if \(!r\.ran\) \{\s*console\.log\(`  ℹ The update transaction can't run here \(\$\{r\.reason\}\); today's updater updates it\.`\);\s*\} else \{/);
    expect(block).toMatch(/systemUnit: service\.system, root: \(process\.getuid\?\.\(\) \?\? 0\) === 0,/);
  });
});
