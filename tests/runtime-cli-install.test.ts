import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_INSTALL_TIMEOUT_MS, CliInstallError, INSTALLABLE_CLIS, installEnvironment, installManagedCli, managedCliExecutable, managedInstaller, nativeInstallSupported, parseSubject, signerMatches, windowsSignerOf, type InstallDeps } from "../src/runtime-cli-install.js";

let home: string, node: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agend-cli-install-")); node = join(home, "nodejs", "node.exe"); mkdirSync(join(home, "nodejs", "node_modules", "npm", "bin"), { recursive: true }); writeFileSync(join(home, "nodejs", "node_modules", "npm", "bin", "npm-cli.js"), ""); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A fake npm: `install` writes the lock file (with integrity as given) and the native file; `audit` answers with the given exit code. */
function fakeRun(id: "claude-code" | "codex", options: { integrity?: Record<string, string>; auditCode?: number | null; installCode?: number | null } = {}): { run: NonNullable<InstallDeps["run"]>; calls: string[][] } {
  const cli = INSTALLABLE_CLIS[id], calls: string[][] = [];
  return { calls, run: async (file, args, { cwd }) => {
    calls.push([file, ...args]);
    if (args[1] === "install") {
      if (options.installCode !== undefined && options.installCode !== 0) return { code: options.installCode, stdout: "" };
      const packages = Object.fromEntries(Object.entries(options.integrity ?? cli.integrity).map(([path, integrity]) => [path, { integrity, version: cli.version }]));
      writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ packages }));
      const file2 = join(cwd, cli.native.path); mkdirSync(join(file2, ".."), { recursive: true }); writeFileSync(file2, "MZ");
      return { code: 0, stdout: "" };
    }
    return { code: options.auditCode === undefined ? 0 : options.auditCode, stdout: "" };
  } };
}
const signed = async () => ({ status: "Valid", subject: 'CN="Anthropic, PBC", O="Anthropic, PBC"' });

