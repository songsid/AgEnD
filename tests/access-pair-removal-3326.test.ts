import { readFileSync } from "node:fs";
import { Command } from "commander";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Register the real access subtree with Commander, but never execute a host action. */
function accessProgram() {
  const source = read("src/cli.ts"), start = source.indexOf("const access = program"), end = source.indexOf("// === Update + Reload", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} });
  new Function("program", js)(program);
  const access = program.commands.find(c => c.name() === "access")!;
  const action = vi.fn();
  for (const cmd of access.commands) cmd.action(action); // no filesystem, config or lifecycle execution
  return { program, access, action };
}

describe("D8 removes the legacy people-access code surface", () => {
  it("does not advertise or accept access pair, while preserving normal access administration", () => {
    const { program, access, action } = accessProgram();
    expect(access.commands.map(c => c.name())).toEqual(["lock", "unlock", "list", "remove"]);
    expect(access.helpInformation()).not.toMatch(/\bpair\s+[<[]/);
    expect(() => program.parse(["access", "pair", "fixture", "999"], { from: "user" })).toThrow(expect.objectContaining({ code: "commander.unknownCommand" }));
    expect(action).not.toHaveBeenCalled();
    program.parse(["access", "list", "fixture"], { from: "user" });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("current EN/zh-TW guidance uses in-page allowed users, not code generation", () => {
    const paths = ["docs/cli.md", "docs/cli.zh-TW.md", "docs/configuration.md", "docs/configuration.zh-TW.md", "docs/use-cases.md", "docs/use-cases.zh-TW.md", "docs/concepts.md", "docs/concepts.zh-TW.md", "src/general-knowledge/steering/core-rules.md", "src/general-knowledge/skills/concepts/SKILL.md"];
    for (const path of paths) {
      const text = read(path);
      expect(text, path).not.toMatch(/\/pair\b|agend access pair/);
      expect(text, path).toMatch(/Settings → Chat & connections → Chat connections → the bot → Allowed users \(primary bot\)|設定 → 聊天與連線 → 聊天連線 → 該 bot → 允許使用者（主 bot）/);
    }
    expect(paths).toHaveLength(10);
  });

  it("does not advertise removed adapter methods to plugin authors", () => {
    expect(read("docs/plugin-development.md")).not.toMatch(/handlePairing|confirmPairing/);
  });
});
