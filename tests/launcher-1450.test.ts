/**
 * #1450 C2/C3: the launcher picks AgEnD's Node before the CLI loads — the release's own verified bundled Node first,
 * a qualifying system Node only when no runtime applies (or, with a warning, when it was skipped altogether), an
 * AGEND_NODE override only when it passes, and a clear refusal otherwise. The postinstall proves the bundled Node and
 * writes the receipt the launcher checks. Fixture packages live in temp dirs; the "bundled Node" is a stand-in
 * wrapper around this test's own Node.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const platform = require("../launcher/runtime-platform.cjs");
const select = require("../launcher/runtime-select.cjs");
const LAUNCHER = join(process.cwd(), "launcher");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const HOST = { platform: "linux", arch: "x64", id: "linux-x64", glibc: "2.35", darwinRelease: null };
const NOW = { node: "22.20.0", napi: 10 };
const OLD = { node: "20.19.0", napi: 9 };
/** The launcher picks the REAL host; the spawned-runtime cases need it to be the fixture's linux-x64. */
const ON_FIXTURE_HOST = process.platform === "linux" && process.arch === "x64";

describe("runtime-platform: engines and host support", () => {
  it.each([
    ["22.14.0", true], ["22.13.9", false], ["23.6.0", true], ["23.5.0", false], ["24.0.0", true], ["26.1.0", true], ["20.19.0", false], ["21.9.0", false],
  ])("satisfiesEngines(%s) = %s", (v, ok) => {
    expect(platform.satisfiesEngines(v, "^22.14.0 || ^23.6.0 || >=24")).toBe(ok);
  });

  it.each([
    [{ ...HOST }, true],
    [{ ...HOST, glibc: "2.28" }, true],
    [{ ...HOST, glibc: "2.27" }, false],
    [{ ...HOST, glibc: null }, false],                                        // musl
    [{ ...HOST, arch: "arm", id: "linux-arm" }, false],
    [{ platform: "darwin", arch: "arm64", id: "darwin-arm64", glibc: null, darwinRelease: "23.6.0" }, true],
    [{ platform: "darwin", arch: "x64", id: "darwin-x64", glibc: null, darwinRelease: "19.6.0" }, false],
    [{ platform: "win32", arch: "x64", id: "win32-x64", glibc: null, darwinRelease: null }, false],
  ])("runtimeSupport(%j).supported = %s", (host, ok) => {
    expect(platform.runtimeSupport(host).supported).toBe(ok);
  });

  it("the launcher files a host's old Node runs use no syntax newer than it parses (no ?. ?? or import() there)", () => {
    for (const file of ["runtime-platform.cjs", "runtime-select.cjs", "launch.cjs", "agend.cjs", "agend-agent.cjs", "postinstall.cjs", "install-admission.cjs"]) {
      const source = readFileSync(join(LAUNCHER, file), "utf8").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
      expect(source, file).not.toMatch(/\?\.|\?\?|\bimport\s*\(|^\s*(?:const|let)\s/m);
    }
    expect(readFileSync(join(LAUNCHER, "run-in-process.cjs"), "utf8")).toMatch(/import\(/);   // loaded only by a qualifying Node
  });
});

/** A fixture @songsid/agend package with this repo's launcher/, a stand-in CLI, and optionally a pinned runtime. */
function fixture(opts: { pin?: string | null; runtime?: "ok" | "wrong-version" | "none"; ancestorRuntime?: boolean; sqlite?: "real" | "main-only" | "broken"; npmLayout?: boolean } = {}) {
  // A space in every fixture path: the bins and the launcher must quote all of it.
  const root = mkdtempSync(join(tmpdir(), "agend ln-"));
  roots.push(root);
  const pkg = opts.ancestorRuntime ? join(root, "node_modules", "@songsid", "agend")
    : opts.npmLayout ? join(root, "pre fix", "lib", "node_modules", "@songsid", "agend") : join(root, "pkg");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  cpSync(LAUNCHER, join(pkg, "launcher"), { recursive: true });
  const pin = opts.pin === undefined ? process.versions.node : opts.pin;
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "@songsid/agend", version: "2.2.0", engines: { node: "^22.14.0 || ^23.6.0 || >=24" },
    ...(pin ? { optionalDependencies: { [`@songsid/agend-node-${HOST.id}`]: pin } } : {}),
  }));
  // The CLI reports which Node ran it, its argv[1], and whether the launcher spawned it; exits with $CLI_EXIT. With
  // $CLI_WAIT it stays up, its SIGTERM handler in place BEFORE it reports (the test signals as soon as it reads).
  for (const cli of ["cli.js", "agent-cli.js"]) writeFileSync(join(pkg, "dist", cli), [
    "if (process.env.CLI_WAIT) process.on('SIGTERM', () => { require('fs').writeFileSync(process.env.CLI_WAIT, 'SIGTERM'); process.exit(143); });",
    "process.stdout.write(JSON.stringify({ execPath: process.execPath, argv1: process.argv[1], args: process.argv.slice(2), spawned: process.env.AGEND_NODE_SELECTED === '1', fakeRuntime: !!process.env.FAKE_RUNTIME }));",
    "if (process.env.CLI_WAIT) setInterval(() => {}, 1000);",
    "else process.exit(Number(process.env.CLI_EXIT || 0));",
  ].join("\n"));
  if (opts.npmLayout) {
    // npm's global bin: a RELATIVE symlink into the package — and here a second, absolute link to that one.
    mkdirSync(join(root, "pre fix", "bin"), { recursive: true });
    mkdirSync(join(root, "other bin"));
    for (const bin of ["agend", "agend-agent"]) {
      symlinkSync(join("..", "lib", "node_modules", "@songsid", "agend", "launcher", bin), join(root, "pre fix", "bin", bin));
      symlinkSync(join(root, "pre fix", "bin", bin), join(root, "other bin", bin));
    }
  }
  const runtimeHome = opts.ancestorRuntime ? join(root, "node_modules", "@songsid", `agend-node-${HOST.id}`) : join(pkg, "node_modules", "@songsid", `agend-node-${HOST.id}`);
  if ((opts.runtime ?? "none") !== "none") {
    mkdirSync(join(runtimeHome, "bin"), { recursive: true });
    const version = opts.runtime === "wrong-version" ? "1.0.0" : pin!;
    writeFileSync(join(runtimeHome, "package.json"), JSON.stringify({ name: `@songsid/agend-node-${HOST.id}`, version }));
    // A regular-file stand-in for the bundled node: this test's Node, marked so the CLI can tell.
    writeFileSync(join(runtimeHome, "bin", "node"), `#!/bin/sh\nFAKE_RUNTIME=1 exec '${process.execPath}' "$@"\n`);
    chmodSync(join(runtimeHome, "bin", "node"), 0o755);
  }
  // better-sqlite3 for the postinstall proof, from this repo.
  mkdirSync(join(pkg, "node_modules"), { recursive: true });
  if (opts.sqlite && opts.sqlite !== "real") {
    // A stand-in better-sqlite3 that cannot open a database in a worker (or anywhere): the proof must notice.
    mkdirSync(join(pkg, "node_modules", "better-sqlite3"), { recursive: true });
    writeFileSync(join(pkg, "node_modules", "better-sqlite3", "package.json"), JSON.stringify({ name: "better-sqlite3", main: "index.js" }));
    writeFileSync(join(pkg, "node_modules", "better-sqlite3", "index.js"), [
      `const broken = ${opts.sqlite === "broken"} || !require("node:worker_threads").isMainThread;`,
      "module.exports = class { constructor() { if (broken) throw new Error('cannot load the native addon'); } prepare() { return { get: () => ({ one: 1 }) }; } close() {} };",
    ].join("\n"));
  }
  if (!existsSync(join(pkg, "node_modules", "better-sqlite3"))) symlinkSync(join(process.cwd(), "node_modules", "better-sqlite3"), join(pkg, "node_modules", "better-sqlite3"));
  if (!existsSync(join(pkg, "node_modules", "bindings"))) { try { symlinkSync(join(process.cwd(), "node_modules", "bindings"), join(pkg, "node_modules", "bindings")); } catch { /* not needed by v13 */ } }
  if (!existsSync(join(pkg, "node_modules", "file-uri-to-path"))) { try { symlinkSync(join(process.cwd(), "node_modules", "file-uri-to-path"), join(pkg, "node_modules", "file-uri-to-path")); } catch { /* optional */ } }
  return { root, pkg, runtimeHome, launcherDir: join(pkg, "launcher") };
}

