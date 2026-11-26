// M-3770 slice 2.3 (design update-transaction §6.3): the transaction's own package preimage (copied, hashed), the package
// restore's four substeps with a crash between each effect and its journal line, and the unit restore (route kept for
// the runner, or removed), on real temp prefixes and units.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attemptPreimageDir, readAttemptPreimage, restorePackage, restoreUnit, takeAttemptPreimage, type Substeps } from "../src/update-package-restore.js";
import { dropInPath, unitPreimagePath, wrapPlist, writeRecoveryRoute } from "../src/update-recovery/route.js";
import { parsePlist } from "../src/service-activation.js";
import { newAttemptId, openAttempt } from "../src/update-journal.js";
import type { Ownership } from "../src/install-ownership.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p = "pkg-") => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const ID = newAttemptId(new Date("2026-11-26T12:00:00Z"), "a1b2c3d4");

function installPackage(o: Ownership, version: string) {
  rmSync(o.packagePath, { recursive: true, force: true });
  mkdirSync(join(o.packagePath, "dist", "deep"), { recursive: true }); mkdirSync(join(o.packagePath, "launcher"));
  writeFileSync(join(o.packagePath, "package.json"), JSON.stringify({ name: "@songsid/agend", version }));
  writeFileSync(join(o.packagePath, "dist", "cli.js"), `// ${version}`);
  writeFileSync(join(o.packagePath, "dist", "deep", "x.js"), `x ${version}`);
  writeFileSync(join(o.packagePath, "launcher", "agend"), `#!/bin/sh\n# ${version}`);
  writeFileSync(join(o.packagePath, "launcher", "agend-agent"), "#!/bin/sh");
  symlinkSync("cli.js", join(o.packagePath, "dist", "alias.js"));
  for (const name of ["agend", "agend-agent"] as const) { rmSync(o.binLinks[name], { force: true }); symlinkSync(join(o.packagePath, "launcher", name), o.binLinks[name]); }
}

function rig(): Ownership {
  const root = tmp(), prefix = join(root, "prefix");
  mkdirSync(join(prefix, "bin"), { recursive: true }); mkdirSync(join(prefix, "lib", "node_modules", "@songsid"), { recursive: true });
  const o: Ownership = { uid: 1000, home: join(root, "home"), prefix, packagePath: join(prefix, "lib", "node_modules", "@songsid", "agend"),
    binLinks: { agend: join(prefix, "bin", "agend"), "agend-agent": join(prefix, "bin", "agend-agent") }, service: null };
  installPackage(o, "2.4.0");
  return o;
}

/** The journal's substeps, in memory; `crashAfter` throws right after the named effect landed, before its line. */
const journal = (crashAfter?: string): Substeps & { names: string[] } => {
  const names: string[] = [];
  return { names, done: n => names.includes(n), record: n => { if (n === crashAfter) { crashAfter = undefined; throw new Error(`crash before ${n}'s line`); } names.push(n); } };
};
const pkgState = (o: Ownership) => ({ version: JSON.parse(readFileSync(join(o.packagePath, "package.json"), "utf8")).version, deep: readFileSync(join(o.packagePath, "dist", "deep", "x.js"), "utf8"),
  alias: readlinkSync(join(o.packagePath, "dist", "alias.js")), agend: readlinkSync(o.binLinks.agend), agent: readlinkSync(o.binLinks["agend-agent"]) });

