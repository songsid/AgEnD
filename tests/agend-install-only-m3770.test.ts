/**
 * M-3770 2.5 D1 (design update-wiring-m3770.md §3, §10.1; Fable): `agend-install --install-only`, the update
 * transaction's install hand. Under the `agend update` that holds the prefix lock (handed its token), it installs and
 * proves the exact version and does nothing else: the unit and its drop-in are byte-equal across it, no service-manager
 * call, no `agend install`, no restart, no marker, no lock of its own, no reinstall of the previous version. Without
 * the live lock's own token it changes nothing. npm is a stub that replaces the package the way npm does (the #2420 rig).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

const installer = createRequire(import.meta.url)("../launcher/agend-install.cjs") as { main(argv: string[], deps: Record<string, unknown>): number };
const lockReaders = createRequire(import.meta.url)("../launcher/install-admission.cjs") as Record<string, unknown> & { TOKEN_ENV: string };
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
// This installer is the target's own: the version it ships in (--target must name it).
const NEW = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;
const OLD = "2.3.0-beta.1";
const TOKEN = "f".repeat(32);
const BINS = { agend: "launcher/agend", "agend-agent": "launcher/agend-agent", "agend-install": "launcher/agend-install.cjs" };

function pkg(dir: string, version: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@songsid/agend", version, bin: BINS }));
  for (const b of Object.values(BINS)) { mkdirSync(join(dir, b, ".."), { recursive: true }); writeFileSync(join(dir, b), `${version}\n`); }
}

function rig(o: { token?: string | null; lockToken?: string; holderLive?: boolean; installs?: string; noLock?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-install-only-")); roots.push(root);
  const prefix = join(root, "prefix"), nodeModules = join(prefix, "lib", "node_modules"), home = join(root, "agend-home"), userHome = join(root, "user-home");
  for (const d of [nodeModules, home, userHome, join(prefix, "bin")]) mkdirSync(d, { recursive: true });
  const pkgDir = join(nodeModules, "@songsid", "agend");
  const link = () => { for (const [name, rel] of Object.entries(BINS)) { rmSync(join(prefix, "bin", name), { force: true }); symlinkSync(join("..", "lib", "node_modules", "@songsid", "agend", rel), join(prefix, "bin", name)); } };
  pkg(pkgDir, OLD); link();
  // The unit and its drop-in (the transaction's route) — byte-equal across the install hand.
  const unit = join(userHome, ".config", "systemd", "user", "com.agend.fleet.service");
  const dropIn = join(`${unit}.d`, "agend-update-recovery.conf");
  mkdirSync(join(unit, ".."), { recursive: true }); mkdirSync(join(dropIn, ".."), { recursive: true });
  writeFileSync(unit, "[Service]\nExecStart=/old/agend fleet start\n");
  writeFileSync(dropIn, "[Service]\nExecStartPre=/x/recover.cjs --pre-start\n");
  const marker = join(home, "update-in-progress.json");
  writeFileSync(marker, JSON.stringify({ startedAt: 1, pid: 4343, progress: { operation: "update", stage: "preparing" } }));
  // The update's prefix lock (install-lock.ts's record), held by the updater (pid 4343).
  const lockPath = join(realpathSync(prefix), ".agend-install.lock");
  const lockText = JSON.stringify({ pid: 4343, processStart: "S", prefix: realpathSync(prefix), targetSpec: `@songsid/agend@${NEW}`, agendHome: home,
    token: o.lockToken ?? TOKEN, createdAt: new Date().toISOString() }) + "\n";
  if (!o.noLock) writeFileSync(lockPath, lockText);
  const calls: string[] = [], log: string[] = [];
  const ok = (stdout = "") => ({ status: 0, signal: null, stdout, stderr: "" });
  const run = (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
    const line = `${cmd} ${args.join(" ")}`;
    if (line === "npm root -g") return ok(nodeModules + "\n");
    if (line === "npm prefix -g") return ok(prefix + "\n");
    if (line === "ps -A -o pid=,ppid=,args=") return ok("4242 1 node agend-install.cjs\n");
    calls.push(line);
    if (cmd === "npm" && args[0] === "install") {
      calls.push(`token=${opts?.env?.[lockReaders.TOKEN_ENV] ?? "none"}`);
      rmSync(pkgDir, { recursive: true, force: true }); pkg(pkgDir, o.installs ?? NEW); link();
      return ok();
    }
    if (cmd === join(prefix, "bin", "agend") && args[0] === "--version") {
      try { return ok(readFileSync(realpathSync(cmd), "utf8")); } catch { return { status: 127, signal: null, stdout: "", stderr: "" }; }
    }
    return ok();
  };
  const env: Record<string, string> = { HOME: userHome, AGEND_HOME: home, XDG_RUNTIME_DIR: "/run/user/501" };
  if (o.token !== null) env[lockReaders.TOKEN_ENV] = o.token ?? TOKEN;
  const deps = { pid: 4242, uid: 501, now: () => Date.now(), log: (l: string) => log.push(l), alive: (pid: number) => pid === 4343 || pid === 4242,
    env, lockReaders: { ...lockReaders, exists: (pid: number) => pid === 4343, processStart: () => (o.holderLive === false ? "another start" : "S"), startTicks: () => null, bootId: () => null },
    run, sleep: () => {}, monotonicNow: () => 0 };
  const snapshot = () => [readFileSync(unit, "utf8"), readFileSync(dropIn, "utf8"), readFileSync(marker, "utf8"), existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null];
  const before = snapshot();
  const main = () => installer.main(["--install-only", "--target", NEW, "--spec", `@songsid/agend@${NEW}`], deps);
  const version = () => readFileSync(realpathSync(join(prefix, "bin", "agend")), "utf8").trim();
  return { root, prefix, calls, log, main, snapshot, before, version, lockText, deps, entries: () => existsSync(join(realpathSync(prefix), ".agend-install.d")) ? readdirSync(join(realpathSync(prefix), ".agend-install.d")) : [] };
}

describe("M-3770 2.5 D1: agend-install --install-only", () => {
  it("under the update's live lock: installs and proves the exact version, with its token; nothing else — unit, drop-in, marker and lock byte-equal, no manager call", () => {
    const r = rig();
    expect(r.main()).toBe(0);
    expect(r.version()).toBe(NEW);
    expect(r.calls).toEqual([`npm install -g @songsid/agend@${NEW} --allow-scripts=@songsid/agend`, `token=${TOKEN}`, `${join(r.prefix, "bin", "agend")} --version`]);
    expect(r.snapshot()).toEqual(r.before);
    expect(r.calls.some(c => /^(systemctl|launchctl)\b/.test(c) || / (install|restart|start)( |$)/.test(c.replace(/^npm install/, "")))).toBe(false);
    expect(r.log.at(-1)).toBe(`  ✓ AgEnD v${NEW} is installed (${join(r.prefix, "bin", "agend")}); the update starts it`);
  });

  it("a version that doesn't prove itself: exit 1, the previous one isn't reinstalled (the transaction rolls back from its snapshot)", () => {
    const r = rig({ installs: "9.9.9" });
    expect(r.main()).toBe(1);
    expect(r.calls.filter(c => c.startsWith("npm install"))).toHaveLength(1);
    expect(r.snapshot()).toEqual(r.before);
    expect(r.log.at(-1)).toContain("the update rolls back");
  });

  it("never admitted without the live lock's own token: no token, another token, no lock, or a holder that isn't live — exit 75, nothing changed", () => {
    for (const o of [{ token: null }, { token: "e".repeat(32) }, { noLock: true }, { holderLive: false }]) {
      const r = rig(o);
      expect(r.main(), JSON.stringify(o)).toBe(75);
      expect(r.calls).toEqual([]);
      expect(r.version()).toBe(OLD);
      expect(r.snapshot()).toEqual(r.before);
      expect(r.entries()).toEqual([]);
      if (o.token === null) expect(r.log.at(-1)).toContain("no install token was handed over");
    }
  });

  it("the installer's other modes are unchanged: without --install-only it takes the prefix itself, so the update's live lock refuses it", () => {
    const r = rig();
    expect(installer.main(["--upgrade", "--spec", `@songsid/agend@${NEW}`], r.deps)).toBe(75);
    expect(r.calls.filter(c => c.startsWith("npm install"))).toEqual([]);
    expect(r.log.join("\n")).toContain("another AgEnD install (pid 4343) is running");
  });
});