describe("managed CLI install (#3190 3b)", () => {
  it("every entry of the table has an exact version and a registry sha512 for each package, so the two can only change together", () => {
    for (const cli of Object.values(INSTALLABLE_CLIS)) {
      expect(cli.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(Object.keys(cli.integrity).length).toBeGreaterThanOrEqual(2);
      for (const [path, hash] of Object.entries(cli.integrity)) { expect(path).toMatch(/^node_modules\/@[a-z-]+\/[a-z0-9-]+$/); expect(hash).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/); }
      expect(cli.integrity[`node_modules/${cli.spec}`]).toBeDefined();
      expect(cli.native.path.startsWith("node_modules/")).toBe(true);
    }
  });
  it("installs with a fixed argv and no shell, checks integrity, signatures and publisher, then points current.json at it", async () => {
    const { run, calls } = fakeRun("claude-code"), steps: string[] = [];
    const root = join(home, "cli");
    const result = await installManagedCli("claude-code", { root, nodePath: node, run, signerOf: signed, report: s => steps.push(s) });
    expect(steps).toEqual(["installing", "checking-integrity", "checking-signatures", "checking-publisher", "ready"]);
    expect(calls[0].slice(1)).toEqual([expect.stringMatching(/npm-cli\.js$/), "install", "@anthropic-ai/claude-code@2.1.316", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org/"]);
    expect(calls[1].slice(2)).toEqual(["audit", "signatures"]);
    expect(result.version).toBe("2.1.316");
    expect(JSON.parse(readFileSync(join(root, "claude-code", "current.json"), "utf8"))).toEqual({ version: "2.1.316" });
    expect(managedCliExecutable(root, "claude-code")).toMatchObject({ command: result.command, args: [], version: "2.1.316" });
  });
  it("refuses everything that is not in the table: an unknown id, a package name, a version or a path", async () => {
    const deps = { root: join(home, "cli"), nodePath: node, run: fakeRun("codex").run };
    for (const bad of ["gemini", "@evil/pkg", "codex@9.9.9", "../codex", "constructor", "__proto__", "", 7, undefined]) await expect(installManagedCli(bad, deps)).rejects.toThrow(/cannot be installed/);
    expect(existsSync(join(home, "cli", "codex"))).toBe(false);
  });
  it("a package whose registry hash is not the pinned one is never used", async () => {
    const wrong = { ...INSTALLABLE_CLIS.codex.integrity, "node_modules/@openai/codex": "sha512-" + "A".repeat(86) + "==" };
    const root = join(home, "cli");
    await expect(installManagedCli("codex", { root, nodePath: node, run: fakeRun("codex", { integrity: wrong }).run, signerOf: signed })).rejects.toMatchObject({ reason: "integrity-mismatch" });
    expect(managedCliExecutable(root, "codex")).toBeNull();
    expect(existsSync(join(root, "codex", "current.json"))).toBe(false);
    expect(existsSync(join(root, "codex", "0.165.0.staging"))).toBe(false);
  });
  it("fails closed on signatures, publisher, npm errors, a timeout and a missing npm", async () => {
    const root = join(home, "cli");
    await expect(installManagedCli("claude-code", { root, nodePath: node, run: fakeRun("claude-code", { auditCode: 1 }).run, signerOf: signed })).rejects.toMatchObject({ reason: "signature-check-failed" });
    await expect(installManagedCli("claude-code", { root, nodePath: node, run: fakeRun("claude-code").run, signerOf: async () => ({ status: "Valid", subject: 'CN="Someone Else"' }) })).rejects.toMatchObject({ reason: "publisher-mismatch" });
    await expect(installManagedCli("claude-code", { root, nodePath: node, run: fakeRun("claude-code").run, signerOf: async () => ({ status: "NotSigned", subject: 'CN="Anthropic, PBC"' }) })).rejects.toMatchObject({ reason: "publisher-mismatch" });
    await expect(installManagedCli("claude-code", { root, nodePath: node, run: fakeRun("claude-code", { installCode: 1 }).run, signerOf: signed })).rejects.toMatchObject({ reason: "install-failed" });
    await expect(installManagedCli("claude-code", { root, nodePath: node, run: fakeRun("claude-code", { installCode: null }).run, signerOf: signed })).rejects.toMatchObject({ reason: "timed-out" });
    await expect(installManagedCli("claude-code", { root, nodePath: join(home, "nowhere", "node.exe"), run: fakeRun("claude-code").run })).rejects.toBeInstanceOf(CliInstallError);
    expect(managedCliExecutable(root, "claude-code")).toBeNull();
  });
  it("an older pin than this Runtime's is not used (reinstall)", async () => {
    const root = join(home, "cli");
    await installManagedCli("codex", { root, nodePath: node, run: fakeRun("codex").run, signerOf: async () => ({ status: "Valid", subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"' }) });
    expect(managedCliExecutable(root, "codex")).not.toBeNull();
    writeFileSync(join(root, "codex", "current.json"), JSON.stringify({ version: "0.160.0" }));
    expect(managedCliExecutable(root, "codex")).toBeNull();
    expect(managedCliExecutable(root, "../codex")).toBeNull();
  });
  it("a link in the CLI folder is never followed, for writing or for running", async () => {
    const root = join(home, "cli"), elsewhere = join(home, "elsewhere");
    mkdirSync(root, { recursive: true }); mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "codex"), "dir");
    await expect(installManagedCli("codex", { root, nodePath: node, run: fakeRun("codex").run, signerOf: signed })).rejects.toMatchObject({ reason: "install-failed", message: expect.stringMatching(/is a link/) });
    expect(existsSync(join(elsewhere, "0.165.0.staging"))).toBe(false);
    rmSync(join(root, "codex"));
    await installManagedCli("codex", { root, nodePath: node, run: fakeRun("codex").run, signerOf: async () => ({ status: "Valid", subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"' }) });
    const real = join(root, "codex", "0.165.0"), moved = join(home, "moved");
    mkdirSync(moved); rmSync(real, { recursive: true }); symlinkSync(moved, real, "dir");
    expect(managedCliExecutable(root, "codex")).toBeNull();
  });
  it("an error that is not ours never carries its text out (a filesystem error holds a path)", async () => {
    const run: NonNullable<InstallDeps["run"]> = async (_file, args, { cwd }) => { if (args[1] === "install") { writeFileSync(join(cwd, "package-lock.json"), "{ not json C:\\\\Users\\\\secret"); return { code: 0, stdout: "" }; } return { code: 0, stdout: "" }; };
    const error = await installManagedCli("codex", { root: join(home, "cli"), nodePath: node, run, signerOf: signed }).catch(e => e);
    expect(error).toBeInstanceOf(CliInstallError); expect(error.message).not.toMatch(/secret|Users|JSON/);
  });
  it("one install at a time, and a failed one does not block the next", async () => {
    let release = (): void => {}; const gate = new Promise<void>(done => { release = done; });
    const inner = fakeRun("codex"), run: NonNullable<InstallDeps["run"]> = async (...args) => { await gate; return inner.run(...args); };
    const { install, running } = managedInstaller({ root: join(home, "cli"), nodePath: node, run, signerOf: async () => ({ status: "Valid", subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"' }) });
    expect(running()).toBe(false);
    const first = install("codex");
    expect(running()).toBe(true);
    await expect(install("claude-code")).rejects.toMatchObject({ reason: "busy" });
    release(); await expect(first).resolves.toEqual({ version: "0.165.0" }); expect(running()).toBe(false);
    await expect(install("grok")).rejects.toMatchObject({ reason: "install-failed" });
    await expect(install("codex")).resolves.toEqual({ version: "0.165.0" });
  });
  it("reads Windows' answer about the signer, and passes the file path in the environment, never in the command text", async () => {
    const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const answer = await windowsSignerOf("C:\\x\\codex.exe", async (_file, args, { env }) => { seen.push({ args, env }); return { code: 0, stdout: 'Valid|CN="OpenAI OpCo, LLC", O="OpenAI | Co"\r\n' }; });
    expect(answer).toEqual({ status: "Valid", subject: 'CN="OpenAI OpCo, LLC", O="OpenAI | Co"' });
    expect(seen[0].env.AGEND_CHECK_FILE).toBe("C:\\x\\codex.exe"); expect(seen[0].args.join(" ")).not.toContain("codex.exe");
  });
  it("gives npm only the Windows basics and the network settings, never a secret or a registry from outside", () => {
    const env = installEnvironment({ PATH: "p", SystemRoot: "C:\\Windows", HTTPS_PROXY: "http://proxy:8080", ANTHROPIC_API_KEY: "sk-secret", OPENAI_API_KEY: "sk-secret", AGEND_TOKEN: "t", npm_config_registry: "https://evil.example/", npm_config_ignore_scripts: "false", NPM_CONFIG_USERCONFIG: "C:\\evil\\.npmrc" }, "C:\\cache");
    expect(env).toMatchObject({ PATH: "p", SystemRoot: "C:\\Windows", HTTPS_PROXY: "http://proxy:8080", npm_config_registry: "https://registry.npmjs.org/", npm_config_ignore_scripts: "true", npm_config_cache: "C:\\cache" });
    expect(Object.keys(env).join(",")).not.toMatch(/KEY|TOKEN|USERCONFIG/i);
  });
});

const OPENAI = 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"';
const CLAUDE = 'CN="Anthropic, PBC", O="Anthropic, PBC", L=San Francisco, S=California, C=US';
/** Waits for `ms`, or for the signal (then answers like a killed child: no exit code). */
const sleepUnless = (ms: number, signal?: AbortSignal): Promise<boolean> => new Promise(done => {
  const timer = setTimeout(() => done(true), ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); done(false); }, { once: true });
});

describe("N3: the signer is compared exactly, as CN and O (#3190 3b)", () => {
  it("reads Windows' subject text: a quoted value may hold a comma and a quote, and an unreadable one reads as nothing", () => {
    expect(parseSubject(CLAUDE)).toEqual([["CN", "Anthropic, PBC"], ["O", "Anthropic, PBC"], ["L", "San Francisco"], ["S", "California"], ["C", "US"]]);
    expect(parseSubject('CN="A ""quoted"" name, Inc", O=Plain')).toEqual([["CN", 'A "quoted" name, Inc'], ["O", "Plain"]]);
    for (const bad of ["", "CN", 'CN="unclosed, O=x', 'CN="a"b, O=c', "CN=a+O=b", "CN=a,", "=x", "CN=Anthropic, PBC"]) expect(parseSubject(bad), bad).toBeNull();
  });
  it("accepts exactly the expected CN and O, whatever else the subject says", () => {
    expect(signerMatches(CLAUDE, INSTALLABLE_CLIS["claude-code"].native.signer)).toBe(true);
    expect(signerMatches(OPENAI + ", L=San Francisco, C=US", INSTALLABLE_CLIS.codex.native.signer)).toBe(true);
    expect(signerMatches('O="Anthropic, PBC",CN="Anthropic, PBC"', INSTALLABLE_CLIS["claude-code"].native.signer)).toBe(true);
  });
  it.each([
    ["claude-code", "CN=Anthropic, PBC Evil", "an unquoted name that only starts with the right one"],
    ["claude-code", 'CN="Anthropic, PBC Evil", O="Anthropic, PBC"', "a quoted CN that only starts with the right one"],
    ["codex", "CN=OpenAI OpCo Evil", "a CN that is only a prefix of the right one"],
    ["codex", 'CN="OpenAI OpCo Evil", O="OpenAI OpCo, LLC"', "a quoted CN that is only a prefix, with a right O"],
    ["claude-code", 'CN="Someone Else", O="Anthropic, PBC"', "only the O is right"],
    ["codex", 'CN="OpenAI OpCo, LLC", O="Someone Else"', "only the CN is right"],
    ["codex", 'CN="OpenAI OpCo, LLC"', "no O at all"],
    ["claude-code", 'CN="Evil", O="Anthropic, PBC", CN="Anthropic, PBC"', "a second CN beside a right one"],
  ] as const)("never installs for %s when the subject is %j (%s)", async (id, subject, _why) => {
    const root = join(home, "cli");
    await expect(installManagedCli(id, { root, nodePath: node, run: fakeRun(id).run, signerOf: async () => ({ status: "Valid", subject }) })).rejects.toMatchObject({ reason: "publisher-mismatch" });
    expect(managedCliExecutable(root, id)).toBeNull();
    expect(existsSync(join(root, id, "current.json"))).toBe(false);
  });
  it("installs when the subject is exactly right", async () => {
    const root = join(home, "cli");
    await expect(installManagedCli("claude-code", { root, nodePath: node, run: fakeRun("claude-code").run, signerOf: async () => ({ status: "Valid", subject: CLAUDE }) })).resolves.toMatchObject({ version: "2.1.316" });
  });
});

describe("N1: an install that is already there is left alone; a replacement is a move aside, never a delete first", () => {
  const install = (root: string, extra: Partial<InstallDeps> = {}) => installManagedCli("codex", { root, nodePath: node, run: fakeRun("codex").run, signerOf: async () => ({ status: "Valid", subject: OPENAI }), ...extra });
  /** A finished install whose program is then deleted, so that `current.json` stays but the install is no longer usable. */
  async function broken(root: string): Promise<void> {
    await install(root);
    writeFileSync(join(root, "codex", "0.165.0", "stale.txt"), "the old install");
    rmSync(join(root, "codex", "0.165.0", INSTALLABLE_CLIS.codex.native.path));
    expect(managedCliExecutable(root, "codex")).toBeNull();
  }
  it("installing the version that is already installed and valid does nothing: no npm, no staging, nothing moved", async () => {
    const root = join(home, "cli"), first = await install(root);
    const pointer = join(root, "codex", "current.json"), before = readFileSync(pointer, "utf8"), steps: string[] = [], moves: string[] = [];
    const again = await installManagedCli("codex", { root, nodePath: node, run: async () => { throw Error("npm must not run"); }, signerOf: async () => { throw Error("no check runs"); },
      report: s => steps.push(s), rename: (from, to) => { moves.push(`${from} -> ${to}`); } });
    expect(again).toEqual(first); expect(moves).toEqual([]); expect(steps).toEqual(["ready"]);
    expect(readFileSync(pointer, "utf8")).toBe(before);
    expect(readdirSync(join(root, "codex")).sort()).toEqual(["0.165.0", "current.json"]);
  });
  it("replaces a broken install by moving it aside first (<version>.old), putting the new one in place, then deleting the old", async () => {
    const root = join(home, "cli"); await broken(root);
    const moves: string[] = [], seenOld: boolean[] = [];
    await install(root, { rename: (from, to) => { moves.push(`${basename(from)}>${basename(to)}`); renameSync(from, to); seenOld.push(existsSync(join(root, "codex", "0.165.0.old"))); } });
    expect(moves).toEqual(["0.165.0>0.165.0.old", "0.165.0.staging>0.165.0", "current.json.tmp>current.json"]);
    expect(seenOld).toEqual([true, true, true]);                           // the old folder was there the whole time, until the new one and the pointer were in
    expect(readdirSync(join(root, "codex")).sort()).toEqual(["0.165.0", "current.json"]);
    expect(existsSync(join(root, "codex", "0.165.0", "stale.txt"))).toBe(false);
    expect(managedCliExecutable(root, "codex")).not.toBeNull();
  });
  it("when the swap fails half way, the old folder is moved back and current.json is untouched", async () => {
    const root = join(home, "cli"); await broken(root);
    const pointer = join(root, "codex", "current.json"), before = readFileSync(pointer, "utf8");
    let calls = 0;
    const error = await install(root, { rename: (from, to) => { if (++calls === 2) throw new Error(`EPERM: C:\\Users\\secret\\${basename(from)}`); renameSync(from, to); } }).catch(e => e);
    expect(error).toBeInstanceOf(CliInstallError); expect(error.reason).toBe("install-failed"); expect(error.message).not.toMatch(/secret|EPERM/);
    expect(readFileSync(join(root, "codex", "0.165.0", "stale.txt"), "utf8")).toBe("the old install");   // the old folder is back as it was
    expect(readFileSync(pointer, "utf8")).toBe(before);
    expect(readdirSync(join(root, "codex")).sort()).toEqual(["0.165.0", "current.json"]);                 // no .old, no .staging left
  });
  it("when the pointer cannot be written, the new folder is removed and the old one is put back", async () => {
    const root = join(home, "cli"); await broken(root);
    let calls = 0;
    await expect(install(root, { rename: (from, to) => { if (++calls === 3) throw new Error("EPERM"); renameSync(from, to); } })).rejects.toMatchObject({ reason: "install-failed" });
    expect(readFileSync(join(root, "codex", "0.165.0", "stale.txt"), "utf8")).toBe("the old install");
    expect(readdirSync(join(root, "codex")).sort()).toEqual(["0.165.0", "current.json"]);
  });
  it("clears an .old left by an earlier install at the next install", async () => {
    const root = join(home, "cli"); await broken(root);
    mkdirSync(join(root, "codex", "0.165.0.old")); writeFileSync(join(root, "codex", "0.165.0.old", "leftover.txt"), "x");
    await install(root);
    expect(readdirSync(join(root, "codex")).sort()).toEqual(["0.165.0", "current.json"]);
  });
});

describe("N2: one overall deadline; the Runtime stopping is a different end", () => {
  const spec = (id: "codex" | "claude-code" = "codex") => ({ root: join(home, "cli"), nodePath: node, signerOf: async () => ({ status: "Valid", subject: id === "codex" ? OPENAI : CLAUDE }) });
  it("npm install, npm audit signatures and the signer check share one signal, and the same one that the deadline ends", async () => {
    const signals: Array<AbortSignal | undefined> = [], inner = fakeRun("codex");
    await installManagedCli("codex", { ...spec(), run: async (file, args, options) => { signals.push(options.signal); return inner.run(file, args, options); },
      signerOf: async (_file, signal) => { signals.push(signal); return { status: "Valid", subject: OPENAI }; } });
    expect(signals).toHaveLength(3);
    expect(signals.every(signal => signal !== undefined && signal === signals[0])).toBe(true);
    expect(CLI_INSTALL_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });
  it("the steps add up: two steps that are each shorter than the limit but together longer end as timed-out", async () => {
    const inner = fakeRun("codex"); const root = join(home, "cli");
    const run: NonNullable<InstallDeps["run"]> = async (file, args, options) => {
      if (!(await sleepUnless(120, options.signal))) return { code: null, stdout: "" };
      return inner.run(file, args, options);
    };
    const error = await installManagedCli("codex", { ...spec(), run, deadlineMs: 200 }).catch(e => e);
    expect(error).toMatchObject({ reason: "timed-out" });
    expect(managedCliExecutable(root, "codex")).toBeNull();
    expect(readdirSync(join(root, "codex"))).toEqual([]);                   // staging removed, nothing switched
    expect(existsSync(join(root, "codex", "current.json"))).toBe(false);
  });
  it("the deadline also stops the publisher check", async () => {
    const error = await installManagedCli("codex", { ...spec(), run: fakeRun("codex").run, deadlineMs: 100,
      signerOf: async (_file, signal) => { await sleepUnless(5000, signal); return { status: "", subject: "" }; } }).catch(e => e);
    expect(error).toMatchObject({ reason: "timed-out" });
  });
  it("the Runtime stopping is `cancelled`, not `timed-out`; staging goes, the old install and current.json stay as they were", async () => {
    const root = join(home, "cli"), stop = new AbortController();
    await installManagedCli("codex", { ...spec(), run: fakeRun("codex").run });
    writeFileSync(join(root, "codex", "0.165.0", "stale.txt"), "the old install"); rmSync(join(root, "codex", "0.165.0", INSTALLABLE_CLIS.codex.native.path));
    const pointer = join(root, "codex", "current.json"), before = readFileSync(pointer, "utf8");
    const hanging: NonNullable<InstallDeps["run"]> = async (_file, _args, options) => { setTimeout(() => stop.abort(), 20); await sleepUnless(5000, options.signal); return { code: null, stdout: "" }; };
    const error = await installManagedCli("codex", { ...spec(), run: hanging, signal: stop.signal }).catch(e => e);
    expect(error).toMatchObject({ reason: "cancelled" });
    expect(readFileSync(pointer, "utf8")).toBe(before);
    expect(readFileSync(join(root, "codex", "0.165.0", "stale.txt"), "utf8")).toBe("the old install");
    expect(readdirSync(join(root, "codex")).sort()).toEqual(["0.165.0", "current.json"]);   // no staging
  });
  it("a stop that comes while the installer is being asked to install ends it as cancelled (the Runtime's own signal, through managedInstaller)", async () => {
    const stop = new AbortController(), root = join(home, "cli");
    const hanging: NonNullable<InstallDeps["run"]> = async (_file, _args, options) => { await sleepUnless(5000, options.signal); return { code: null, stdout: "" }; };
    const installer = managedInstaller({ root, nodePath: node, run: hanging }, () => stop.signal);
    const pending = installer.install("claude-code").catch(e => e);
    setTimeout(() => stop.abort(), 20);
    expect(await pending).toMatchObject({ reason: "cancelled" });
    expect(installer.running()).toBe(false);
    expect(readdirSync(join(root, "claude-code"))).toEqual([]);
  });
  it("windowsSignerOf hands the signal to the program it starts", async () => {
    const stop = new AbortController(); let seen: AbortSignal | undefined;
    await windowsSignerOf("C:\\x\\codex.exe", async (_file, _args, options) => { seen = options.signal; return { code: 0, stdout: "Valid|CN=x" }; }, stop.signal);
    expect(seen).toBe(stop.signal);
  });
  describe.skipIf(process.platform === "win32")("with a real child process (the Runtime's own execFile)", () => {
    /** `<home>/real-node/node` is this node, and the "npm" next to it is a script of the test's choosing. */
    function realNode(script: string): string {
      const real = join(home, "real-node"); mkdirSync(real, { recursive: true });
      symlinkSync(process.execPath, join(real, "node")); mkdirSync(join(real, "node_modules", "npm", "bin"), { recursive: true });
      writeFileSync(join(real, "node_modules", "npm", "bin", "npm-cli.js"), script);
      return join(real, "node");
    }
    it("N6: npm output past the size limit is install-failed, not timed-out", async () => {
      const nodePath = realNode('process.stdout.write("x".repeat(3 * 1024 * 1024)); setTimeout(() => {}, 1);');
      const error = await installManagedCli("codex", { root: join(home, "cli"), nodePath, signerOf: async () => ({ status: "Valid", subject: OPENAI }) }).catch(e => e);
      expect(error).toMatchObject({ reason: "install-failed" });
      expect(error.message).not.toMatch(/did not finish in time/);
    });
    it("the overall deadline stops a real child and answers timed-out; the Runtime's stop answers cancelled", async () => {
      const nodePath = realNode("setTimeout(() => {}, 60000);");
      const started = Date.now();
      const timed = await installManagedCli("codex", { root: join(home, "cli"), nodePath, deadlineMs: 400, signerOf: async () => ({ status: "Valid", subject: OPENAI }) }).catch(e => e);
      expect(timed).toMatchObject({ reason: "timed-out" }); expect(Date.now() - started).toBeLessThan(8000);
      const stop = new AbortController(); setTimeout(() => stop.abort(), 200);
      const cancelled = await installManagedCli("codex", { root: join(home, "cli"), nodePath, signal: stop.signal, signerOf: async () => ({ status: "Valid", subject: OPENAI }) }).catch(e => e);
      expect(cancelled).toMatchObject({ reason: "cancelled" });
      expect(readdirSync(join(home, "cli", "codex"))).toEqual([]);
    });
  });
});

describe("N6: output past the size limit is its own failure", () => {
  it("a run that went over its output limit is install-failed in either npm step", async () => {
    const inner = fakeRun("codex");
    const first = await installManagedCli("codex", { root: join(home, "cli"), nodePath: node, run: async () => ({ code: null, stdout: "", overflow: true }), signerOf: async () => ({ status: "Valid", subject: OPENAI }) }).catch(e => e);
    expect(first).toMatchObject({ reason: "install-failed" });
    const second = await installManagedCli("codex", { root: join(home, "cli"), nodePath: node, run: async (file, args, options) => args[1] === "audit" ? { code: null, stdout: "", overflow: true } : inner.run(file, args, options), signerOf: async () => ({ status: "Valid", subject: OPENAI }) }).catch(e => e);
    expect(second).toMatchObject({ reason: "signature-check-failed" });
  });
});

describe("N7: after a switch, other versions and the npm cache are cleared on a best-effort basis", () => {
  const OTHER = ["0.150.0", "0.150.0.old", "0.164.1.staging"];
  it("removes the other versions of the same CLI and the npm cache, and leaves other CLIs and unknown names alone", async () => {
    const root = join(home, "cli");
    for (const name of OTHER) { mkdirSync(join(root, "codex", name), { recursive: true }); writeFileSync(join(root, "codex", name, "x"), "x"); }
    mkdirSync(join(root, "codex", "notes"), { recursive: true }); mkdirSync(join(root, "claude-code", "2.1.0"), { recursive: true });
    mkdirSync(join(root, ".npm-cache", "_cacache"), { recursive: true }); writeFileSync(join(root, ".npm-cache", "_cacache", "x"), "x");
    await installManagedCli("codex", { root, nodePath: node, run: fakeRun("codex").run, signerOf: async () => ({ status: "Valid", subject: OPENAI }) });
    expect(readdirSync(join(root, "codex")).sort()).toEqual(["0.165.0", "current.json", "notes"]);
    expect(existsSync(join(root, "claude-code", "2.1.0"))).toBe(true);
    expect(existsSync(join(root, ".npm-cache"))).toBe(false);
  });
  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)("a folder that cannot be removed does not fail the install", async () => {
    const root = join(home, "cli"), locked = join(root, "codex", "0.150.0", "inner");
    mkdirSync(locked, { recursive: true }); writeFileSync(join(locked, "x"), "x"); chmodSync(locked, 0o500);
    try {
      await expect(installManagedCli("codex", { root, nodePath: node, run: fakeRun("codex").run, signerOf: async () => ({ status: "Valid", subject: OPENAI }) })).resolves.toMatchObject({ version: "0.165.0" });
      expect(managedCliExecutable(root, "codex")).not.toBeNull();
    } finally { chmodSync(locked, 0o700); }
  });
});

describe("N4: the installer exists only on native Windows x64", () => {
  it("is offered for win32/x64 and for nothing else (arm64 is not supported by this version)", () => {
    expect(nativeInstallSupported("win32", "x64")).toBe(true);
    for (const [platform, arch] of [["win32", "arm64"], ["win32", "ia32"], ["linux", "x64"], ["darwin", "arm64"], ["darwin", "x64"]]) expect(nativeInstallSupported(platform, arch), `${platform}/${arch}`).toBe(false);
  });
});