describe("M-3770 §6.3: the transaction's package preimage", () => {
  it("is a hashed copy with the bin links recorded; it verifies, and a changed tree or manifest doesn't", () => {
    const o = rig();
    const pre = takeAttemptPreimage(o, ID);
    if (!pre.ok) throw new Error(pre.reason);
    expect(pre.dir).toBe(attemptPreimageDir(o.prefix, ID));
    expect(pre.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    const read = readAttemptPreimage(pre.dir, pre.manifestSha256);
    expect(read).toMatchObject({ ok: true, manifest: { bins: { agend: { link: o.binLinks.agend, target: join(o.packagePath, "launcher", "agend") } } } });
    expect(takeAttemptPreimage(o, ID)).toMatchObject({ ok: false, reason: expect.stringMatching(/never reused/) });
    writeFileSync(join(pre.dir, "agend", "dist", "cli.js"), "tampered");
    expect(readAttemptPreimage(pre.dir, pre.manifestSha256)).toMatchObject({ ok: false, reason: expect.stringMatching(/tree doesn't match/) });
    expect(readAttemptPreimage(pre.dir, "0".repeat(64))).toMatchObject({ ok: false, reason: expect.stringMatching(/isn't the one/) });
  });
});

describe("M-3770 §6.3: the package restore", () => {
  it("puts the old package and bin links back; the new package lands in replaced-package", () => {
    const o = rig();
    const pre = takeAttemptPreimage(o, ID); if (!pre.ok) throw new Error(pre.reason);
    const want = pkgState(o);
    installPackage(o, "2.4.1");
    const j = journal();
    expect(restorePackage(o, ID, pre.manifestSha256, j)).toEqual({ ok: true });
    expect(pkgState(o)).toEqual(want);
    expect(j.names).toEqual(["pkg-aside", "pkg-staged", "pkg-placed", "bins"]);
    expect(JSON.parse(readFileSync(join(pre.dir, "replaced-package", "package.json"), "utf8")).version).toBe("2.4.1");
    expect(readAttemptPreimage(pre.dir, pre.manifestSha256).ok).toBe(true);                         // the preimage is never consumed
    expect(restorePackage(o, ID, pre.manifestSha256, j)).toEqual({ ok: true });                    // done: a no-op
  });

  it("a crash after each substep's effect, before its line: the retry recognises it and ends in the same state", () => {
    for (const step of ["pkg-aside", "pkg-staged", "pkg-placed", "bins"]) {
      const o = rig();
      const pre = takeAttemptPreimage(o, ID); if (!pre.ok) throw new Error(pre.reason);
      const want = pkgState(o);
      installPackage(o, "2.4.1");
      const j = journal(step);
      expect(() => restorePackage(o, ID, pre.manifestSha256, j), step).toThrow(/crash before/);
      expect(restorePackage(o, ID, pre.manifestSha256, j), step).toEqual({ ok: true });
      expect(pkgState(o), step).toEqual(want);
      expect(j.names, step).toEqual(["pkg-aside", "pkg-staged", "pkg-placed", "bins"]);
    }
  });

  it("a half-copied staging tree (a crash mid-copy) is removed and copied again", () => {
    const o = rig();
    const pre = takeAttemptPreimage(o, ID); if (!pre.ok) throw new Error(pre.reason);
    const want = pkgState(o);
    installPackage(o, "2.4.1");
    const j = journal();
    j.record("pkg-aside"); rmSync(o.packagePath, { recursive: true }); mkdirSync(join(pre.dir, "replaced-package"));   // aside landed
    const staged = join(o.prefix, "lib", "node_modules", "@songsid", `.agend-restore-${ID}`);
    mkdirSync(join(staged, "dist"), { recursive: true }); writeFileSync(join(staged, "dist", "cli.js"), "half");
    writeFileSync(join(staged, "stray.tmp"), "left by the crash");
    expect(restorePackage(o, ID, pre.manifestSha256, j)).toEqual({ ok: true });
    expect(pkgState(o)).toEqual(want);
    expect(existsSync(join(o.packagePath, "stray.tmp"))).toBe(false);                               // copied afresh, not merged
  });

  it("a bin link the old install didn't have stays absent (and absent is no error)", () => {
    const o = rig();
    rmSync(o.binLinks["agend-agent"]);                                                               // the old install had no agend-agent link
    const pre = takeAttemptPreimage(o, ID); if (!pre.ok) throw new Error(pre.reason);
    installPackage(o, "2.4.1"); rmSync(o.binLinks["agend-agent"]);                                    // nor does the new one
    expect(restorePackage(o, ID, pre.manifestSha256, journal())).toEqual({ ok: true });
    expect(existsSync(o.binLinks["agend-agent"])).toBe(false);
    const p = rig(); rmSync(p.binLinks["agend-agent"]);
    const pre2 = takeAttemptPreimage(p, ID); if (!pre2.ok) throw new Error(pre2.reason);
    installPackage(p, "2.4.1");                                                                       // the new install added one: removed
    expect(restorePackage(p, ID, pre2.manifestSha256, journal())).toEqual({ ok: true });
    expect(existsSync(p.binLinks["agend-agent"]) || lstatSync(p.binLinks["agend-agent"], { throwIfNoEntry: false }) !== undefined).toBe(false);
  });

  it("states a retry can't recognise are manual: both the package and replaced-package present; something else where the package goes; a tampered preimage", () => {
    const o = rig();
    const pre = takeAttemptPreimage(o, ID); if (!pre.ok) throw new Error(pre.reason);
    installPackage(o, "2.4.1");
    mkdirSync(join(pre.dir, "replaced-package"));
    expect(restorePackage(o, ID, pre.manifestSha256, journal())).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/both exist/) });
    rmSync(join(pre.dir, "replaced-package"), { recursive: true });
    const j = journal("pkg-staged");
    expect(() => restorePackage(o, ID, pre.manifestSha256, j)).toThrow();
    mkdirSync(o.packagePath, { recursive: true }); writeFileSync(join(o.packagePath, "intruder"), "x");   // someone put a package there
    expect(restorePackage(o, ID, pre.manifestSha256, j)).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/something else is there/) });
    writeFileSync(join(pre.dir, "agend", "package.json"), "{}");
    expect(restorePackage(o, ID, pre.manifestSha256, journal())).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/tree doesn't match/) });
  });
});

describe("M-3770 §6.3: the unit restore", () => {
  const UNIT = "[Service]\nExecStart=/usr/bin/agend fleet start\n";
  const PLIST = `<plist version="1.0">\n<dict>\n    <key>ProgramArguments</key>\n    <array>\n        <string>/usr/local/bin/agend</string>\n        <string>fleet</string>\n        <string>start</string>\n    </array>\n</dict>\n</plist>\n`;
  const plistArgs = (xml: string) => parsePlist(xml)?.argv ?? null;
  const unitRig = (kind: "systemd" | "launchd") => {
    const root = tmp(), home = join(root, "home"); mkdirSync(home);
    const fragment = join(root, kind === "systemd" ? "agend.service" : "com.agend.fleet.plist");
    writeFileSync(fragment, kind === "systemd" ? UNIT : PLIST);
    const res = openAttempt(home, { id: ID, kind: "update", updater: { pid: 4242, start: { processStart: "x" } },
      from: { name: "@songsid/agend", version: "2.4.0", integrity: null }, to: { name: "@songsid/agend", version: "2.4.1", integrity: null },
      extra: { ownership: { uid: 1000, home, prefix: join(root, "p"), packagePath: join(root, "p", "lib", "node_modules", "@songsid", "agend"),
        binLinks: { agend: join(root, "p", "bin", "agend"), "agend-agent": join(root, "p", "bin", "agend-agent") },
        service: { kind, unit: kind === "systemd" ? "agend.service" : "com.agend.fleet", fragmentPath: fragment } },
        expected: { old: { version: "2.4.0", integrity: null, bins: { agend: "/x/a", "agend-agent": "/x/b" }, entry: "/x/c", interpreter: "/x/n", execStart: null } } } });
    if (!res.ok) throw new Error(res.reason);
    expect(writeRecoveryRoute(home, res.attempt, { plistArgs }).ok).toBe(true);                        // keeps unit.preimage
    return { home, fragment, attempt: res.attempt };
  };

  it("systemd: the preimage's bytes back; the drop-in removed unless the runner keeps its route; reloaded", () => {
    const r = unitRig("systemd");
    writeFileSync(r.fragment, UNIT + "Environment=NEW=1\n");                                          // the new version's unit
    let reloads = 0;
    expect(restoreUnit(r.home, r.attempt, { keepRoute: false, plistArgs, reload: () => { reloads++; return true; } }, journal())).toEqual({ ok: true });
    expect(readFileSync(r.fragment, "utf8")).toBe(UNIT);
    expect(existsSync(dropInPath({ kind: "systemd", unit: "agend.service", fragmentPath: r.fragment }))).toBe(false);
    expect(reloads).toBe(1);
    const k = unitRig("systemd");
    writeFileSync(k.fragment, "changed");
    expect(restoreUnit(k.home, k.attempt, { keepRoute: true, plistArgs, reload: () => true }, journal())).toEqual({ ok: true });
    expect(readFileSync(k.fragment, "utf8")).toBe(UNIT);
    expect(existsSync(dropInPath({ kind: "systemd", unit: "agend.service", fragmentPath: k.fragment }))).toBe(true);   // the route stays
  });

  it("launchd with the route kept: the wrapper around the ORIGINAL arguments; without it: the preimage itself", () => {
    const r = unitRig("launchd");
    writeFileSync(r.fragment, PLIST.replace("/usr/local/bin/agend", "/opt/new/agend"));
    expect(restoreUnit(r.home, r.attempt, { keepRoute: true, plistArgs, reload: () => true }, journal())).toEqual({ ok: true });
    expect(readFileSync(r.fragment, "utf8")).toBe(wrapPlist(PLIST, r.home, ID, ["/usr/local/bin/agend", "fleet", "start"]));
    const s = unitRig("launchd");
    expect(restoreUnit(s.home, s.attempt, { keepRoute: false, plistArgs, reload: () => true }, journal())).toEqual({ ok: true });
    expect(readFileSync(s.fragment, "utf8")).toBe(PLIST);
  });

  it("a crash after the write, before its line: the retry sees the bytes and goes on; a failed reload is retryable", () => {
    const r = unitRig("systemd");
    writeFileSync(r.fragment, "new");
    const j = journal("unit-written");
    expect(() => restoreUnit(r.home, r.attempt, { keepRoute: false, plistArgs, reload: () => true }, j)).toThrow(/crash/);
    expect(readFileSync(r.fragment, "utf8")).toBe(UNIT);
    expect(restoreUnit(r.home, r.attempt, { keepRoute: false, plistArgs, reload: () => false }, j)).toMatchObject({ ok: false, manual: false });
    expect(restoreUnit(r.home, r.attempt, { keepRoute: false, plistArgs, reload: () => true }, j)).toEqual({ ok: true });
    expect(j.names).toEqual(["unit-written", "unit-route-removed", "unit-reloaded"]);
    expect(lstatSync(r.fragment).isFile()).toBe(true);
    rmSync(unitPreimagePath(r.home, ID));
    expect(restoreUnit(r.home, r.attempt, { keepRoute: false, plistArgs, reload: () => true }, journal())).toMatchObject({ ok: false, manual: true });
  });
});
