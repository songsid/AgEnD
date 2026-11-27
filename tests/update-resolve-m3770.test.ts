// M-3770 slice 2.5, wiring part 6 (design update-wiring-m3770.md §15; Fable's conditions): `agend update --resolve`
// (report; --clear confirmed by value, the route off too, what wasn't checked said) and `--recover` (the owner's uid
// only; the kit's runner beside the service; a committing attempt's route off with the caller's rights, journaled).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advance, attemptDir, finish, newAttemptId, openAttempt, readAttemptRecord, readCurrent, type AttemptRecord, type Stage } from "../src/update-journal.js";
import { recoverAttempt, resolveClear, resolveReport, type ResolveDeps } from "../src/update-resolve.js";
import { dropInPath } from "../src/update-recovery/route.js";
import { kitDir } from "../src/update-recovery/pre-start.js";
import { createHash } from "node:crypto";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ID = newAttemptId(new Date("2026-11-27T19:00:00Z"), "cdcdcdcd");
const UPDATER = 4343, START = { processStart: "x" };

function world(stage: Stage, o: { service?: boolean; uid?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "resolve-")); dirs.push(root);
  const home = join(root, "home"); mkdirSync(home);
  const fragment = join(root, "com.agend.fleet.service"); writeFileSync(fragment, "[Service]\n");
  const own = { uid: o.uid ?? 1000, home, prefix: join(root, "p"), packagePath: join(root, "p", "pkg"),
    binLinks: { agend: join(root, "p", "bin", "agend"), "agend-agent": join(root, "p", "bin", "agend-agent") },
    service: o.service === false ? null : { kind: "systemd", unit: "com.agend.fleet.service", fragmentPath: fragment } };
  const tuple = { version: "2.5.0", integrity: null, bins: { agend: null, "agend-agent": null }, entry: "/e", interpreter: "/n", execStart: null };
  const r = openAttempt(home, { id: ID, kind: "update", updater: { pid: UPDATER, start: START }, from: { name: "@songsid/agend", version: "2.5.0", integrity: null },
    to: { name: "@songsid/agend", version: "2.5.1", integrity: null }, extra: { ownership: own, expected: { old: tuple }, fleets: [] } });
  if (!r.ok) throw new Error(r.reason);
  let a: AttemptRecord = r.attempt;
  const path: Stage[] = ["barrier", "stopping", "snapshotted", "installing", "trial", "proving", "committing"];
  if (stage === "manual-recovery") a = finish(home, a, { kind: "manual-recovery", reason: "the snapshot couldn't be restored" });
  else for (const s of path.slice(0, path.indexOf(stage) + 1)) a = advance(home, a, s);
  const route = own.service ? dropInPath(own.service as never) : null;
  if (route) { mkdirSync(join(route, ".."), { recursive: true }); writeFileSync(route, "[Service]\nExecStartPre=/kit/recover.cjs\n"); }
  return { root, home, attempt: a, route };
}
function deps(o: { updater?: "live" | "gone" | "unknown"; uid?: number; reload?: boolean; bus?: boolean } = {}): ResolveDeps & { reloads: string[] } {
  const reloads: string[] = [];
  const state = o.updater ?? "gone";
  const liveness = { exists: (pid: number) => pid !== UPDATER || state !== "gone", processStart: (pid: number) => (pid === UPDATER ? (state === "live" ? "x" : null) : pid === process.pid ? "self" : null),
    startTicks: () => null, bootId: () => null };
  return { liveness, uid: o.uid ?? 1000, plistArgs: () => null, reloads,
    lockDeps: { ...liveness, pid: process.pid, newToken: () => "f".repeat(32), now: () => new Date(), log: () => {} },
    reload: s => { reloads.push(s.unit); return o.reload !== false; },
    userBus: () => (o.bus === false ? { ok: false, reason: "Failed to connect to bus: No medium found" } : { ok: true, env: { XDG_RUNTIME_DIR: "/run/user/1000", PATH: "/usr/bin:/bin" } }) };
}

