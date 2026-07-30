import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildFleetInstructions } from "../src/instructions.js";
import { buildInstructionReloadNotice } from "../src/daemon.js";

describe("buildFleetInstructions", () => {
  const base = { instanceName: "test-inst", workingDirectory: "/home/user/project" };

  it("includes instance name and working directory", () => {
    const result = buildFleetInstructions(base);
    expect(result).toContain("**test-inst**");
    expect(result).toContain("`/home/user/project`");
  });

  it("includes the effective runtime identity when provided", () => {
    const result = buildFleetInstructions({
      ...base,
      runtimeIdentity: {
        kind: "classic",
        backend: "codex",
        model: "gpt-5.6-sol",
      },
    });
    expect(result).toContain("Runtime: kind=classic, backend=codex, model=gpt-5.6-sol.");
  });

  it("includes message format and collaboration rules", () => {
    const result = buildFleetInstructions(base);
    expect(result).toContain("[user:");
    expect(result).toContain("[from:");
    expect(result).toContain("`reply` tool");
    expect(result).toContain("send_to_instance");
  });

  it("keeps user content in reply while preserving an operator-visible failure path", () => {
    const result = buildFleetInstructions(base);
    expect(result).toContain("Everything for the user goes inside the `reply` call");
    expect(result).toContain("NOT delivered to their chat");
    expect(result).toContain("end the turn with a final\ntext of exactly `.`");
    expect(result).toContain("if `reply` fails, say so in the final text");
    expect(result).toContain("After that tool succeeds, likewise end the turn with exactly `.`");
  });

  it("gives CLI-mode agents equivalent delivery and final-text rules", () => {
    const cliInstructions = readFileSync(
      new URL("../src/agent-cli-instructions.md", import.meta.url),
      "utf8",
    );
    expect(cliInstructions).toContain("Everything for a human user goes inside the `agend-agent reply` command");
    expect(cliInstructions).toContain("NOT delivered to their chat");
    expect(cliInstructions).toContain("end the turn with final text of exactly `.`");
    expect(cliInstructions).toContain("if the command fails, say so in the final text");
    expect(cliInstructions).toContain("After the command succeeds, likewise end the turn with exactly");
  });

  it("does not tell backends to scan Kiro steering at startup", () => {
    const result = buildFleetInstructions(base);
    expect(result).not.toContain("Read all steering files");
    expect(result).not.toContain("find .kiro/steering");
  });

  it("includes display name when provided", () => {
    const result = buildFleetInstructions({ ...base, displayName: "Luna" });
    expect(result).toContain('"Luna"');
  });

  it("prompts for display name when not provided", () => {
    const result = buildFleetInstructions(base);
    expect(result).toContain("set_display_name");
  });

  it("includes description as role", () => {
    const result = buildFleetInstructions({ ...base, description: "Code reviewer" });
    expect(result).toContain("## Role");
    expect(result).toContain("Code reviewer");
  });

  it("includes custom prompt", () => {
    const result = buildFleetInstructions({ ...base, customPrompt: "Always use TypeScript" });
    expect(result).toContain("Always use TypeScript");
  });

  it("includes inline workflow content", () => {
    const result = buildFleetInstructions({ ...base, workflow: "Custom workflow rules" });
    expect(result).toContain("## Development Workflow");
    expect(result).toContain("Custom workflow rules");
  });

  it("excludes workflow when false", () => {
    const result = buildFleetInstructions({ ...base, workflow: false });
    expect(result).not.toContain("## Development Workflow");
  });

  it("includes decisions", () => {
    const result = buildFleetInstructions({
      ...base,
      decisions: [{ title: "Use ESM", content: "All modules should use ESM imports." }],
    });
    expect(result).toContain("## Active Decisions");
    expect(result).toContain("**Use ESM**");
  });

  it("caps decisions at 15 with overflow note", () => {
    const decisions = Array.from({ length: 20 }, (_, i) => ({
      title: `Decision ${i}`,
      content: `Content ${i}`,
    }));
    const result = buildFleetInstructions({ ...base, decisions });
    expect(result).toContain("5 more");
    expect(result).toContain("list_decisions");
  });

  it("omits decisions section when empty", () => {
    const result = buildFleetInstructions({ ...base, decisions: [] });
    expect(result).not.toContain("## Active Decisions");
  });
});

describe("buildInstructionReloadNotice", () => {
  it("targets the backend-native file instead of a directory scan", () => {
    expect(buildInstructionReloadNotice("codex", "worker", "/tmp/worker"))
      .toContain("Reload only AGENTS.md");
    expect(buildInstructionReloadNotice("grok", "worker", "/tmp/worker"))
      .toContain("Reload only AGENTS.md");
    expect(buildInstructionReloadNotice("kiro-cli", "worker", "/tmp/worker"))
      .toContain("Reload only .kiro/steering/agend-worker.md");
  });

  it("never requests a broad steering scan", () => {
    const notice = buildInstructionReloadNotice("codex", "worker", "/tmp/worker");
    expect(notice).not.toContain("Re-read your steering files");
    expect(notice).toContain("do not scan other instruction directories");
  });
});