/** Run the postinstall in a child, with the host and running Node injected. */
function postinstall(f: ReturnType<typeof fixture>, versions = NOW) {
  const driver = `process.exit(require(${JSON.stringify(join(f.launcherDir, "postinstall.cjs"))}).main({ launcherDir: ${JSON.stringify(f.launcherDir)}, host: ${JSON.stringify(HOST)}, versions: ${JSON.stringify(versions)} }) || 0)`;
  return spawnSync(process.execPath, ["-e", driver], { encoding: "utf8", timeout: 60_000 });
}
const choose = (f: ReturnType<typeof fixture>, deps: Record<string, unknown> = {}) =>
  select.selectRuntime(f.launcherDir, { env: {}, host: HOST, versions: NOW, ...deps });

describe("postinstall: prove the bundled Node, write the receipt", () => {
  it("a present runtime is proven (version, N-API, DB in main thread + worker) and its receipt written", () => {
    const f = fixture({ runtime: "ok" });
    const r = postinstall(f);
    expect(r.status, r.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(join(f.pkg, ".agend-runtime.json"), "utf8"));
    expect(receipt).toMatchObject({ pinnedVersion: process.versions.node, platform: "linux", arch: "x64", libc: "glibc" });
    expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.stdout).toContain("a database opened in the main thread and a worker");
  });

  it("a runtime that reports another version is refused (exit 1, npm rolls back) and no receipt is written", () => {
    const f = fixture({ runtime: "ok", pin: "22.0.1" });
    writeFileSync(join(f.runtimeHome, "package.json"), JSON.stringify({ name: `@songsid/agend-node-${HOST.id}`, version: "22.0.1" }));
    const r = postinstall(f);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("did not pass its check");
    expect(existsSync(join(f.pkg, ".agend-runtime.json"))).toBe(false);
  });

  it.each([["main-only", "a worker"], ["broken", "the main thread"]] as const)("better-sqlite3 that fails (%s) in %s is refused, no receipt", (sqlite, _where) => {
    const f = fixture({ runtime: "ok", sqlite });
    const r = postinstall(f);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("did not pass its check");
    expect(existsSync(join(f.pkg, ".agend-runtime.json"))).toBe(false);
  });

  it("a runtime package of the wrong version is refused", () => {
    expect(postinstall(fixture({ runtime: "wrong-version" })).status).toBe(1);
  });

  it("runtime skipped (optional omitted): a qualifying Node proceeds with a warning; an old Node is refused", () => {
    const f = fixture({ runtime: "none" });
    const ok = postinstall(f, NOW);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("was not installed");
    const old = postinstall(f, OLD);
    expect(old.status).toBe(1);
    expect(old.stderr).toContain("was not installed, and this Node 20.19.0 is older");
  });

  it("no runtime pinned (this release bundles none yet): only the running Node decides", () => {
    const f = fixture({ pin: null });
    expect(postinstall(f, NOW).status).toBe(0);
    expect(postinstall(f, OLD).status).toBe(1);
  });
});