describe("M-3770 2.5 wiring part 6: agend update --resolve", () => {
  it("reports each state with its one next step; a manual attempt names its id, an unknown journal its exact path", () => {
    const m = world("manual-recovery");
    expect(resolveReport(m.home, deps()).lines).toEqual([`  update attempt ${ID}: 2.5.0 → 2.5.1, manual-recovery — it needs a person.`, "  Why: the snapshot couldn't be restored",
      `  Its record: ${attemptDir(m.home, ID)}`, `  Put the install and the fleet right (the record has what it did), then run: agend update --resolve --clear ${ID}`]);
    const s = world("snapshotted");
    expect(resolveReport(s.home, deps()).lines.at(-1)).toBe("  Its update stopped. Run: agend update --recover");
    expect(resolveReport(s.home, deps({ updater: "live" })).lines.at(-1)).toBe("  Its update is still running: wait for it.");
    const u = world("snapshotted");
    writeFileSync(join(u.home, ".update-journal", "current"), "not an id\n");
    expect(resolveReport(u.home, deps()).lines.at(-1)).toBe(`  Look at it; once the install and the fleet are as they should be, run: agend update --resolve --clear ${join(u.home, ".update-journal", "current")}`);
  });

  it("--clear needs the attempt's id by value: anything else clears nothing", () => {
    const m = world("manual-recovery");
    expect(resolveClear(m.home, "yes", deps())).toEqual({ lines: [`  ✗ Not cleared: confirm the attempt --resolve named, by its id: agend update --resolve --clear ${ID}`], exitCode: 1 });
    expect(readCurrent(m.home).state).toBe("manual");
  });

  it("--clear <id>: resolved and recorded (the stage stays), current renamed into the attempt, the route off and reloaded; what wasn't checked is said", () => {
    const m = world("manual-recovery");
    const d = deps();
    const r = resolveClear(m.home, ID, d);
    expect(r.exitCode).toBe(0);
    expect(r.lines).toEqual([`  ✓ ${ID} is resolved; updates and fleet starts are admitted again.`, "  ✓ The recovery route on com.agend.fleet.service is off.",
      `  Nothing about the home or the installed package was checked; the attempt's record and snapshot are in ${attemptDir(m.home, ID)}.`]);
    expect(readCurrent(m.home).state).toBe("none");
    expect(existsSync(join(attemptDir(m.home, ID), "current.resolved"))).toBe(true);
    const rec = readAttemptRecord(m.home, ID)!;
    expect(rec.stage).toBe("manual-recovery");
    expect(rec.history.at(-1)?.note).toMatch(new RegExp(`^resolved by a person \\(uid 1000, confirmed ${ID}\\) at `));
    expect(existsSync(m.route!)).toBe(false);
    expect(d.reloads).toEqual(["com.agend.fleet.service"]);
  });

  it("--clear without the rights to reload says the command and what is left", () => {
    const m = world("manual-recovery");
    const r = resolveClear(m.home, ID, deps({ reload: false }));
    expect(r.lines[1]).toBe(`  ⚠ The recovery route on com.agend.fleet.service is off (${m.route}), but the service manager couldn't reload: run \`systemctl --user daemon-reload\`.`);
  });

  it("--clear refuses while the owner is live or unknown, and never clears an open attempt", () => {
    const m = world("manual-recovery");
    expect(resolveClear(m.home, ID, deps({ updater: "live" })).lines[0]).toBe("  ✗ Not cleared: the attempt's updater or runner still runs.");
    expect(resolveClear(m.home, ID, deps({ updater: "unknown" })).lines[0]).toBe("  ✗ Not cleared: the attempt's updater or runner can't be told gone.");
    const o = world("snapshotted");
    expect(resolveClear(o.home, ID, deps()).exitCode).toBe(1);
    expect(readCurrent(o.home).state).toBe("open");
  });

  it("an unknown journal: cleared only with the exact pointer path, set aside unparsed", () => {
    const u = world("snapshotted");
    const pointer = join(u.home, ".update-journal", "current");
    writeFileSync(pointer, "garbage\n");
    expect(resolveClear(u.home, ID, deps()).exitCode).toBe(1);
    const r = resolveClear(u.home, pointer, deps());
    expect(r.exitCode).toBe(0);
    expect(readCurrent(u.home).state).toBe("none");
    const aside = r.lines[0]!.match(/moved aside to (\S+);/)![1]!;
    expect(readFileSync(aside, "utf8")).toBe("garbage\n");
  });
});

