/**
 * #2264: the user's failed update, reproduced with REAL npm in a scratch prefix, and the one repair: the target release's
 * own installer, run the way `agend update` and install.sh run it (`npm exec --package <release> -- agend-install`).
 *
 * The user's host after `/update` (WSL, root, nvm prefix): npm had moved the installed AgEnD to its retire sibling
 * `@songsid/.agend-<hash>` and been killed before finishing — `agend: command not found`; `npm install -g` then failed
 * ENOTEMPTY on that sibling; after removing it by hand, an install lock that could not be read refused every install;
 * after removing that too, `agend start` could not reach the user's systemd. Here every one of those is in place at once
 * and a single run of the installer must end with a working `agend`, no manual step.
 *
 * Fake releases (tarballs with no dependencies, so npm works offline) stand in for @songsid/agend: their `agend` prints
 * the version and records `install`/`restart` calls; the newer one carries the REAL launcher/agend-install.cjs.
 * npm's retire name is deterministic (`.<name>-` + 8 alphanumerics of sha1(<path>) in base64 — the user's
 * `.agend-RmEK4vIL`), so the sibling left here is exactly the one npm itself collides with.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureUserSystemd, type UserSystemdDeps } from "../src/user-systemd.js";

const REPO = join(import.meta.dirname, "..");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function release(dir: string, version: string, opts: { brokenVersion?: string } = {}): string {
  const pkg = join(dir, `src-${version}`);
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(pkg, "launcher"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@songsid/agend", version, bin: { agend: "bin/agend", "agend-install": "launcher/agend-install.cjs" } }));
  // The fake agend: its version, and a log of the service calls the installer makes through it.
  writeFileSync(join(pkg, "bin", "agend"), `#!/bin/sh
[ "$1" = "--version" ] && { echo ${opts.brokenVersion ?? version}; exit 0; }
echo "$*" >> "\${AGEND_HOME}/agend-calls.log"
exit 0
`);
  chmodSync(join(pkg, "bin", "agend"), 0o755);
  cpSync(join(REPO, "launcher", "agend-install.cjs"), join(pkg, "launcher", "agend-install.cjs"));
  chmodSync(join(pkg, "launcher", "agend-install.cjs"), 0o755);
  const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: pkg, encoding: "utf8", env: npmEnv(dir) });
  if (packed.status !== 0) throw new Error(`npm pack: ${packed.stderr}`);
  return join(dir, packed.stdout.trim().split("\n").pop()!);
}

function npmEnv(root: string, home?: string): NodeJS.ProcessEnv {
  return {
    ...process.env, npm_config_prefix: join(root, "prefix"), npm_config_cache: join(root, "cache"), npm_config_audit: "false", npm_config_fund: "false",
    npm_config_update_notifier: "false", npm_config_offline: "true", npm_config_loglevel: "error",
    ...(home ? { AGEND_HOME: home } : {}),
  };
}

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "agend-2264-")); roots.push(root);
  const home = join(root, "agend-home"); mkdirSync(home, { recursive: true });
  mkdirSync(join(root, "prefix"), { recursive: true });
  const npm = (args: string[], env: NodeJS.ProcessEnv = npmEnv(root, home)) => spawnSync("npm", args, { encoding: "utf8", env, timeout: 120_000 });
  const pkgDir = join(root, "prefix", "lib", "node_modules", "@songsid", "agend");
  const bin = join(root, "prefix", "bin", "agend");
  const version = () => { const r = spawnSync(bin, ["--version"], { encoding: "utf8", env: { ...process.env, AGEND_HOME: home } }); return r.status === 0 ? r.stdout.trim() : null; };
  return { root, home, npm, pkgDir, bin, version };
}

/** npm's retire name for a path (@npmcli/arborist retire-path.js: `.${basename}-` + sha1(path) base64, alphanumerics, 8). */
const retireName = (path: string) => `.agend-${createHash("sha1").update(path).digest("base64").replace(/[^a-zA-Z0-9]+/g, "").slice(0, 8)}`;

