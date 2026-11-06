import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliInstallError, INSTALLABLE_CLIS, installEnvironment, installManagedCli, managedCliExecutable, managedInstaller, windowsSignerOf, type InstallDeps } from "../src/runtime-cli-install.js";
import { AUDITED_NATIVE_PANE_VERSIONS, assertAuditedNativePaneVersion } from "../src/runtime-pane-native.js";

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
  it("pins exactly the versions that persistent panes accept, so a dashboard install can never land an unusable CLI", () => {
    expect(() => assertAuditedNativePaneVersion("claude-code", `${INSTALLABLE_CLIS["claude-code"].version} (Claude Code)`)).not.toThrow();
    expect(() => assertAuditedNativePaneVersion("codex", `codex-cli ${INSTALLABLE_CLIS.codex.version}`)).not.toThrow();
    expect(INSTALLABLE_CLIS["claude-code"].version).toBe(AUDITED_NATIVE_PANE_VERSIONS["claude-code"]);
    expect(INSTALLABLE_CLIS.codex.version).toBe(AUDITED_NATIVE_PANE_VERSIONS.codex);
    for (const cli of Object.values(INSTALLABLE_CLIS)) for (const hash of Object.values(cli.integrity)) expect(hash).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
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
    await installManagedCli("codex", { root, nodePath: node, run: fakeRun("codex").run, signerOf: async () => ({ status: "Valid", subject: 'CN="OpenAI OpCo, LLC"' }) });
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
    await installManagedCli("codex", { root, nodePath: node, run: fakeRun("codex").run, signerOf: async () => ({ status: "Valid", subject: 'CN="OpenAI OpCo, LLC"' }) });
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
    const { install, running } = managedInstaller({ root: join(home, "cli"), nodePath: node, run, signerOf: async () => ({ status: "Valid", subject: 'CN="OpenAI OpCo, LLC"' }) });
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