describe("M-3770 2.5 wiring part 6: agend update --recover", () => {
  it("only the attempt's own uid, and only once its owner is proven gone", () => {
    const s = world("snapshotted");
    expect(recoverAttempt(s.home, deps({ uid: 0 }))).toMatchObject({ kind: "said", said: { lines: ["  ✗ Not recovered: the attempt belongs to uid 1000; run it as that user, not uid 0."] } });
    expect(recoverAttempt(s.home, deps({ updater: "live" }))).toMatchObject({ kind: "said", said: { exitCode: 1 } });
  });

  it("a kit stage runs the kit's runner beside the service (systemd-run --wait --pipe), the kit verified first; a detached attempt says what to do", () => {
    const s = world("snapshotted");
    expect(recoverAttempt(s.home, deps())).toMatchObject({ kind: "said", said: { lines: [expect.stringMatching(/^  ✗ Not recovered: the attempt's recovery kit can't be used/)] } });
    // A kit as buildRecoveryKit leaves it: its two files and the manifest that hashes them.
    const kit = kitDir(s.home, ID);
    mkdirSync(kit, { recursive: true });
    writeFileSync(join(kit, "node"), "node"); writeFileSync(join(kit, "recover.cjs"), "recover");
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    writeFileSync(join(kit, "kit.json"), JSON.stringify({ schema: 1, attemptId: ID, home: s.home, node: { source: "/n", sha256: sha("node") }, recover: { sha256: sha("recover") } }));
    expect(recoverAttempt(s.home, deps())).toEqual({ kind: "run", command: "systemd-run",
      args: ["--user", `--unit=agend-update-recovery-${ID}`, "--wait", "--pipe", "--collect", "--property=KillMode=process", join(kit, "node"), join(kit, "recover.cjs"), "--home", s.home, "--attempt", ID, "--run"],
      env: { XDG_RUNTIME_DIR: "/run/user/1000", PATH: "/usr/bin:/bin" } });
    // This user's bus unreachable (sudo -u, an ssh session without it): refused with the reason and what to run instead.
    const nobus = recoverAttempt(s.home, deps({ bus: false }));
    expect(nobus).toMatchObject({ kind: "said", said: { exitCode: 1, lines: ["  ✗ Not recovered from here: this user's systemd bus can't be reached (Failed to connect to bus: No medium found).",
      "  Run it from a login session of uid 1000 (not sudo -u): agend update --recover", expect.stringMatching(/^  Or the runner itself, in that session: /)] } });
    const det = world("snapshotted", { service: false });
    const dk = kitDir(det.home, ID); mkdirSync(dk, { recursive: true });
    writeFileSync(join(dk, "node"), "node"); writeFileSync(join(dk, "recover.cjs"), "recover");
    writeFileSync(join(dk, "kit.json"), JSON.stringify({ schema: 1, attemptId: ID, home: det.home, node: { source: "/n", sha256: sha("node") }, recover: { sha256: sha("recover") } }));
    expect(recoverAttempt(det.home, deps())).toMatchObject({ kind: "said", said: { exitCode: 1, lines: [expect.stringMatching(/records no service to recover beside/), expect.any(String)] } });
  });

  it("committing before the route is off: the route off with the caller's rights and journaled; then the fleet finishes it", () => {
    const c = world("committing");
    const d = deps();
    const r = recoverAttempt(c.home, d);
    expect(r).toEqual({ kind: "said", said: { lines: ["  ✓ The recovery route on com.agend.fleet.service is off.", "  The new fleet finishes the update within a minute (or when it next starts)."], exitCode: 0 } });
    expect(existsSync(c.route!)).toBe(false);
    const now = readCurrent(c.home);
    expect(now.state === "open" && now.attempt.history.at(-1)?.substep).toBe("route-removed");
    expect(recoverAttempt(c.home, d)).toMatchObject({ kind: "said", said: { exitCode: 0 } });           // nothing more to do
  });
});

describe("M-3770 2.5 wiring part 6 (Fable): no lock token is ever printed", () => {
  it("--resolve, --clear and --recover say nothing that holds a 32-hex token (the output goes into chats and bug reports)", () => {
    const lines: string[] = [];
    for (const stage of ["manual-recovery", "snapshotted", "committing"] as const) {
      const w = world(stage);
      // A live service-lock and home-lock record with tokens, as an updater leaves them.
      for (const f of [".service.lock", ".update.lock"]) writeFileSync(join(w.home, f), JSON.stringify({ pid: 4343, processStart: "x", prefix: w.home, targetSpec: `attempt:${ID}`, agendHome: w.home, token: "9".repeat(32), createdAt: new Date().toISOString() }) + "\n");
      lines.push(...resolveReport(w.home, deps()).lines, ...resolveClear(w.home, ID, deps()).lines);
      const r = recoverAttempt(w.home, deps());
      if (r.kind === "said") lines.push(...r.said.lines);
    }
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.filter(l => /[0-9a-f]{32}/i.test(l))).toEqual([]);
  });
});

