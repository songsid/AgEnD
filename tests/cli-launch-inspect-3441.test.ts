import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, renameSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectClaudeLaunch, inspectInstalledClaude, executableReplacementReason, claudeMinimumError, sameCliProcess } from "../src/cli-launch-inspect.js";
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0))
  rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-cli-proof-"));
  roots.push(root);
  const proc = join(root, "proc"), bin = join(root, "bin", "claude"), pkg = join(root, "lib", "node_modules", "@anthropic-ai", "claude-code");
  const write = (path: string, s: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, s); };
  const exe = join(pkg, "bin", "claude.exe");
  write(exe, "inert image metadata fixture");
  write(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.319" }));
  mkdirSync(dirname(bin), { recursive: true });
  symlinkSync(exe, bin);
  function process(pid: number, parent: number, path: string, start = "777", children: string = "") {
    write(join(proc, String(pid), "stat"), `${pid} (name with spaces) ${["S", String(parent), ...Array(17).fill("0"), start, "0"].join(" ")}`);
    write(join(proc, String(pid), "task", String(pid), "children"), children);
    symlinkSync(path, join(proc, String(pid), "exe"));
  }
  return { root, proc, bin, pkg, exe, write, process };
}
it("reads exact owned native CLI/package without executing it", () => {
  const f = fixture();
  f.process(1001, 1, f.exe);
  const got = inspectClaudeLaunch(1001, f.bin, f.proc)!;
  expect(got.process).toMatchObject({ pid: 1001, start: "777", reason: null, version: "2.1.319" });
  expect(got.installed).toMatchObject({ path: f.bin, real: f.exe, version: "2.1.319" });
  expect(got.chain).toHaveLength(1);
});
it.each(["deleted", "npm-temporary"] as const)("recognizes a positive %s process while the installed path is new", reason => {
  const f = fixture(), old = join(f.root, "lib", "node_modules", "@anthropic-ai", ".claude-code-Abc_123", "bin", "claude.exe") + (reason === "deleted" ? " (deleted)" : "");
  f.write(old, "old executable");
  f.process(1001, 1, old);
  const got = inspectClaudeLaunch(1001, f.bin, f.proc)!;
  expect(got.process.reason).toBe(reason);
  expect(got.process.version).toBeNull();
  expect(got.installed?.version).toBe("2.1.319");
});
it("only follows a single shell chain, and validates parent/start identities", () => {
  const f = fixture(), shell = join(f.root, "bash");
  f.write(shell, "shell fixture");
  f.process(1001, 1, shell, "11", "1002");
  f.process(1002, 1001, f.exe, "22");
  expect(inspectClaudeLaunch(1001, f.bin, f.proc)?.chain.map(x => x.pid)).toEqual([1001, 1002]);
  f.write(join(f.proc, "1001/task/1001/children"), "1002 1003");
  expect(inspectClaudeLaunch(1001, f.bin, f.proc)).toBeNull();
  f.write(join(f.proc, "1001/task/1001/children"), "1002");
  const path = join(f.proc, "1002/stat");
  f.write(path, readFileSync(path, "utf8").replace(" S 1001 ", " S 999 "));
  expect(inspectClaudeLaunch(1001, f.bin, f.proc)).toBeNull();
});
it("an unrelated primary is unknown even if its child is named Claude", () => {
  const f = fixture(), other = join(f.root, "unrelated");
  f.write(other, "inert");
  f.process(1001, 1, other, "11", "1002");
  f.process(1002, 1001, f.exe);
  expect(inspectClaudeLaunch(1001, f.bin, f.proc)).toBeNull();
});
it("PID reuse and image replacement invalidate a retained process proof", () => {
  const f = fixture();
  f.process(1001, 1, f.exe);
  const a = inspectClaudeLaunch(1001, f.bin, f.proc)!;
  f.write(join(f.proc, "1001/stat"), readFileSync(join(f.proc, "1001/stat"), "utf8").replace(" 777 ", " 778 "));
  expect(sameCliProcess(a, inspectClaudeLaunch(1001, f.bin, f.proc)!)).toBe(false);
});
it("does not call an npm temporary or missing target an installed replacement", () => {
  const f = fixture();
  renameSync(f.pkg, join(dirname(f.pkg), ".claude-code-Abc123"));
  expect(inspectInstalledClaude(f.bin)).toBeNull();
  expect(inspectInstalledClaude(join(dirname(f.pkg), ".claude-code-Abc123/bin/claude.exe"))).toBeNull();
});
it("never mistakes nvm's Node version or another package for Claude's version", () => {
  const f = fixture();
  f.write(join(f.pkg, "package.json"), JSON.stringify({ name: "another-package", version: "22.23.1" }));
  expect(inspectInstalledClaude(f.bin)?.version).toBeNull();
});
it("ordinary dot directories do not count as npm replacements", () => {
  for (const p of ["/home/.claude/versions/2.1.319", "/home/.claude-code-backup/claude", "/other/.claude-code-x/bin/claude"]) {
    expect(executableReplacementReason(p)).toBeNull();
  }
});
it("parses only an actual version refusal, including a wrapped terminal row, and supplies no model table", () => {
  const row = "● API Error: 400 Claude Code 2.1.220 does not support this model;\n version 2.1.280 or newer is required";
  expect(claudeMinimumError(row)).toEqual({ running: "2.1.220", required: "2.1.280" });
  expect(claudeMinimumError("> " + row)).toBeNull();
  expect(claudeMinimumError(row.replace("2.1.220", "2.1.319"))).toBeNull();
  expect(claudeMinimumError("This model requires a newer app")).toBeNull();
});
it("recognizes official version-named native images without treating a Node release as Claude", () => {
  const f = fixture(), native = join(f.root, "share/claude/versions/2.1.319");
  f.write(native, "inert native image");
  f.process(1001, 1, native);
  expect(inspectClaudeLaunch(1001, native, f.proc)?.process.version).toBe("2.1.319");
});
it("a Node process never borrows the current JS package version as its loaded version", () => {
  const f = fixture(), node = join(f.root, "node");
  f.write(node, "inert Node image");
  f.process(1001, 1, node);
  f.write(join(f.proc, "1001/cmdline"), `${node}\0${join(f.pkg, "cli.js")}\0`);
  const got = inspectClaudeLaunch(1001, f.bin, f.proc)!;
  expect(got.process.version).toBeNull();
  expect(got.installed?.version).toBe("2.1.319");
});