describe("selectRuntime: the order and the refusals", () => {
  it("the verified bundled Node wins, even over a qualifying system Node", () => {
    const f = fixture({ runtime: "ok" });
    expect(postinstall(f).status).toBe(0);
    expect(choose(f)).toMatchObject({ ok: true, source: "runtime", node: join(f.runtimeHome, "bin", "node") });
  });

  it("a changed runtime binary (size/mtime differ from the receipt) is refused — never a silent fallback", () => {
    const f = fixture({ runtime: "ok" });
    postinstall(f);
    writeFileSync(join(f.runtimeHome, "bin", "node"), "#!/bin/sh\necho tampered\n");
    expect(choose(f)).toMatchObject({ ok: false, reason: expect.stringContaining("changed since it was verified") });
  });

  it("a receipt naming another binary is refused, and is never what runs", () => {
    const f = fixture({ runtime: "ok" });
    expect(postinstall(f).status).toBe(0);
    const file = join(f.pkg, ".agend-runtime.json");
    const receipt = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...receipt, nodePath: process.execPath }));
    expect(choose(f)).toMatchObject({ ok: false, reason: expect.stringContaining("changed since it was verified") });
  });

  it("a receipt from another pinned version (scripts skipped on an upgrade) is refused", () => {
    const f = fixture({ runtime: "ok" });
    expect(postinstall(f).status).toBe(0);
    const file = join(f.pkg, ".agend-runtime.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), pinnedVersion: "22.0.0" }));
    expect(choose(f)).toMatchObject({ ok: false });
  });

  it("a runtime present but never verified (no receipt) is refused", () => {
    expect(choose(fixture({ runtime: "ok" }))).toMatchObject({ ok: false });
  });

  it("a receipt whose binary is gone is refused", () => {
    const f = fixture({ runtime: "ok" });
    postinstall(f);
    rmSync(f.runtimeHome, { recursive: true, force: true });
    expect(choose(f)).toMatchObject({ ok: false });
  });

  it("runtime skipped altogether (no dir, no receipt): a qualifying system Node, with a warning; an old one refuses", () => {
    const f = fixture({ runtime: "none" });
    expect(choose(f)).toMatchObject({ ok: true, source: "system", warning: expect.stringContaining("not installed") });
    expect(choose(f, { versions: OLD })).toMatchObject({ ok: false });
  });

  it("a runtime package in an ANCESTOR node_modules does not count as this release's runtime", () => {
    const f = fixture({ runtime: "ok", ancestorRuntime: true });
    expect(existsSync(join(f.pkg, "node_modules", "@songsid"))).toBe(false);
    expect(choose(f)).toMatchObject({ ok: true, source: "system" });
  });

  it("an unsupported host (musl) with a pin: a qualifying system Node; an old one refuses with the reason", () => {
    const f = fixture({ runtime: "none" });
    const musl = { ...HOST, glibc: null };
    expect(choose(f, { host: musl })).toMatchObject({ ok: true, source: "system" });
    expect(choose(f, { host: musl, versions: OLD })).toMatchObject({ ok: false, reason: expect.stringContaining("not glibc") });
  });

  it.each([
    ["relative", { AGEND_NODE: "node" }, /absolute path/],
    ["not executable", { AGEND_NODE: "/etc/hostname" }, /not an executable/],
    ["too old", { AGEND_NODE: process.execPath }, /AgEnD needs/],
  ])("AGEND_NODE %s → a clear refusal, no fallback", (_name, env, reason) => {
    const f = fixture({ runtime: "ok" });
    postinstall(f);
    const r = choose(f, { env, probe: () => ({ node: "20.19.0", napi: 9 }) });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });

  it("a valid AGEND_NODE overrides the bundled Node", () => {
    const f = fixture({ runtime: "ok" });
    postinstall(f);
    expect(choose(f, { env: { AGEND_NODE: process.execPath }, probe: () => ({ node: "24.1.0", napi: 10 }) })).toMatchObject({ ok: true, source: "override" });
  });
});