/** The host the user was left with: everything an interrupted `/update` leaves, at once. */
function interruptedUpdate(s: ReturnType<typeof scratch>, partialVersion: string) {
  // npm moved the installed AgEnD aside, started writing the new one, and was killed: a partial new package (no bin
  // yet) in place, the old one in the retire sibling, `bin/agend` leading nowhere.
  const sibling = join(dirname(s.pkgDir), retireName(s.pkgDir));
  renameSync(s.pkgDir, sibling);
  renameSync(s.bin, join(dirname(s.bin), retireName(s.bin)));   // npm retires the bin link the same way
  mkdirSync(s.pkgDir);
  writeFileSync(join(s.pkgDir, "package.json"), JSON.stringify({ name: "@songsid/agend", version: partialVersion }));
  // The install lock, cut short (written, never flushed): "cannot be read as a lock".
  writeFileSync(join(s.root, "prefix", ".agend-install.lock"), '{"pid":');
  // The chat's progress, stuck at "downloading".
  writeFileSync(join(s.home, "update-in-progress.json"), JSON.stringify({ startedAt: Date.now() - 60_000, pid: 999999, progress: { operation: "update", stage: "downloading", target: { adapterId: "telegram", chatId: "1", messageId: "2" } } }));
  writeFileSync(join(s.home, "fleet.yaml"), "instances: {}\n");
  return sibling;
}

describe("#2264 the user's interrupted update, with real npm", { timeout: 240_000 }, () => {
  it("as left: `agend` is gone, and a plain `npm install -g` fails ENOTEMPTY on npm's own sibling (the user's step 1)", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0"), v2 = release(s.root, "2.0.0");
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    expect(s.version()).toBe("1.0.0");
    interruptedUpdate(s, "2.0.0");
    expect(s.version(), "`agend` no longer runs").toBeNull();
    const plain = s.npm(["install", "-g", v2]);
    expect(plain.status).not.toBe(0);
    expect(plain.stderr).toMatch(/ENOTEMPTY/);
  });

  it("one run of the target's installer (npm exec, as `agend update` and install.sh run it) ends with a working agend — no manual step", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0"), v2 = release(s.root, "2.0.0");
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    const sibling = interruptedUpdate(s, "2.0.0");
    const run = s.npm(["exec", "--yes", "--package", v2, "--", "agend-install", "--upgrade", "--spec", v2]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(s.version()).toBe("2.0.0");
    expect(readlinkSync(s.bin)).toContain("@songsid/agend/bin/agend");
    expect(existsSync(sibling), "npm's sibling is gone").toBe(false);
    expect(readdirSync(dirname(s.pkgDir)).filter(n => n.startsWith(".agend-"))).toEqual([]);
    expect(readdirSync(dirname(s.bin)).filter(n => n.startsWith(".agend")), "and npm's retired bin link").toEqual([]);
    expect(existsSync(join(s.root, "prefix", ".agend-install.lock")), "the unreadable lock is gone, and so is the installer's own").toBe(false);
    expect(run.stdout).toMatch(/removed an install lock that could not be read/);
    // The service is the new release's: `agend install` (unit + linger), then the restart onto it.
    expect(readFileSync(join(s.home, "agend-calls.log"), "utf8").trim().split("\n")).toEqual(["install", "restart --yes"]);
    // The chat's progress moved on from "downloading": installed, v2.0.0 (the new fleet takes it to its final message).
    const marker = JSON.parse(readFileSync(join(s.home, "update-in-progress.json"), "utf8"));
    expect(marker.progress).toMatchObject({ stage: "installed", version: "2.0.0", target: { messageId: "2" } });
  });

  it("killed before any of the new release was written: the old AgEnD is put back first (it runs again), then updated", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0"), v2 = release(s.root, "2.0.0");
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    const sibling = interruptedUpdate(s, "2.0.0");
    rmSync(s.pkgDir, { recursive: true });   // nothing of the new one yet: the sibling is the only copy
    const run = s.npm(["exec", "--yes", "--package", v2, "--", "agend-install", "--spec", v2]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/put back AgEnD v1\.0\.0 that an interrupted install had moved aside/);
    expect(s.version()).toBe("2.0.0");
    expect(existsSync(sibling)).toBe(false);
  });

  it("a release that does not prove itself: the previous one is put back and works, and the chat hears why", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0"), bad = release(s.root, "2.0.0", { brokenVersion: "0.0.0" });
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    writeFileSync(join(s.home, "update-in-progress.json"), JSON.stringify({ startedAt: Date.now(), pid: 1, progress: { operation: "update", stage: "downloading", target: { adapterId: "t", chatId: "1", messageId: "2" } } }));
    // The fallback reinstalls `@songsid/agend@1.0.0` from the registry; offline here, from its tarball.
    const run = s.npm(["exec", "--yes", "--package", bad, "--", "agend-install", "--spec", bad, "--previous-spec", v1]);
    expect(run.status).toBe(1);
    expect(s.version(), "the previous release runs").toBe("1.0.0");
    const marker = JSON.parse(readFileSync(join(s.home, "update-in-progress.json"), "utf8"));
    expect(marker.progress.stage).toBe("failed");
    expect(marker.progress.error).toMatch(/reports 0\.0\.0, not v2\.0\.0; v1\.0\.0 is back in place and works/);
  });

  it("a live installer's lock is respected (the only thing the lock still does): nothing is installed, the chat is told", () => {
    const s = scratch();
    const v1 = release(s.root, "1.0.0"), v2 = release(s.root, "2.0.0");
    expect(s.npm(["install", "-g", v1]).status).toBe(0);
    writeFileSync(join(s.root, "prefix", ".agend-install.lock"), JSON.stringify({ pid: process.pid, by: "agend-install" }));
    const run = s.npm(["exec", "--yes", "--package", v2, "--", "agend-install", "--spec", v2]);
    expect(run.status).toBe(75);
    expect(run.stdout).toMatch(/another AgEnD install \(pid \d+\) is running/);
    expect(s.version()).toBe("1.0.0");
  });

  it("a manual `npm install -g` is never refused because of a lock: AgEnD's postinstall no longer reads one", () => {
    const postinstall = readFileSync(join(REPO, "launcher", "postinstall.cjs"), "utf8");
    expect(postinstall).not.toMatch(/install-admission|admission\.admit|old-updater-note/);
    expect(existsSync(join(REPO, "launcher", "old-updater-note.cjs")), "the 2.1.12 restore note is gone").toBe(false);
    expect(readFileSync(join(REPO, "scripts", "preinstall-guard.cjs"), "utf8")).not.toMatch(/2\.1\.12|old-updater/);
  });
});

