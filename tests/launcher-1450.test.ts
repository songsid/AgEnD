/**
 * #1450 C2/C3: the launcher picks AgEnD's Node before the CLI loads — the release's own verified bundled Node first,
 * a qualifying system Node only when no runtime applies (or, with a warning, when it was skipped altogether), an
 * AGEND_NODE override only when it passes, and a clear refusal otherwise. The postinstall proves the bundled Node and
 * writes the receipt the launcher checks. Fixture packages live in temp dirs; the "bundled Node" is a stand-in
 * wrapper around this test's own Node.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

// The fixture host is linux-x64 with THIS machine's glibc: the admission key binds the real host, as the sh bin sees it.
const HOST = { platform: "linux", arch: "x64", id: "linux-x64", glibc: platform.glibcVersion() ?? "2.35", darwinRelease: null };
const NOW = { node: "22.20.0", napi: 10 };
const OLD = { node: "20.19.0", napi: 9 };
/** The launcher picks the REAL host; the spawned-runtime cases need it to be the fixture's linux-x64. */
const ON_FIXTURE_HOST = process.platform === "linux" && process.arch === "x64";

describe("runtime-platform: engines and host support", () => {
  it.each([
    ["22.14.0", true], ["22.13.9", false], ["23.6.0", true], ["23.5.0", false], ["24.0.0", true], ["26.1.0", true], ["20.19.0", false], ["21.9.0", false],
    // A prerelease satisfies no stable alternative (npm semver), and only a full x.y.z counts.
    ["24.0.0-nightly20260101abcdef", false], ["22.14.0-rc.1", false], ["26.0.0-pre", false], ["v24.1.0", true], ["22.14", false], ["24", false],
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
function fixture(opts: { pin?: string | null; runtime?: "ok" | "wrong-version" | "none"; ancestorRuntime?: boolean; sqlite?: "real" | "main-only" | "broken"; npmLayout?: boolean; rootPrefix?: string } = {}) {
  // A space in every fixture path: the bins and the launcher must quote all of it.
  const root = mkdtempSync(join(tmpdir(), opts.rootPrefix ?? "agend ln-"));
  roots.push(root);
  const pkg = opts.ancestorRuntime ? join(root, "node_modules", "@songsid", "agend")
    : opts.npmLayout ? join(root, "pre fix", "lib", "node_modules", "@songsid", "agend") : join(root, "pkg");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  cpSync(LAUNCHER, join(pkg, "launcher"), { recursive: true });
  const pin = opts.pin === undefined ? process.versions.node : opts.pin;
  // As npm publishes it (2-space JSON): the sh bins read the pin from this layout.
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "@songsid/agend", version: "2.2.0", engines: { node: "^22.14.0 || ^23.6.0 || >=24" },
    ...(pin ? { optionalDependencies: { [`@songsid/agend-node-${HOST.id}`]: pin } } : {}),
  }, null, 2) + "\n");
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
    writeFileSync(join(runtimeHome, "package.json"), JSON.stringify({ name: `@songsid/agend-node-${HOST.id}`, version }, null, 2) + "\n");
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

  it("AGEND_NODE that is a prerelease Node is refused (a nightly 24 is not >=24)", () => {
    const f = fixture({ runtime: "ok" });
    postinstall(f);
    expect(choose(f, { env: { AGEND_NODE: process.execPath }, probe: () => ({ node: "24.0.0-nightly20260101abc", napi: 10 }) })).toMatchObject({ ok: false, reason: expect.stringContaining("24.0.0-nightly") });
  });

  // Only PHYSICAL absence (no runtime directory — not even a dangling link — and no receipt file) is the skipped-runtime
  // exception; every other state refuses.
  it.each([
    ["an unparsable receipt", (f: ReturnType<typeof fixture>) => writeFileSync(join(f.pkg, ".agend-runtime.json"), "{ not json")],
    ["an empty receipt", (f: ReturnType<typeof fixture>) => writeFileSync(join(f.pkg, ".agend-runtime.json"), "")],
    ["a JSON-null receipt", (f: ReturnType<typeof fixture>) => writeFileSync(join(f.pkg, ".agend-runtime.json"), "null")],
    ["a receipt that is a directory", (f: ReturnType<typeof fixture>) => mkdirSync(join(f.pkg, ".agend-runtime.json"))],
    ["a dangling runtime-directory link", (f: ReturnType<typeof fixture>) => { mkdirSync(dirname(f.runtimeHome), { recursive: true }); symlinkSync(join(f.root, "gone"), f.runtimeHome); }],
    ["a stray admission key", (f: ReturnType<typeof fixture>) => writeFileSync(join(f.pkg, ".agend-runtime.key"), "agend-runtime-key 1\n")],
  ])("not absent, so refused (never the system Node): %s", (_n, arrange) => {
    const f = fixture({ runtime: "none" });
    arrange(f);
    expect(choose(f)).toMatchObject({ ok: false, reason: expect.stringContaining("missing, incomplete or changed") });
  });

  it("postinstall and selection agree: a stale receipt with no runtime is removed, and both take the skipped-runtime path", () => {
    const f = fixture({ runtime: "none" });
    writeFileSync(join(f.pkg, ".agend-runtime.json"), JSON.stringify({ pinnedVersion: process.versions.node, nodePath: "/old/node" }));
    const r = postinstall(f);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(f.pkg, ".agend-runtime.json"))).toBe(false);
    expect(choose(f)).toMatchObject({ ok: true, source: "system", warning: expect.stringContaining("not installed") });
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
    for (const tool of ["sh", "readlink", "dirname", "basename", "uname", "wc", "tr", "stat", "cksum", "cmp", "getconf"]) {
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

  /** Replace the verified runtime with one that leaves a marker if it is ever executed. */
  const tamper = (f: ReturnType<typeof fixture>, mark: string) => {
    writeFileSync(join(f.runtimeHome, "bin", "node"), `#!/bin/sh\necho ran > '${mark}'\nexec '${process.execPath}' "$@"\n`);
    chmodSync(join(f.runtimeHome, "bin", "node"), 0o755);
  };

  it.skipIf(!ON_FIXTURE_HOST)("a bundled Node changed after it was verified never runs: no node on PATH → the bin refuses itself", () => {
    const f = fixture({ runtime: "ok", npmLayout: true });
    expect(postinstall(f).status).toBe(0);
    const mark = join(f.root, "tampered-ran");
    tamper(f, mark);
    const r = bin(f, "agend", toolsOnly);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("changed since it was verified");
    expect(existsSync(mark)).toBe(false);
  });

  it.skipIf(!ON_FIXTURE_HOST)("…with a node on PATH, that node runs the JS launcher, which refuses; the changed file still never runs", () => {
    const f = fixture({ runtime: "ok", npmLayout: true });
    expect(postinstall(f).status).toBe(0);
    const mark = join(f.root, "tampered-ran");
    tamper(f, mark);
    const r = bin(f, "agend", `${toolsOnly}:${dirname(process.execPath)}`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("changed since it was verified");
    expect(existsSync(mark)).toBe(false);
  });

  /**
   * The sh bin's own admission, one property at a time: each case changes exactly one thing the receipt binds, and the
   * candidate — a runtime that leaves a marker whenever it runs — must never run (the JS launcher would refuse it too,
   * so "exit 1" alone would not tell whether the bin let it run).
   */
  it.skipIf(!ON_FIXTURE_HOST).each([
    ["touched (same bytes, newer mtime)", (f: ReturnType<typeof fixture>, node: string) => { const t = new Date(Date.now() + 60_000); utimesSync(node, t, t); void f; }],
    ["resized with its mtime put back", (f: ReturnType<typeof fixture>, node: string) => { const st = statSync(node); writeFileSync(node, readFileSync(node, "utf8") + "# grown\n"); utimesSync(node, st.atime, st.mtime); void f; }],
    ["a receipt naming another file", (f: ReturnType<typeof fixture>) => { const file = join(f.pkg, ".agend-runtime.json"); writeFileSync(file, readFileSync(file, "utf8").replace(/"nodePath": "[^"]*"/, `"nodePath": "${join(f.root, "elsewhere", "node")}"`)); }],
  ])("the bin does not run a candidate %s", (_n, change) => {
    const f = fixture({ runtime: "ok", npmLayout: true });
    const node = join(f.runtimeHome, "bin", "node");
    const mark = join(f.root, "candidate-ran");
    writeFileSync(node, `#!/bin/sh\necho ran >> '${mark}'\nexec '${process.execPath}' "$@"\n`);
    expect(postinstall(f).status).toBe(0);                // the proof itself runs it: that is expected
    rmSync(mark, { force: true });
    const receiptTime = statSync(join(f.pkg, ".agend-runtime.json")).mtime;
    utimesSync(node, receiptTime, new Date(receiptTime.getTime() - 5_000));   // verified before its receipt was written
    change(f, node);
    const r = bin(f, "agend", toolsOnly);
    expect(r.status).toBe(1);
    expect(existsSync(mark)).toBe(false);
  });

  /**
   * THE RECEIPT CONTRACT, both sides (#1460 r2): for each state, the sh bin admits the candidate (it RUNS — its marker
   * appears, with no node on PATH) exactly when the JS selection does, and both give the expected answer.
   */
  /** toolsOnly, with some tools replaced by liars: each prints the given value — or, for null, runs the real tool — then exits 17. */
  const liars = (lies: Record<string, string | null>) => {
    const dir = mkdtempSync(join(tmpdir(), "agend liars-"));
    roots.push(dir);
    for (const name of readdirSync(toolsOnly)) symlinkSync(realpathSync(join(toolsOnly, name)), join(dir, name));
    for (const [name, out] of Object.entries(lies)) {
      const real = realpathSync(join(toolsOnly, name));
      rmSync(join(dir, name));
      writeFileSync(join(dir, name), out === null ? `#!/bin/sh\n'${real}' "$@"\nexit 17\n` : `#!/bin/sh\nprintf '%s\\n' '${out}'\nexit 17\n`);
      chmodSync(join(dir, name), 0o755);
    }
    return dir;
  };
  describe("a measurement that does not complete is no measurement (#1460 r4)", () => {
    const keyLine = (f: ReturnType<typeof fixture>, name: string) => readFileSync(join(f.pkg, ".agend-runtime.key"), "utf8").match(new RegExp(`^${name} (.*)$`, "m"))![1]!;
    it.skipIf(!ON_FIXTURE_HOST).each([
      ["wc prints the receipted size, then fails (the candidate was resized, mtime restored)", "wc", "size", (f: ReturnType<typeof fixture>, node: string) => { const st = statSync(node); writeFileSync(node, readFileSync(node, "utf8") + "# grown\n"); utimesSync(node, st.atime, st.mtime); void f; }],
      ["stat prints the receipted mtime, then fails (the candidate was touched)", "stat", "mtime", (_f: ReturnType<typeof fixture>, node: string) => { const t = new Date(Date.now() + 60_000); utimesSync(node, t, t); }],
      ["cksum prints the true sums, then fails", "cksum", null, () => {}],
      ["cksum fails only on the receipt (after printing its true sum)", "cksum", "receipt-only", () => {}],
      ["uname prints the host, then fails", "uname", null, () => {}],
    ] as const)("%s: the candidate never runs", (_n, tool, line, change) => {
      const f = fixture({ runtime: "ok", npmLayout: true });
      const node = join(f.runtimeHome, "bin", "node");
      const mark = join(f.root, "candidate-ran");
      writeFileSync(node, `#!/bin/sh\necho ran >> '${mark}'\nexec '${process.execPath}' "$@"\n`);
      expect(postinstall(f).status).toBe(0);
      rmSync(mark, { force: true });
      const lie = line === null || line === "receipt-only" ? null : keyLine(f, line);
      if (line === "receipt-only") {
        const dir = liars({});
        const real = realpathSync(join(toolsOnly, "cksum"));
        const which = (t: string) => spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
        rmSync(join(dir, "cksum"));
        writeFileSync(join(dir, "cksum"), `#!/bin/sh\nt=$('${which("mktemp")}')\n'${which("cat")}' > "$t"\n'${real}' < "$t"\nif '${which("grep")}' -q '"receipt": 2' "$t"; then rc=17; else rc=0; fi\n'${which("rm")}' -f "$t"\nexit $rc\n`);
        chmodSync(join(dir, "cksum"), 0o755);
        bin(f, "agend", dir);
        expect(existsSync(mark)).toBe(false);
        return;
      }
      (change as (f: ReturnType<typeof fixture>, node: string) => void)(f, node);
      bin(f, "agend", liars({ [tool]: lie }));
      expect(existsSync(mark)).toBe(false);
    });
  });

  // #1450 leader review: an OS update (a macOS point release, a distro's newer glibc) must never lock AgEnD out of the
  // Node it verified. The key binds os/cpu only; whether the host can still run it is runtimeSupport()'s minimums.
  it("the admission key does not depend on the host's glibc or Darwin version", () => {
    const f = fixture({ runtime: "ok" });
    writeFileSync(join(f.pkg, ".agend-runtime.json"), "{}\n");
    const candidate = select.runtimeCandidate(f.pkg, { name: `@songsid/agend-node-${HOST.id}`, version: process.versions.node });
    const key = (host: Record<string, unknown>) => select.runtimeKey(f.pkg, candidate, host) as Buffer;
    expect(key({ ...HOST, glibc: "2.99" }).equals(key({ ...HOST, glibc: "2.28" }))).toBe(true);
    const mac = { platform: "darwin", arch: "arm64", id: "darwin-arm64", glibc: null };
    expect(key({ ...mac, darwinRelease: "24.3.0" }).equals(key({ ...mac, darwinRelease: "24.4.0" }))).toBe(true);
    expect(key({ ...HOST, glibc: "2.35" }).toString()).not.toMatch(/glibc|2\.35|host /);
  });

  it.skipIf(!ON_FIXTURE_HOST)("after an OS update (another glibc version; getconf saying so, or failing) AgEnD still starts on its bundled Node", () => {
    const f = fixture({ runtime: "ok", npmLayout: true });
    expect(postinstall(f).status).toBe(0);
    expect(choose(f, { host: { ...HOST, glibc: "2.99" } })).toMatchObject({ ok: true, source: "runtime" });
    for (const lie of ["glibc 2.99", null]) {
      const r = bin(f, "agend", liars({ getconf: lie }));
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ fakeRuntime: true });
    }
  });

  it.skipIf(!ON_FIXTURE_HOST)("the key is compared as bytes: an install path with U+FFFD whose key bytes became FF is refused by both", () => {
    const f = fixture({ runtime: "ok", npmLayout: true, rootPrefix: "agend \uFFFD ln-" });
    const node = join(f.runtimeHome, "bin", "node");
    const mark = join(f.root, "candidate-ran");
    writeFileSync(node, `#!/bin/sh\necho ran >> '${mark}'\nexec '${process.execPath}' "$@"\n`);
    expect(postinstall(f).status).toBe(0);
    rmSync(mark, { force: true });
    const keyFile = join(f.pkg, ".agend-runtime.key");
    const bytes = readFileSync(keyFile);
    const fffd = Buffer.from("\uFFFD", "utf8");
    const at = bytes.indexOf(fffd);
    expect(at).toBeGreaterThan(0);
    writeFileSync(keyFile, Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + fffd.length)]));
    expect(readFileSync(keyFile, "utf8")).toBe(bytes.toString("utf8"));   // the same TEXT once decoded
    const js = choose(f, { host: HOST });
    expect(js.ok === true && js.source === "runtime").toBe(false);
    bin(f, "agend", toolsOnly);
    expect(existsSync(mark)).toBe(false);
  });

  describe("the sh bin and the JS selection agree, state by state", () => {
    const receiptFile = (f: ReturnType<typeof fixture>) => join(f.pkg, ".agend-runtime.json");
    const edit = (file: string, fn: (text: string) => string) => writeFileSync(file, fn(readFileSync(file, "utf8")));
    const keepTimes = (file: string, fn: () => void) => { const st = statSync(file); fn(); utimesSync(file, st.atime, st.mtime); };
    it.skipIf(!ON_FIXTURE_HOST).each([
      ["control: as verified", () => {}, true],
      ["same size, changed bytes, mtime moved back a minute", (f: ReturnType<typeof fixture>, node: string) => {
        const st = statSync(node);
        writeFileSync(node, readFileSync(node, "utf8").replace("ran", "RAN"));
        utimesSync(node, st.atime, new Date(st.mtime.getTime() - 60_000));
      }, false],
      ["same size, changed bytes, mtime restored to the second (both admit: the contract binds size+mtime, not bytes)", (f: ReturnType<typeof fixture>, node: string) => {
        keepTimes(node, () => writeFileSync(node, readFileSync(node, "utf8").replace("ran", "RAN")));
      }, true],
      ["a malformed receipt whose path/size lines are still readable", (f: ReturnType<typeof fixture>) => edit(receiptFile(f), t => t.replace(/\n}\n$/, ",\n}\n"))],
      ["a receipt that is valid JSON in another layout (minified)", (f: ReturnType<typeof fixture>) => edit(receiptFile(f), t => JSON.stringify(JSON.parse(t)) + "\n")],
      ["a receipt with a leading-zero size", (f: ReturnType<typeof fixture>) => edit(receiptFile(f), t => t.replace(/"size": (\d+)/, '"size": 0$1'))],
      ["a receipt with a trailing blank line (valid JSON, not the contract's text)", (f: ReturnType<typeof fixture>) => edit(receiptFile(f), t => t + "\n")],
      ["a receipt with a space after its closing brace", (f: ReturnType<typeof fixture>) => edit(receiptFile(f), t => t.replace(/}\n$/, "} \n"))],
      ["a receipt for another pin", (f: ReturnType<typeof fixture>) => edit(receiptFile(f), t => t.replace(/"pinnedVersion": "[^"]*"/, '"pinnedVersion": "22.0.0"'))],
      ["a runtime package of another version", (f: ReturnType<typeof fixture>) => edit(join(f.runtimeHome, "package.json"), t => t.replace(/"version": "[^"]*"/, '"version": "22.0.0"'))],
      ["a receipt of the old shape (mtimeMs, no receipt key)", (f: ReturnType<typeof fixture>) => edit(receiptFile(f), t => { const r = JSON.parse(t); delete r.receipt; r.mtimeMs = r.mtime * 1000; delete r.mtime; return JSON.stringify(r, null, 2) + "\n"; })],
      // #1460 r2's counterexamples: each changes a bound file, so its cksum — and the admission key — differs.
      ["a literal TAB in receipt.platform", (f: ReturnType<typeof fixture>) => edit(receiptFile(f), t => t.replace(/"platform": "([^"]*)"/, '"platform": "$1\t"'))],
      ["napi beyond a safe integer", (f: ReturnType<typeof fixture>) => edit(receiptFile(f), t => t.replace(/"napi": \d+/, '"napi": 9007199254740993'))],
      ["the root manifest's name changed", (f: ReturnType<typeof fixture>) => edit(join(f.pkg, "package.json"), t => t.replace('"@songsid/agend"', '"@songsid/agenx"'))],
      ["the runtime manifest's name changed", (f: ReturnType<typeof fixture>) => edit(join(f.runtimeHome, "package.json"), t => t.replace(/"name": "[^"]*"/, '"name": "@songsid/agend-node-other"'))],
      ["a malformed pin (22..23.3) in both manifests and the receipt", (f: ReturnType<typeof fixture>) => {
        for (const file of [join(f.pkg, "package.json"), join(f.runtimeHome, "package.json"), receiptFile(f)]) edit(file, t => t.split(process.versions.node).join("22..23.3"));
      }],
      ["trailing text after the root manifest", (f: ReturnType<typeof fixture>) => edit(join(f.pkg, "package.json"), t => t + "garbage\n")],
      ["trailing text after the runtime manifest", (f: ReturnType<typeof fixture>) => edit(join(f.runtimeHome, "package.json"), t => t + "garbage\n")],
      // …and with its mtime put back: content, not timestamps, binds the manifests and the receipt.
      ["the root manifest edited to the same length, mtime restored", (f: ReturnType<typeof fixture>) => keepTimes(join(f.pkg, "package.json"), () => edit(join(f.pkg, "package.json"), t => t.replace('"2.2.0"', '"2.2.9"')))],
      ["the receipt edited to the same length, mtime restored", (f: ReturnType<typeof fixture>) => keepTimes(receiptFile(f), () => edit(receiptFile(f), t => t.replace(/"verifiedAt": "(\d)/, '"verifiedAt": "9')))],
      ["the admission key edited", (f: ReturnType<typeof fixture>) => edit(join(f.pkg, ".agend-runtime.key"), t => t.replace(/^size (\d+)$/m, (_m, n) => `size ${Number(n) + 1}`))],
      ["the admission key removed (receipt still valid)", (f: ReturnType<typeof fixture>) => rmSync(join(f.pkg, ".agend-runtime.key"))],
    ].map(([n, fn, ok = false]) => [n, fn, ok] as const))("%s → admitted: %s", (_n, change, expected) => {
      const f = fixture({ runtime: "ok", npmLayout: true });
      const node = join(f.runtimeHome, "bin", "node");
      const mark = join(f.root, "candidate-ran");
      writeFileSync(node, `#!/bin/sh\necho ran >> '${mark}'\nexec '${process.execPath}' "$@"\n`);
      expect(postinstall(f).status).toBe(0);
      rmSync(mark, { force: true });
      (change as (f: ReturnType<typeof fixture>, node: string) => void)(f, node);
      const js = choose(f, { host: HOST });
      const jsAdmits = js.ok === true && js.source === "runtime";
      bin(f, "agend", toolsOnly);
      const shAdmits = existsSync(mark);
      expect({ jsAdmits, shAdmits }).toEqual({ jsAdmits: expected, shAdmits: expected });
    });
  });

  it("a valid AGEND_NODE starts AgEnD with no bundled Node and no node on PATH", () => {
    const f = fixture({ runtime: "none", npmLayout: true });
    const r = bin(f, "agend", toolsOnly, { AGEND_NODE: process.execPath });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ execPath: process.execPath, fakeRuntime: false, argv1: join(f.pkg, "dist", "cli.js") });
  });

  it.skipIf(!ON_FIXTURE_HOST)("a valid AGEND_NODE wins over a changed bundled Node, which never runs", () => {
    const f = fixture({ runtime: "ok", npmLayout: true });
    expect(postinstall(f).status).toBe(0);
    const mark = join(f.root, "tampered-ran");
    tamper(f, mark);
    const r = bin(f, "agend", toolsOnly, { AGEND_NODE: process.execPath });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ execPath: process.execPath, fakeRuntime: false });
    expect(existsSync(mark)).toBe(false);
  });

  it.each([["relative", "node", "absolute path"], ["not executable", "/etc/hostname", "not an executable file"]])("AGEND_NODE %s: the bin refuses, nothing else runs", (_n, value, why) => {
    const r = bin(fixture({ runtime: "none", npmLayout: true }), "agend", `${toolsOnly}:${dirname(process.execPath)}`, { AGEND_NODE: value });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(why);
    expect(r.stdout).toBe("");
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