describe("the launcher, end to end", () => {
  const run = (f: ReturnType<typeof fixture>, args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(f.launcherDir, "agend.cjs"), ...args], { encoding: "utf8", timeout: 30_000, env: { ...process.env, ...env } });

  it("same Node selected → runs in process, with process.argv[1] = the inner entry", () => {
    const f = fixture({ pin: null });
    const r = run(f, ["status", "--x"]);
    const seen = JSON.parse(r.stdout);
    expect(seen).toMatchObject({ execPath: process.execPath, argv1: join(f.pkg, "dist", "cli.js"), args: ["status", "--x"], spawned: false });
  });

  it.skipIf(!ON_FIXTURE_HOST)("the bundled Node selected → the CLI runs on it (spawned), arguments and exit code carried", () => {
    const f = fixture({ runtime: "ok" });
    expect(postinstall(f).status).toBe(0);
    const r = run(f, ["--version"], { CLI_EXIT: "7" });
    expect(r.status).toBe(7);
    expect(JSON.parse(r.stdout)).toMatchObject({ fakeRuntime: true, spawned: true, args: ["--version"], argv1: join(f.pkg, "dist", "cli.js") });
  });

  it("--agend-select-json reports the choice and starts nothing", () => {
    const f = fixture({ pin: null });
    const r = run(f, ["--agend-select-json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ source: "system", entry: join(f.pkg, "dist", "cli.js") });
  });

  it.skipIf(!ON_FIXTURE_HOST)("a refusal prints the reason and the repair, exit 1", () => {
    const f = fixture({ runtime: "ok" });                                     // present, never verified
    const r = run(f, ["--version"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AgEnD cannot start: .*\n\s+To repair: npm install -g @songsid\/agend@2\.2\.0/);
  });

  it.skipIf(!ON_FIXTURE_HOST)("SIGTERM to the launcher reaches the spawned CLI, and the CLI's exit is the launcher's", async () => {
    const f = fixture({ runtime: "ok" });
    expect(postinstall(f).status).toBe(0);
    const mark = join(f.root, "cli-got-signal");
    // Not `fleet start`: a long-lived stand-in must not look like a fleet to AgEnD's fleet detection (or pgrep). Its
    // own process group, killed whatever happens, so a failure never leaves the CLI running.
    const child = spawn(process.execPath, [join(f.launcherDir, "agend.cjs"), "wait-for-signal"], { env: { ...process.env, CLI_WAIT: mark }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    try {
      const seen = JSON.parse(String(await new Promise(r => child.stdout.once("data", r))));
      expect(seen).toMatchObject({ fakeRuntime: true, spawned: true });             // the CLI is a separate process
      child.kill("SIGTERM");
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(r => child.once("exit", (c, s) => r([c, s])));
      expect(readFileSync(mark, "utf8")).toBe("SIGTERM");                           // forwarded, not just the launcher dying
      expect([code, signal]).toEqual([143, null]);                                  // the launcher waited for the CLI's own exit
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* the group is gone */ }
    }
  });
});

describe("the sh bins: AgEnD starts with no Node on PATH", () => {
  /** A PATH with only the tools the bin script itself uses — no node anywhere on it. */
  const toolsOnly = (() => {
    const dir = mkdtempSync(join(tmpdir(), "agend tools-"));
    roots.push(dir);
    for (const tool of ["sh", "readlink", "dirname", "basename", "uname"]) {
      symlinkSync(spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim(), join(dir, tool));
    }
    return dir;
  })();
  const bin = (f: ReturnType<typeof fixture>, name: string, path: string, env: Record<string, string> = {}) =>
    spawnSync(join(f.root, "other bin", name), ["status", "--x"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: path, ...env } });

  it("both bins are the same POSIX sh script, executable, and what package.json links", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(manifest.bin).toEqual({ agend: "./launcher/agend", "agend-agent": "./launcher/agend-agent" });
    const text = readFileSync(join(LAUNCHER, "agend"), "utf8");
    expect(readFileSync(join(LAUNCHER, "agend-agent"), "utf8")).toBe(text);
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text.replace(/^\s*#.*$/gm, "")).not.toMatch(/readlink -f|\[\[|\bfunction\b|\$\{[A-Za-z_]+\[/);       // POSIX only, no GNU readlink -f
    for (const name of ["agend", "agend-agent"]) expect(statSync(join(LAUNCHER, name)).mode & 0o111).toBe(0o111);
    expect(spawnSync("sh", ["-n", join(LAUNCHER, "agend")]).status).toBe(0);
  });

  it.skipIf(!ON_FIXTURE_HOST)("through a relative bin link and a link to it, in paths with spaces, no node on PATH: the bundled Node runs the CLI", () => {
    const f = fixture({ runtime: "ok", npmLayout: true });
    expect(postinstall(f).status).toBe(0);
    for (const [name, entry] of [["agend", "cli.js"], ["agend-agent", "agent-cli.js"]]) {
      const r = bin(f, name, toolsOnly);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ fakeRuntime: true, args: ["status", "--x"], argv1: join(f.pkg, "dist", entry) });
    }
  });

  it("no bundled Node installed: falls back to the node on PATH (which the JS launcher then qualifies)", () => {
    const f = fixture({ runtime: "none", npmLayout: true });
    const r = bin(f, "agend", `${toolsOnly}:${dirname(process.execPath)}`);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ execPath: process.execPath, fakeRuntime: false, argv1: join(f.pkg, "dist", "cli.js") });
  });

  it("no bundled Node and no node on PATH: a clear refusal, exit 127", () => {
    const r = bin(fixture({ runtime: "none", npmLayout: true }), "agend", toolsOnly);
    expect(r.status).toBe(127);
    expect(r.stderr).toContain("its bundled Node is not installed and there is no node on PATH");
    expect(r.stdout).toBe("");
  });

  it.skipIf(!ON_FIXTURE_HOST)("a bundled Node changed after it was verified: the bin still hands it to the JS launcher, which refuses", () => {
    const f = fixture({ runtime: "ok", npmLayout: true });
    expect(postinstall(f).status).toBe(0);
    writeFileSync(join(f.runtimeHome, "bin", "node"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n# changed\n`);
    const r = bin(f, "agend", toolsOnly);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("changed since it was verified");
  });
});

