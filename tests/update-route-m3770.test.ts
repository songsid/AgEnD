// M-3770 slice 2.1c part 3 (design update-transaction §6.2, §4.3 rev 5): the service route — systemd's drop-in and
// launchd's /bin/sh wrapper — written over a kept unit preimage and taken off again; the wrapper run for real (it
// honours the pre-start's verdict, reads but never executes handoff.env, and execs in place so MainPID is the fleet);
// the exact unwrap; and the owned re-take of a dead generation's fleet.lock record.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advance, finish, newAttemptId, openAttempt, type AttemptRecord } from "../src/update-journal.js";
import { dropInPath, dropInText, removeRecoveryRoute, unitPreimagePath, unwrapRecoveryRoute, WRAPPER_ARG0, WRAPPER_SCRIPT, writeRecoveryRoute } from "../src/update-recovery/route.js";
import { handoffEnvPath, kitDir } from "../src/update-recovery/pre-start.js";
import { parsePlist } from "../src/service-activation.js";
import { readFleetLockRecord, retakeDeadFleetLock } from "../src/fleet-lock.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p = "route-") => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const ID = newAttemptId(new Date("2026-11-26T09:00:00Z"), "12345678");
const START = { processStart: "Thu Nov 26 09:00:00 2026" };
const NONCE = "a".repeat(32);

const UNIT = "[Unit]\nDescription=AgEnD\n[Service]\nExecStart=/usr/bin/agend fleet start\n";
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agend.fleet</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/agend</string>
        <string>fleet</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