describe("#2264 the user's systemd is reached before any `systemctl --user` (the user's steps 3 and 4)", () => {
  const fake = (over: Partial<UserSystemdDeps> & { present?: Set<string> } = {}) => {
    const present = over.present ?? new Set<string>();
    const calls: string[] = [];
    const deps: UserSystemdDeps = {
      uid: 0, user: "root", env: {}, exists: p => present.has(p),
      run: (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        // Linger starts the user's manager: its sockets appear.
        if (command === "loginctl") { present.add("/var/lib/systemd/linger/root"); present.add("/run/user/0/systemd/private"); present.add("/run/user/0/bus"); }
        return { status: 0 };
      },
      sleep: () => {}, ...over,
    };
    return { deps, calls, present };
  };

  it("root with no linger, no XDG_RUNTIME_DIR and no bus: linger on, the manager up, both variables filled", () => {
    const f = fake();
    const r = ensureUserSystemd(f.deps, { waitMs: 1_000 });
    expect(f.calls[0]).toBe("loginctl enable-linger root");
    expect(r).toEqual({ lingerEnabled: true, managerUp: true, envFilled: ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] });
    expect(f.deps.env).toMatchObject({ XDG_RUNTIME_DIR: "/run/user/0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus" });
  });

  it("linger already on and a session's variables set: nothing is changed or run", () => {
    const f = fake({ present: new Set(["/var/lib/systemd/linger/root", "/run/user/0/systemd/private", "/run/user/0/bus"]), env: { XDG_RUNTIME_DIR: "/run/user/0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus" } });
    expect(ensureUserSystemd(f.deps)).toEqual({ lingerEnabled: true, managerUp: true, envFilled: [] });
    expect(f.calls).toEqual([]);
  });

  it("linger refused (no permission): the manager is still waited for briefly, root asks for user@0, and the answer says so", () => {
    const f = fake();
    f.deps.run = (command, args) => { f.calls.push(`${command} ${args.join(" ")}`); return { status: 1 }; };
    const r = ensureUserSystemd(f.deps, { waitMs: 500 });
    expect(r).toEqual({ lingerEnabled: false, managerUp: false, envFilled: ["XDG_RUNTIME_DIR"] });
    expect(f.calls).toEqual(["loginctl enable-linger root", "systemctl start user@0.service"]);
  });
});