describe("preinstall guard with a pinned runtime", () => {
  const guard = (f: ReturnType<typeof fixture>, node: string) => {
    mkdirSync(join(f.pkg, "scripts"), { recursive: true });
    cpSync(join(process.cwd(), "scripts", "preinstall-guard.cjs"), join(f.pkg, "scripts", "preinstall-guard.cjs"));
    const preload = join(f.root, "preload.cjs");
    writeFileSync(preload, `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(node)}, configurable: true }); Object.defineProperty(process.versions, "napi", { value: "9", configurable: true });`);
    return spawnSync(process.execPath, ["--require", preload, join(f.pkg, "scripts", "preinstall-guard.cjs")], { encoding: "utf8" });
  };

  it.skipIf(!platform.runtimeSupport(platform.hostPlatform()).supported)("an old Node proceeds when this release pins a runtime for a supported host (postinstall proves it)", () => {
    const host = platform.hostPlatform();
    const f = fixture({ runtime: "none" });
    const manifest = JSON.parse(readFileSync(join(f.pkg, "package.json"), "utf8"));
    manifest.optionalDependencies = { [`@songsid/agend-node-${host.id}`]: "22.23.3" };
    writeFileSync(join(f.pkg, "package.json"), JSON.stringify(manifest));
    expect(guard(f, "20.19.0").status).toBe(0);
  });

  it("an old Node is still refused when nothing is pinned", () => {
    expect(guard(fixture({ pin: null }), "20.19.0").status).toBe(1);
  });
});