`;

interface Rig { root: string; home: string; fragment: string }
function rig(kind: "systemd" | "launchd", homeName = "home"): { r: Rig; attempt: AttemptRecord } {
  const root = tmp(); const home = join(root, homeName); mkdirSync(home);
  const fragment = join(root, kind === "systemd" ? "agend.service" : "com.agend.fleet.plist");
  writeFileSync(fragment, kind === "systemd" ? UNIT : PLIST, { mode: 0o644 }); chmodSync(fragment, 0o644);
  const res = openAttempt(home, { id: ID, kind: "update", updater: { pid: 4242, start: START },
    from: { name: "@songsid/agend", version: "2.4.0", integrity: null }, to: { name: "@songsid/agend", version: "2.4.1", integrity: null },
    extra: { ownership: { uid: 1000, home, prefix: join(root, "prefix"), packagePath: join(root, "prefix", "lib", "node_modules", "@songsid", "agend"),
      binLinks: { agend: join(root, "prefix", "bin", "agend"), "agend-agent": join(root, "prefix", "bin", "agend-agent") },
      service: { kind, unit: kind === "systemd" ? "agend.service" : "com.agend.fleet", fragmentPath: fragment } },
      expected: { old: { version: "2.4.0", integrity: null, bins: { agend: "/x/a", "agend-agent": "/x/b" }, entry: "/x/cli.js", interpreter: "/usr/bin/node", execStart: null } } } });
  if (!res.ok) throw new Error(res.reason);
  return { r: { root, home, fragment }, attempt: res.attempt };
}

describe("M-3770 §6.2: systemd's drop-in", () => {
  it("is written beside the unit (the unit untouched, its bytes kept as the preimage), idempotently, and taken off", () => {
    const { r, attempt } = rig("systemd");
    expect(writeRecoveryRoute(r.home, attempt, { plistArgs: () => null })).toEqual({ ok: true, path: join(r.root, "agend.service.d", "agend-update-recovery.conf") });
    const service = { kind: "systemd" as const, unit: "agend.service", fragmentPath: r.fragment };
    const kit = kitDir(r.home, ID);
    expect(readFileSync(dropInPath(service), "utf8")).toBe(dropInText(r.home, ID));
    expect(statSync(dropInPath(service)).mode & 0o777).toBe(0o644);
    expect(dropInText(r.home, ID)).toContain(`ExecStartPre=${kit}/node ${kit}/recover.cjs --home ${r.home} --attempt ${ID} --pre-start\nEnvironmentFile=-${handoffEnvPath(r.home, ID)}`);
    expect(readFileSync(r.fragment, "utf8")).toBe(UNIT);
    expect(readFileSync(unitPreimagePath(r.home, ID), "utf8")).toBe(UNIT);
    expect(writeRecoveryRoute(r.home, attempt, { plistArgs: () => null }).ok).toBe(true);                     // a retry
    expect(removeRecoveryRoute(r.home, attempt, { plistArgs: (xml: string) => parsePlist(xml)?.argv ?? null })).toMatchObject({ ok: true });
    expect(existsSync(dropInPath(service))).toBe(false);
    expect(removeRecoveryRoute(r.home, attempt, { plistArgs: (xml: string) => parsePlist(xml)?.argv ?? null })).toMatchObject({ ok: true });                                  // already off
  });

  it("refuses a unit changed since its preimage, and paths a unit file can't carry as one plain word", () => {
    const { r, attempt } = rig("systemd");
    writeRecoveryRoute(r.home, attempt, { plistArgs: () => null });
    writeFileSync(r.fragment, UNIT + "Environment=X=1\n");
    expect(writeRecoveryRoute(r.home, attempt, { plistArgs: () => null })).toMatchObject({ ok: false, reason: expect.stringMatching(/changed since its preimage/) });
    for (const name of ["my home", "home%i", "home$X"]) {
      const { r: r2, attempt: a2 } = rig("systemd", name);
      expect(writeRecoveryRoute(r2.home, a2, { plistArgs: () => null })).toMatchObject({ ok: false, reason: expect.stringMatching(/one plain word/) });
      expect(existsSync(join(r2.root, "agend.service.d", "agend-update-recovery.conf"))).toBe(false);
    }
  });
});

describe("M-3770 §6.2: launchd's wrapper", () => {
  it("wraps the ORIGINAL arguments (never twice on a retry), keeps the preimage, and the removal writes the preimage back", () => {
    const { r, attempt } = rig("launchd");
    const kit = kitDir(r.home, ID);
    const plistArgs = (xml: string) => parsePlist(xml)?.argv ?? null;
    const res = writeRecoveryRoute(r.home, attempt, { plistArgs });
    expect(res).toEqual({ ok: true, path: r.fragment });
    const wrapped = ["/bin/sh", "-c", WRAPPER_SCRIPT, WRAPPER_ARG0, join(kit, "node"), join(kit, "recover.cjs"), r.home, ID, "/usr/local/bin/agend", "fleet", "start"];
    expect(parsePlist(readFileSync(r.fragment, "utf8"))?.argv).toEqual(wrapped);
    expect(readFileSync(unitPreimagePath(r.home, ID), "utf8")).toBe(PLIST);
    expect(writeRecoveryRoute(r.home, attempt, { plistArgs }).ok).toBe(true);                                 // a retry: from the preimage
    expect(parsePlist(readFileSync(r.fragment, "utf8"))?.argv).toEqual(wrapped);
    expect(statSync(r.fragment).mode & 0o777).toBe(0o644);                                            // the plist keeps its mode
    expect(removeRecoveryRoute(r.home, attempt, { plistArgs: (xml: string) => parsePlist(xml)?.argv ?? null })).toMatchObject({ ok: true });
    expect(readFileSync(r.fragment, "utf8")).toBe(PLIST);
    expect(statSync(r.fragment).mode & 0o777).toBe(0o644);
  });

  it("a retry or a removal rewrites only what the route wrote: an edited plist is refused and left as it is (Fable #4517 F3)", () => {
    const { r, attempt } = rig("launchd");
    const plistArgs = (xml: string) => parsePlist(xml)?.argv ?? null;
    expect(writeRecoveryRoute(r.home, attempt, { plistArgs }).ok).toBe(true);
    const wrapped = readFileSync(r.fragment, "utf8");
    const edited = wrapped.replace("/usr/local/bin/agend", "/opt/new/bin/agend");
    writeFileSync(r.fragment, edited);
    expect(writeRecoveryRoute(r.home, attempt, { plistArgs })).toMatchObject({ ok: false, reason: expect.stringMatching(/changed since its preimage/) });
    expect(readFileSync(r.fragment, "utf8")).toBe(edited);
    expect(removeRecoveryRoute(r.home, attempt, { plistArgs })).toMatchObject({ ok: false, reason: expect.stringMatching(/isn't this route's wrapper/) });
    expect(readFileSync(r.fragment, "utf8")).toBe(edited);
    // An edit of the un-wrapped preimage form is refused too; the preimage itself or the exact wrapper are accepted.
    writeFileSync(r.fragment, PLIST.replace("RunAtLoad", "KeepAlive"));
    expect(writeRecoveryRoute(r.home, attempt, { plistArgs }).ok).toBe(false);
    writeFileSync(r.fragment, PLIST);
    expect(writeRecoveryRoute(r.home, attempt, { plistArgs }).ok).toBe(true);
    expect(readFileSync(r.fragment, "utf8")).toBe(wrapped);
    expect(writeRecoveryRoute(r.home, attempt, { plistArgs }).ok).toBe(true);                       // already wrapped: no rewrite
    expect(removeRecoveryRoute(r.home, attempt, { plistArgs }).ok).toBe(true);
    expect(readFileSync(r.fragment, "utf8")).toBe(PLIST);
    expect(removeRecoveryRoute(r.home, attempt, { plistArgs }).ok).toBe(true);                      // the preimage already there
  });

  describe("the wrapper run for real by /bin/sh", () => {
    /** A stand-in kit: "node" is this Node, "recover.cjs" a script exiting with `code` (and writing handoff.env when asked). */
    const kitWith = (home: string, code: number, env: string | null) => {
      const dir = join(tmp("kit-"), "k"); mkdirSync(dir);
      writeFileSync(join(dir, "recover.cjs"), `const fs=require("fs");const h=process.argv[3],id=process.argv[5];
        ${env === null ? "" : `fs.mkdirSync(h+"/.update-journal/attempts/"+id,{recursive:true});fs.writeFileSync(h+"/.update-journal/attempts/"+id+"/handoff.env",${JSON.stringify(env)});`}
        process.exit(${code});`);
      return dir;
    };
    const runWrapper = (home: string, kit: string, original: string[]) =>
      spawnSync("/bin/sh", ["-c", WRAPPER_SCRIPT, WRAPPER_ARG0, process.execPath, join(kit, "recover.cjs"), home, ID, ...original], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });

    it("a refusing pre-start stops the start: the original never runs, the exit code carries through", () => {
      const home = tmp();
      const res = runWrapper(home, kitWith(home, 1, null), ["/bin/sh", "-c", "echo ran"]);
      expect(res.status).toBe(1);
      expect(res.stdout).not.toContain("ran");
    });

    it("a handoff: the nonce reaches the original's environment, and exec keeps the PID (MainPID is the fleet)", () => {
      const home = tmp();
      const res = runWrapper(home, kitWith(home, 0, `AGEND_UPDATE_HANDOFF=${NONCE}\n`), ["/bin/sh", "-c", `echo "nonce=$AGEND_UPDATE_HANDOFF"; echo "pid=$$"; echo "ppid=$PPID"`]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`nonce=${NONCE}`);
      expect(res.stdout).toContain(`pid=${res.pid}`);                                                         // the wrapper's own pid
      // dash execs the last command of `sh -c` by itself, so the PID can't tell an explicit exec from none here; launchd's
      // /bin/sh on macOS needn't. The explicit exec is pinned (the script is matched byte-for-byte anyway).
      expect(WRAPPER_SCRIPT.split("\n").at(-1)).toBe(`exec "$@"`);
    });

    it("handoff.env is read, never executed: a line that isn't exactly the nonce is ignored", () => {
      const home = tmp(), canary = join(home, "pwned");
      for (const line of [`AGEND_UPDATE_HANDOFF=$(touch ${canary})`, `AGEND_UPDATE_HANDOFF=${NONCE}; touch ${canary}`, `touch ${canary}`, `AGEND_UPDATE_HANDOFF=${"A".repeat(32)}`]) {
        const res = runWrapper(home, kitWith(home, 0, line + "\n"), ["/bin/sh", "-c", `echo "nonce=[$AGEND_UPDATE_HANDOFF]"`]);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("nonce=[]");
        expect(existsSync(canary)).toBe(false);
      }
    });

    it("no handoff file (no open attempt): the original runs unchanged", () => {
      const home = tmp();
      const res = runWrapper(home, kitWith(home, 0, null), ["/bin/sh", "-c", `echo "args ok"`]);
      expect(res).toMatchObject({ status: 0, stdout: "args ok\n" });
    });
  });
});

describe("M-3770 §6.2: the wrapper is recognised only EXACTLY", () => {
  const plistArgs = (xml: string) => parsePlist(xml)?.argv ?? null;
  const ORIGINAL = ["/usr/local/bin/agend", "fleet", "start"];
  const wrapperFor = (home: string, id = ID, tail = ORIGINAL) => ["/bin/sh", "-c", WRAPPER_SCRIPT, WRAPPER_ARG0, join(kitDir(home, id), "node"), join(kitDir(home, id), "recover.cjs"), home, id, ...tail];
  /** A launchd attempt with its route written (so its unit.preimage exists), then abandoned. */
  const finished = () => {
    const { r, attempt } = rig("launchd");
    expect(writeRecoveryRoute(r.home, attempt, { plistArgs }).ok).toBe(true);
    return { r, attempt };
  };
  const deps = { verifyKit: () => true, plistArgs };

  it("this home's wrapper, a verified kit, the attempt's OWN record terminal, and the tail exactly its preimage's arguments", () => {
    const { r, attempt } = finished();
    expect(unwrapRecoveryRoute(wrapperFor(r.home), r.home, deps)).toBeNull();                                // still open
    finish(r.home, advance(r.home, advance(r.home, attempt, "barrier"), "abandoning"), { kind: "abandoned" });
    expect(unwrapRecoveryRoute(wrapperFor(r.home), r.home, deps)).toEqual(ORIGINAL);
    expect(unwrapRecoveryRoute(wrapperFor(r.home), r.home, { ...deps, verifyKit: () => false })).toBeNull();
    expect(unwrapRecoveryRoute(wrapperFor("/other/home"), r.home, deps)).toBeNull();
    const w = wrapperFor(r.home);
    for (const [i, v] of [[2, WRAPPER_SCRIPT + " "], [0, "/bin/bash"], [3, "x"], [4, "/tmp/node"], [5, "/tmp/recover.cjs"], [7, "../x"]] as const) {
      const bad = [...w]; bad[i] = v;
      expect(unwrapRecoveryRoute(bad, r.home, deps)).toBeNull();
    }
    writeFileSync(join(r.home, ".update-journal", "current"), "nonsense\n");
    expect(unwrapRecoveryRoute(w, r.home, deps)).toBeNull();                                                  // journal unknown
  });

  it("an arbitrary tail is refused: only the preimage's own ProgramArguments (Prism, #4517)", () => {
    const { r, attempt } = finished();
    finish(r.home, advance(r.home, advance(r.home, attempt, "barrier"), "abandoning"), { kind: "abandoned" });
    for (const tail of [["/tmp/evil"], [...ORIGINAL, "--extra"], ["/usr/local/bin/agend", "fleet"], ["/usr/local/bin/agend", "fleet", "Start"], []]) {
      expect(unwrapRecoveryRoute(wrapperFor(r.home, ID, tail), r.home, deps)).toBeNull();
    }
    rmSync(unitPreimagePath(r.home, ID));
    expect(unwrapRecoveryRoute(wrapperFor(r.home), r.home, deps)).toBeNull();                                // no preimage: unproven
  });

  it("the kit's own attempt must be proven terminal — not inferred from the current journal (Prism, #4517)", () => {
    // An attempt left in manual-recovery whose `current` was then removed: the journal reads none, the record says manual.
    const { r, attempt } = finished();
    finish(r.home, advance(r.home, attempt, "barrier"), { kind: "manual-recovery", reason: "t" });
    rmSync(join(r.home, ".update-journal", "current"));
    expect(unwrapRecoveryRoute(wrapperFor(r.home), r.home, deps)).toBeNull();
    // A kit whose attempt has no record at all.
    const other = newAttemptId(new Date("2026-11-26T10:00:00Z"), "99999999");
    expect(unwrapRecoveryRoute(wrapperFor(r.home, other), r.home, deps)).toBeNull();
    // An open attempt's record (not terminal) with `current` gone.
    const { r: r2 } = finished();
    rmSync(join(r2.home, ".update-journal", "current"));
    expect(unwrapRecoveryRoute(wrapperFor(r2.home), r2.home, deps)).toBeNull();
  });
});

describe("M-3770 §4.3 rev 5: re-taking the fence from a generation that died after its takeover", () => {
  const fleetRecord = (pid: number, nonce: string) => JSON.stringify({ pid, nonce, createdAt: new Date().toISOString(), role: "fleet" }) + "\n";

  it("only that generation's record, only with its holder proven gone; the fence comes back with no handoff, the marker gone", () => {
    const home = tmp();
    writeFileSync(join(home, "fleet.lock"), fleetRecord(7777, NONCE));
    expect(retakeDeadFleetLock(home, { pid: 4242, attemptId: ID, nonce: NONCE }, { isProcessAlive: () => true })).toMatchObject({ ok: false, reason: expect.stringMatching(/still a live process/) });
    expect(retakeDeadFleetLock(home, { pid: 4242, attemptId: ID, nonce: "b".repeat(32) }, { isProcessAlive: () => false })).toMatchObject({ ok: false, reason: expect.stringMatching(/doesn't hold that generation/) });
    const res = retakeDeadFleetLock(home, { pid: 4242, attemptId: ID, nonce: NONCE }, { isProcessAlive: () => false });
    expect(res).toMatchObject({ ok: true });
    expect(readFleetLockRecord(home)).toMatchObject({ pid: 4242, role: "update", attemptId: ID, handoff: null });
    expect(existsSync(join(home, "fleet.lock.reclaim"))).toBe(false);
  });

  it("a reclaim marker present refuses with the lock untouched; a record changed during the reclaim refuses and removes its marker", () => {
    const home = tmp();
    writeFileSync(join(home, "fleet.lock"), fleetRecord(7777, NONCE));
    writeFileSync(join(home, "fleet.lock.reclaim"), "someone\n");
    expect(retakeDeadFleetLock(home, { pid: 4242, attemptId: ID, nonce: NONCE }, { isProcessAlive: () => false })).toMatchObject({ ok: false, reason: expect.stringMatching(/reclaim marker/) });
    expect(readFleetLockRecord(home)).toMatchObject({ pid: 7777, role: "fleet" });
    rmSync(join(home, "fleet.lock.reclaim"));
    // The holder check is the last read before the marker; a start that replaces the record right then is noticed.
    const changed = retakeDeadFleetLock(home, { pid: 4242, attemptId: ID, nonce: NONCE }, { isProcessAlive: () => { writeFileSync(join(home, "fleet.lock"), fleetRecord(8888, "c".repeat(32))); return false; } });
    expect(changed).toMatchObject({ ok: false, reason: expect.stringMatching(/changed during the reclaim/) });
    expect(readFleetLockRecord(home)).toMatchObject({ pid: 8888 });
    expect(existsSync(join(home, "fleet.lock.reclaim"))).toBe(false);
  });
});
