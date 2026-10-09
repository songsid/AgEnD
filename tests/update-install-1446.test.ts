/**
 * #1446: `agend update` must never remove the current install before the new one has succeeded, must verify the
 * package npm actually installed — its identity, version and exact bin target, with PATH's `agend` resolving to that
 * same file (#1449 review) — in the environment it will run in (nvm's Node, item 1), must prove the version and a
 * working native module (item 3), and must report a definite systemd restart failure (item 4).
 *
 * The harness is inert but real: real bash/sh/readlink/node, an `npm` stub that installs fixture packages into a
 * scratch prefix, fixture packages whose `better-sqlite3` records what is done to it, and an nvm.sh in a directory
 * whose name holds `$`, spaces and quotes. No host npm, no network, no fleet.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { systemdRestartOutcome } from "../src/service-installer.js";
import {
  isLocalLinkTarget, NATIVE_CHECK_SCRIPT, newAgendInvocation, retireSystemCopy, runUpdateInstall,
  type CommandRunner, type UpdateInstallPlan,
} from "../src/update-install.js";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

type NativeMode = "ok" | "throw-on-open" | "wrong-answer" | "fails-in-worker";

/** Single-quote for sh: the nvm fixture's path holds `'`, `$` and spaces on purpose. */
function sq(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** A fixture @songsid/agend package: `agend --version` prints its version; better-sqlite3 is an inert recorder. */
function fixturePackage(root: string, name: string, version: string, native: NativeMode = "ok", opts: { launcher?: boolean; select?: "runtime" | "error" | "other-package"; realLauncher?: boolean } = {}): string {
  const dir = join(root, "src", name);
  mkdirSync(join(dir, "dist"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "better-sqlite3"), { recursive: true });
  // #1450: since the launcher, the bin is `launcher/agend` (an sh script) and the CLI stays dist/cli.js.
  const bin = opts.launcher ? "launcher/agend" : "dist/cli.js";
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@songsid/agend", version, bin: { agend: bin } }));
  writeFileSync(join(dir, ".bin-target"), bin);
  if (opts.realLauncher) {
    // The SHIPPED launcher (sh bin + runtime-select), and a JS CLI it can run in process or spawn.
    cpSync(join(process.cwd(), "launcher"), join(dir, "launcher"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@songsid/agend", version, bin: { agend: "launcher/agend" }, engines: { node: "^22.14.0 || ^23.6.0 || >=24" } }));
    writeFileSync(join(dir, ".bin-target"), "launcher/agend");
    writeFileSync(join(dir, "dist", "cli.js"), `if (process.argv[2] === "--version") console.log(${JSON.stringify(version)});\n`);
  }
  if (opts.launcher) {
    mkdirSync(join(dir, "launcher"));
    // A launcher-era package (#1450): `--agend-select-json` answers what launcher/launch.cjs would — the bundled Node,
    // here a stand-in at <root>/bundled/node that logs each run — and the package it found itself in.
    const bundled = join(root, "bundled", "node");
    mkdirSync(dirname(bundled), { recursive: true });
    writeFileSync(bundled, `#!/bin/sh\necho "bundled $*" >> ${sq(join(root, "bundled.log"))}\nexec ${sq(process.execPath)} "$@"\n`);
    chmodSync(bundled, 0o755);
    if (opts.select) writeFileSync(join(dir, "launcher", "runtime-select.cjs"), "");
    const answer = opts.select === "error" ? `printf '{"error":"the bundled Node is missing","recovery":"npm install -g @songsid/agend@${version}"}\\n'; exit 1`
      : `pkg=$(cd "$(dirname "$self")/.." && pwd -P); printf '{"node":"%s","source":"runtime","pkgDir":"%s","entry":"%s/dist/cli.js"}\\n' ${sq(bundled)} "$${opts.select === "other-package" ? "{pkg}-elsewhere" : "pkg"}" "$pkg"; exit 0`;
    writeFileSync(join(dir, "launcher", "agend"), [
      "#!/bin/sh",
      'self=$0; while [ -L "$self" ]; do l=$(readlink "$self"); case $l in /*) self=$l;; *) self=$(dirname "$self")/$l;; esac; done',
      `[ "$1" = --agend-select-json ] && { ${answer}; }`,
      `exec ${sq(join(dir, "dist", "cli.js"))} "$@"`,
    ].join("\n") + "\n");
    chmodSync(join(dir, "launcher", "agend"), 0o755);
  }
  if (!opts.realLauncher) {
    writeFileSync(join(dir, "dist", "cli.js"), `#!/bin/sh\n[ "$1" = "--version" ] && { echo ${version}; exit 0; }\necho "agend $*" >> '${join(root, "agend.log")}'\nexit 0\n`);
    chmodSync(join(dir, "dist", "cli.js"), 0o755);
  }
  writeFileSync(join(dir, "node_modules", "better-sqlite3", "index.js"), `
const fs = require("node:fs"); const log = ${JSON.stringify(join(root, "native.log"))};
const note = line => fs.appendFileSync(log, line + "\\n");
module.exports = class Database {
  constructor(file) {
    note("open " + file);
    if (${JSON.stringify(native)} === "throw-on-open") throw new Error("SIGSEGV stand-in");
    if (${JSON.stringify(native)} === "fails-in-worker" && !require("node:worker_threads").isMainThread) throw new Error("worker-only failure");
  }
  prepare(sql) { note("prepare " + sql); return { get: () => { note("get"); return { one: ${native === "wrong-answer" ? 2 : 1} }; } }; }
  close() { note("close"); }
};`);
  return dir;
}

/**
 * A scratch world: `npm` stub on PATH that "installs" a fixture package directory (the spec) into the prefix the way
 * npm does (package dir + bin symlink), or fails without touching anything when NPM_FAIL is set.
 */
function world() {
  const root = mkdtempSync(join(tmpdir(), "agend-1446-"));
  roots.push(root);
  const prefix = join(root, "prefix"), tools = join(root, "tools");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(join(prefix, "lib", "node_modules", "@songsid"), { recursive: true });
  mkdirSync(tools, { recursive: true });
  const calls = join(root, "calls.log");
  writeFileSync(calls, "");
  const npmStub = (pfx: string) => `#!/bin/sh
echo "npm $*" >> ${sq(calls)}
[ -n "$AGEND_INSTALL_TOKEN" ] && echo "token $AGEND_INSTALL_TOKEN for npm $*" >> ${sq(calls)}
case "$1 $2" in
  "root -g") echo ${sq(join(pfx, "lib", "node_modules"))}; exit 0;;
  "prefix -g") echo ${sq(pfx)}; exit 0;;
  "install -g")
    [ -n "$NPM_FAIL" ] && exit 1
    rm -rf ${sq(join(pfx, "lib", "node_modules", "@songsid", "agend"))}
    cp -r "$3" ${sq(join(pfx, "lib", "node_modules", "@songsid", "agend"))}
    ln -sf "../lib/node_modules/@songsid/agend/$(cat "$3/.bin-target")" ${sq(join(pfx, "bin", "agend"))}
    exit 0;;
esac
exit 0
`;
  writeFileSync(join(tools, "npm"), npmStub(prefix));
  writeFileSync(join(tools, "sudo"), `#!/bin/sh\necho "sudo $*" >> '${calls}'\nexit 0\n`);
  symlinkSync(process.execPath, join(tools, "node"));
  for (const f of ["npm", "sudo"]) chmodSync(join(tools, f), 0o755);
  const extraPath: string[] = [];
  const env: Record<string, string> = {};
  const runner: CommandRunner = {
    run: (command, args, options = {}) => {
      // cwd = the scratch root: a spliced `$(touch pwned)` would land where the tests look for it.
      const r = spawnSync(command, args, {
        encoding: "utf8", cwd: root,
        env: { PATH: [...extraPath, tools, join(prefix, "bin"), "/usr/bin", "/bin"].join(":"), HOME: root, ...env, ...options.env },
      });
      return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    log: () => {},
  };
  const callLog = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
  const nativeLog = () => existsSync(join(root, "native.log")) ? readFileSync(join(root, "native.log"), "utf8").trim().split("\n") : [];
  return { root, prefix, tools, runner, env, extraPath, callLog, nativeLog, npmStub };
}

const plan = (pkg: string, targetVersion: string | null = "2.2.0"): UpdateInstallPlan => ({ pkg, targetVersion, viaNvm: false, nvmSh: "/nonexistent" });

describe("#1450 C6: a package that does not verify is replaced by the previous one, which must verify", () => {
  const withRollback = (pkg: string, targetVersion: string | null = "2.2.0"): UpdateInstallPlan => ({
    ...plan(pkg, targetVersion), lock: () => ({ ok: true, token: "9".repeat(32) }), rollback: true, now: () => new Date("2026-10-09T01:02:03Z"),
  });
  const installedVersion = (w: ReturnType<typeof world>) => JSON.parse(readFileSync(join(w.prefix, "lib", "node_modules", "@songsid", "agend", "package.json"), "utf8")).version;

  it("the new package cannot open a database: v2.1.12 is put back, verified, and the copy is gone", () => {
    const w = world();
    runUpdateInstall(plan(fixturePackage(w.root, "v2112", "2.1.12"), "2.1.12"), w.runner);
    const outcome = runUpdateInstall(withRollback(fixturePackage(w.root, "v220", "2.2.0", "throw-on-open")), w.runner);
    expect(outcome).toMatchObject({ ok: false, stage: "verify", message: expect.stringContaining("Rolled back to v2.1.12, which verifies") });
    expect(installedVersion(w)).toBe("2.1.12");
    expect(realpathSync(join(w.prefix, "bin", "agend"))).toBe(realpathSync(join(w.prefix, "lib", "node_modules", "@songsid", "agend", "dist", "cli.js")));
    expect(existsSync(join(w.prefix, ".agend-rollback"))).toBe(true);
    expect(readdirSync(join(w.prefix, ".agend-rollback"))).toEqual([]);
  });

  it("npm's own failure: npm rolled back, and the copy is removed", () => {
    const w = world();
    runUpdateInstall(plan(fixturePackage(w.root, "v2112", "2.1.12"), "2.1.12"), w.runner);
    w.env.NPM_FAIL = "1";
    expect(runUpdateInstall(withRollback(fixturePackage(w.root, "v220", "2.2.0")), w.runner)).toMatchObject({ ok: false, stage: "install" });
    expect(readdirSync(join(w.prefix, ".agend-rollback"))).toEqual([]);
    expect(installedVersion(w)).toBe("2.1.12");
  });

  it("success: the outcome carries the preimage (for a later service failure), the new package is installed", () => {
    const w = world();
    runUpdateInstall(plan(fixturePackage(w.root, "v2112", "2.1.12"), "2.1.12"), w.runner);
    const outcome = runUpdateInstall(withRollback(fixturePackage(w.root, "v220", "2.2.0")), w.runner);
    expect(outcome.ok && outcome.rollback?.preimage?.version).toBe("2.1.12");
    expect(existsSync(join(outcome.ok && outcome.rollback?.preimage ? outcome.rollback.preimage.dir : "/nonexistent", "agend", "package.json"))).toBe(true);
    expect(installedVersion(w)).toBe("2.2.0");
  });

  it("nothing installed yet: no preimage, and a failed verify has nothing to roll back to", () => {
    const w = world();
    const outcome = runUpdateInstall(withRollback(fixturePackage(w.root, "v220", "2.2.0", "throw-on-open")), w.runner);
    expect(outcome).toMatchObject({ ok: false, stage: "verify" });
    expect(outcome.ok === false && outcome.message).not.toContain("Rolled back");
  });
});

describe("#1450 C1: the npm prefix is locked before npm runs; the token goes to npm only", () => {
  it("the lock is asked for npm's own prefix; its token reaches `npm install` and no other command", () => {
    const w = world();
    const asked: string[] = [];
    const outcome = runUpdateInstall({ ...plan(fixturePackage(w.root, "v220", "2.2.0")), lock: prefix => { asked.push(prefix); return { ok: true, token: "7".repeat(32) }; } }, w.runner);
    expect(outcome.ok).toBe(true);
    expect(asked).toEqual([w.prefix]);
    expect(w.callLog().filter(line => line.startsWith("token "))).toEqual([`token ${"7".repeat(32)} for npm install -g ${join(w.root, "src", "v220")}`]);
  });

  it("a refused lock stops before npm installs anything", () => {
    const w = world();
    runUpdateInstall(plan(fixturePackage(w.root, "v2112", "2.1.12"), "2.1.12"), w.runner);
    const outcome = runUpdateInstall({ ...plan(fixturePackage(w.root, "v220", "2.2.0")), lock: () => ({ ok: false, reason: "another AgEnD install is running on /p" }) }, w.runner);
    expect(outcome).toMatchObject({ ok: false, stage: "lock", message: expect.stringContaining("another AgEnD install is running on /p. Nothing was changed.") });
    expect(w.callLog().filter(line => line.startsWith("npm install"))).toHaveLength(1);          // only the 2.1.12 setup
  });
});

describe("#1450 C4: a launcher-era target is verified on the Node IT selects, not the updater's", () => {
  it("through the SHIPPED launcher: AGEND_NODE is what verification proves and reports — not PATH's node", () => {
    const w = world();
    const chosen = join(w.root, "chosen-node");
    writeFileSync(chosen, `#!/bin/sh\necho "chosen $1" >> ${sq(join(w.root, "chosen.log"))}\nexec ${sq(process.execPath)} "$@"\n`);
    chmodSync(chosen, 0o755);
    w.env.AGEND_NODE = chosen;
    const outcome = runUpdateInstall(plan(fixturePackage(w.root, "v220", "2.2.0", "ok", { realLauncher: true })), w.runner);
    expect(outcome).toMatchObject({ ok: true, node: realpathSync(chosen) });
    expect(readFileSync(join(w.root, "chosen.log"), "utf8")).toContain("chosen -e");          // the DB proof ran on it
    expect(w.nativeLog()).toEqual([...ONE_OPEN, ...ONE_OPEN]);
  });

  it("through the SHIPPED launcher: a selection whose DB fails is refused even though PATH's node would pass", () => {
    const w = world();
    const chosen = join(w.root, "chosen-node");
    // A Node on which the package's database cannot open (as better-sqlite3 13 on Node 20 SIGSEGVs).
    writeFileSync(chosen, `#!/bin/sh\n[ "$1" = -e ] && case "$2" in *better-sqlite3*) exit 139;; esac\nexec ${sq(process.execPath)} "$@"\n`);
    chmodSync(chosen, 0o755);
    w.env.AGEND_NODE = chosen;
    expect(runUpdateInstall(plan(fixturePackage(w.root, "v220", "2.2.0", "ok", { realLauncher: true })), w.runner))
      .toMatchObject({ ok: false, stage: "verify", message: expect.stringContaining(`on the Node it selected, ${realpathSync(chosen)}`) });
  });

  const install = (select: "runtime" | "error" | "other-package", native: NativeMode = "ok") => {
    const w = world();
    const outcome = runUpdateInstall(plan(fixturePackage(w.root, "v220", "2.2.0", native, { launcher: true, select })), w.runner);
    const ran = existsSync(join(w.root, "bundled.log")) ? readFileSync(join(w.root, "bundled.log"), "utf8") : "";
    return { w, outcome, ran };
  };

  it("the proof (both threads) runs on the selected bundled Node, and that Node is what activation must find", () => {
    const { w, outcome, ran } = install("runtime");
    expect(outcome).toMatchObject({ ok: true, node: join(w.root, "bundled", "node") });
    expect(ran).toContain(`bundled -e ${NATIVE_CHECK_SCRIPT.slice(0, 20)}`);
    expect(w.nativeLog()).toEqual([...ONE_OPEN, ...ONE_OPEN]);
  });

  it("a package that will not start here (its selection refuses) fails verification with its own repair line", () => {
    const { outcome, ran } = install("error");
    expect(outcome).toMatchObject({ ok: false, stage: "verify", message: expect.stringContaining("the bundled Node is missing. To repair: npm install -g @songsid/agend@2.2.0") });
    expect(ran).toBe("");
  });

  it("a selection that names another package is refused", () => {
    expect(install("other-package").outcome).toMatchObject({ ok: false, stage: "verify", message: expect.stringContaining("not the installed package") });
  });

  it("a module that fails on the selected Node (in a worker) fails verification, naming that Node", () => {
    const { w, outcome } = install("runtime", "fails-in-worker");
    expect(outcome).toMatchObject({ ok: false, stage: "verify", message: expect.stringContaining(`on the Node it selected, ${join(w.root, "bundled", "node")}`) });
  });
});

describe("P0: the current install is never removed before the new one has succeeded", () => {
  it("a launcher-shaped package (#1450): the bin is the sh launcher, the verified entry is still dist/cli.js", () => {
    const w = world();
    const outcome = runUpdateInstall(plan(fixturePackage(w.root, "v220", "2.2.0", "ok", { launcher: true })), w.runner);
    const pkg = realpathSync(join(w.prefix, "lib", "node_modules", "@songsid", "agend"));
    expect(outcome).toMatchObject({ ok: true, version: "2.2.0", bin: join(pkg, "launcher", "agend"), entry: join(pkg, "dist", "cli.js") });
  });

  it("installs over the current package with no unlink, and verifies the installed one", () => {
    const w = world();
    runUpdateInstall(plan(fixturePackage(w.root, "v2112", "2.1.12"), "2.1.12"), w.runner);
    const outcome = runUpdateInstall(plan(fixturePackage(w.root, "v220", "2.2.0")), w.runner);
    expect(outcome).toMatchObject({ ok: true, agendPath: join(w.prefix, "bin", "agend"), version: "2.2.0" });
    // #1450 C4: the canonical inner entry a service starts, verified as a realpath (here also the bin).
    expect(outcome.ok && outcome.entry).toBe(realpathSync(join(w.prefix, "lib", "node_modules", "@songsid", "agend", "dist", "cli.js")));
    expect(w.callLog().some(line => /\bunlink\b|\buninstall\b/.test(line))).toBe(false);
  });

  it("a failed install leaves the current package and runs nothing after it", () => {
    const w = world();
    runUpdateInstall(plan(fixturePackage(w.root, "v2112", "2.1.12"), "2.1.12"), w.runner);
    const before = w.callLog().length;
    w.env.NPM_FAIL = "1";
    expect(runUpdateInstall(plan(fixturePackage(w.root, "v220", "2.2.0")), w.runner)).toMatchObject({ ok: false, stage: "install" });
    expect(w.callLog().slice(before)).toEqual(["npm root -g", `npm install -g ${join(w.root, "src", "v220")}`]);
    expect(execFileSync(join(w.prefix, "bin", "agend"), ["--version"], { encoding: "utf8" }).trim()).toBe("2.1.12");
  });

  it("the update command no longer carries its own unlink step", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(cli).not.toMatch(/npm unlink -g @songsid\/agend/);
    expect(cli).not.toMatch(/resolved\.includes\("@songsid"\)/);
  });

  it.each([
    [false, "/usr/lib/node_modules/@songsid/agend", false],
    [true, "/home/u/Projects/AgEnD/", true],
    [true, "/home/u/.local/share/pnpm/global/5/node_modules/@songsid/agend", false],
  ])("isLocalLinkTarget(symlink=%s, %s) = %s", (symlink, target, expected) => {
    expect(isLocalLinkTarget(symlink, target)).toBe(expected);
  });
});

describe("item 3: the installed package is verified — not whatever agend wins PATH", () => {
  /** A checkout of `version` earlier on PATH than npm's prefix (a dev clone, another prefix). */
  const shadow = (w: ReturnType<typeof world>, version: string) => {
    const dir = fixturePackage(w.root, `shadow-${version}`, version);
    mkdirSync(join(w.root, "shadow-bin"), { recursive: true });
    symlinkSync(join(dir, "dist", "cli.js"), join(w.root, "shadow-bin", "agend"));
    w.extraPath.unshift(join(w.root, "shadow-bin"));
  };

  it.each([
    ["a same-version checkout", "2.2.0", "2.2.0" as string | null],
    ["an older checkout, target unknown (dist-tag only)", "2.1.12", null],
    ["a same-version checkout, target unknown", "2.2.0", null],
  ])("%s first on PATH fails verification", (_name, shadowVersion, target) => {
    const w = world();
    shadow(w, shadowVersion);
    const outcome = runUpdateInstall(plan(fixturePackage(w.root, "v220", "2.2.0"), target), w.runner);
    expect(outcome).toMatchObject({ ok: false, stage: "verify" });
    expect(!outcome.ok && outcome.message).toContain("Another install shadows it");
  });

  it("npm installing a different version than the target fails", () => {
    const w = world();
    expect(runUpdateInstall(plan(fixturePackage(w.root, "v221", "2.2.1"), "2.2.0"), w.runner))
      .toMatchObject({ ok: false, stage: "verify", message: expect.stringContaining("npm installed v2.2.1") });
  });

  it("an unknown target is verified as whatever npm installed", () => {
    const w = world();
    expect(runUpdateInstall(plan(fixturePackage(w.root, "v221", "2.2.1"), null), w.runner)).toMatchObject({ ok: true, version: "2.2.1" });
  });

  it("the global bin that does not lead to the installed package fails", () => {
    const w = world();
    const other = fixturePackage(w.root, "other", "2.2.0");
    writeFileSync(join(w.tools, "npm"), w.npmStub(w.prefix).replace(/ln -sf [^\n]*\n/, `ln -sf '${join(other, "dist", "cli.js")}' '${join(w.prefix, "bin", "agend")}'\n`));
    expect(runUpdateInstall(plan(fixturePackage(w.root, "v220", "2.2.0")), w.runner))
      .toMatchObject({ ok: false, stage: "verify", message: expect.stringContaining("does not lead to the installed package") });
  });
});

const ONE_OPEN = ["open :memory:", "prepare select 1 as one", "get", "close"];

describe("item 3: the native check really opens a database", () => {
  it("the generated script constructs, queries and closes, against the installed package's module", () => {
    const w = world();
    const dir = fixturePackage(w.root, "direct", "2.2.0");
    const r = spawnSync(process.execPath, ["-e", NATIVE_CHECK_SCRIPT, dir], { encoding: "utf8" });
    expect(r.stdout).toBe("native-ok");
    expect(w.nativeLog()).toEqual([...ONE_OPEN, ...ONE_OPEN]);   // the main thread, then a worker
  });

  it.each([["throw-on-open"], ["wrong-answer"], ["fails-in-worker"]] as const)("a module that fails (%s) fails verification", (mode) => {
    const w = world();
    expect(runUpdateInstall(plan(fixturePackage(w.root, "v220", "2.2.0", mode)), w.runner))
      .toMatchObject({ ok: false, stage: "verify", message: expect.stringContaining("cannot open a database") });
  });

  it("a successful update ran the full check on the installed package", () => {
    const w = world();
    expect(runUpdateInstall(plan(fixturePackage(w.root, "v220", "2.2.0")), w.runner).ok).toBe(true);
    expect(w.nativeLog()).toEqual([...ONE_OPEN, ...ONE_OPEN]);   // the main thread, then a worker
  });
});

describe("item 1: an nvm install runs every step inside nvm's Node 22 — nvm.sh path as data", () => {
  /** nvm.sh in a directory named with `$`, spaces and quotes; `nvm use 22` puts its own npm/node first on PATH. */
  function nvmWorld() {
    const w = world();
    const nvmDir = join(w.root, `nvm path $HOME "q" 'x' $(touch pwned)`);
    const nvmBin = join(nvmDir, "versions", "22", "bin");
    const nvmPrefix = join(nvmDir, "versions", "22");
    mkdirSync(nvmBin, { recursive: true });
    mkdirSync(join(nvmPrefix, "lib", "node_modules", "@songsid"), { recursive: true });
    writeFileSync(join(nvmBin, "npm"), w.npmStub(nvmPrefix));
    writeFileSync(join(nvmBin, "node"), `#!/bin/sh\necho "nvm-node" >> '${join(w.root, "calls.log")}'\nexec '${process.execPath}' "$@"\n`);
    for (const f of ["npm", "node"]) chmodSync(join(nvmBin, f), 0o755);
    writeFileSync(join(nvmDir, "nvm.sh"), `nvm() { case "$1" in install) return 0;; use) PATH='${nvmBin.replace(/'/g, `'\\''`)}':"$PATH"; export PATH;; esac; }\n`);
    return { w, nvmSh: join(nvmDir, "nvm.sh"), nvmPrefix };
  }

  it("installs and verifies with nvm's node; the old system copy is NOT removed until the activation settles", () => {
    const { w, nvmSh, nvmPrefix } = nvmWorld();
    const outcome = runUpdateInstall({ pkg: fixturePackage(w.root, "v220", "2.2.0"), targetVersion: "2.2.0", viaNvm: true, nvmSh }, w.runner);
    expect(outcome).toMatchObject({ ok: true, agendPath: join(nvmPrefix, "bin", "agend"), version: "2.2.0", retireSystemCopy: true });
    const calls = w.callLog();
    expect(calls).toContain("nvm-node");                                     // the checks ran on nvm's node
    // #1473 review: the old system copy is what the current service still runs — an activation that fails later
    // must find it in place. The caller retires it once the fleet runs the new install.
    expect(calls.some(line => /uninstall/.test(line))).toBe(false);
    retireSystemCopy(w.runner);
    expect(w.callLog().at(-1)).toBe("sudo -n npm uninstall -g @songsid/agend");
    expect(existsSync(join(w.root, "pwned")), "the path was data, not shell").toBe(false);
  });

  // #1472 review: one `nvm use 22` selection, frozen — locking, installing and verifying all happen in that prefix.
  it("nvm's selection is frozen once: a later `nvm use 22` that would pick another Node 22 is never asked", () => {
    const w = world();
    const nvmDir = join(w.root, "nvm");
    const sel = (v: string) => ({ bin: join(nvmDir, "versions", v, "bin"), prefix: join(nvmDir, "versions", v) });
    const A = sel("22a"), B = sel("22b");
    for (const x of [A, B]) {
      mkdirSync(x.bin, { recursive: true });
      mkdirSync(join(x.prefix, "lib", "node_modules", "@songsid"), { recursive: true });
      writeFileSync(join(x.bin, "npm"), w.npmStub(x.prefix));
      writeFileSync(join(x.bin, "node"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
      for (const f of ["npm", "node"]) chmodSync(join(x.bin, f), 0o755);
    }
    // Each `nvm use 22` after the first selects ANOTHER Node 22 (e.g. one installed meanwhile).
    writeFileSync(join(nvmDir, "nvm.sh"), `nvm() { case "$1" in install) return 0;; use) c=$(cat '${join(nvmDir, "uses")}' 2>/dev/null || echo 0); c=$((c+1)); echo $c > '${join(nvmDir, "uses")}'; if [ $c -eq 1 ]; then PATH='${A.bin}':"$PATH"; else PATH='${B.bin}':"$PATH"; fi; export PATH;; esac; }\n`);
    const locked: string[] = [];
    const outcome = runUpdateInstall({
      pkg: fixturePackage(w.root, "v220", "2.2.0"), targetVersion: "2.2.0", viaNvm: true, nvmSh: join(nvmDir, "nvm.sh"),
      lock: prefix => { locked.push(prefix); return { ok: true, token: "f".repeat(32) }; },
    }, w.runner);
    expect(outcome).toMatchObject({ ok: true, agendPath: join(A.prefix, "bin", "agend") });
    expect(locked).toEqual([A.prefix]);
    expect(existsSync(join(A.prefix, "lib", "node_modules", "@songsid", "agend", "package.json"))).toBe(true);
    expect(existsSync(join(B.prefix, "lib", "node_modules", "@songsid", "agend"))).toBe(false);
    expect(readFileSync(join(nvmDir, "uses"), "utf8").trim()).toBe("1");
  });

  it("a failed verification under nvm keeps the old system copy", () => {
    const { w, nvmSh } = nvmWorld();
    expect(runUpdateInstall({ pkg: fixturePackage(w.root, "v220", "2.2.0", "throw-on-open"), targetVersion: "2.2.0", viaNvm: true, nvmSh }, w.runner))
      .toMatchObject({ ok: false, stage: "verify" });
    expect(w.callLog().some(line => /uninstall/.test(line))).toBe(false);
  });

  it("the new agend's later commands (install, completion, restart) run in the same environment, path as data", () => {
    const { w, nvmSh } = nvmWorld();
    const pkg = fixturePackage(w.root, "v220", "2.2.0");
    const inv = newAgendInvocation({ viaNvm: true, nvmSh }, join(pkg, "dist", "cli.js"));
    expect(inv.args).toContain(nvmSh);                                        // passed as an argument, not in the script
    expect(inv.args[1]).not.toContain(nvmSh);
    const r = spawnSync(inv.command, [...inv.args, "restart"], { encoding: "utf8", cwd: w.root, env: { PATH: "/usr/bin:/bin" } });
    expect(r.status).toBe(0);
    expect(readFileSync(join(w.root, "agend.log"), "utf8").trim()).toBe("agend restart");
    expect(existsSync(join(w.root, "pwned"))).toBe(false);
    expect(newAgendInvocation({ viaNvm: false, nvmSh }, "/usr/bin/agend")).toEqual({ command: "/usr/bin/agend", args: [] });
  });
});

describe("item 4: systemctl restart outcomes", () => {
  it("our wait running out is indeterminate; systemctl's own error is a failure", () => {
    expect(systemdRestartOutcome("agend", false, vi.fn())).toBe("restarted");
    expect(systemdRestartOutcome("agend", false, () => { throw Object.assign(new Error("spawnSync systemctl ETIMEDOUT"), { code: "ETIMEDOUT" }); })).toBe("timed-out");
    expect(systemdRestartOutcome("agend", false, () => { throw Object.assign(new Error("Command failed"), { status: 1 }); })).toBe("failed");
  });
});

// The real thing, offline: npm itself on a scratch prefix, local tarballs.
describe("real npm (scratch prefix, local tarballs): a failed install leaves the current one in place", () => {
  const root = mkdtempSync(join(tmpdir(), "agend-1446-npm-"));
  roots.push(root);
  const prefix = join(root, "prefix");
  const env = { ...process.env, npm_config_prefix: prefix, npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
  const pack = (version: string, preinstall?: string): string => {
    const dir = join(root, `src-${version}`);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@songsid/agend", version, bin: { agend: "dist/cli.js" }, ...(preinstall ? { scripts: { preinstall } } : {}) }));
    writeFileSync(join(dir, "dist", "cli.js"), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)})\n`);
    chmodSync(join(dir, "dist", "cli.js"), 0o755);
    const out = execFileSync("npm", ["pack", "--silent", "--pack-destination", root], { cwd: dir, env, encoding: "utf8" }).trim().split("\n").pop()!;
    return join(root, out);
  };
  const runner: CommandRunner = {
    run: (command, args) => {
      const r = spawnSync(command, args, { encoding: "utf8", env: { ...env, PATH: `${join(prefix, "bin")}:${dirname(process.execPath)}:${process.env.PATH}` } });
      return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    log: () => {},
  };

  it("current 2.1.12 stays installed and runnable when 2.2.0's preinstall fails", () => {
    execFileSync("npm", ["install", "-g", pack("2.1.12")], { env, stdio: "ignore" });
    const outcome = runUpdateInstall({ pkg: pack("2.2.0", "exit 1"), targetVersion: "2.2.0", viaNvm: false, nvmSh: "/nonexistent" }, runner);
    expect(outcome).toMatchObject({ ok: false, stage: "install" });
    expect(existsSync(join(prefix, "lib", "node_modules", "@songsid", "agend", "package.json"))).toBe(true);
    expect(execFileSync(join(prefix, "bin", "agend"), { encoding: "utf8" }).trim()).toBe("2.1.12");
  }, 120_000);
});

