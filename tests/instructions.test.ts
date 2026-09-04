import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildFleetInstructions, buildMcpCoreInstructions } from "../src/instructions.js";
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

  it("tells agents the turn is not done until the conclusion is posted to the channel", () => {
    // The reply-tool guidance was rewritten from prohibitive ("your terminal text
    // is NOT delivered") to procedural ("a turn isn't finished until the channel
    // has your conclusion"). These assertions still named the old phrasing.
    const result = buildFleetInstructions(base);
    expect(result).toContain("A turn isn't finished until the channel has your conclusion");
    expect(result).toContain("not your terminal text");
    expect(result).toContain("having a conclusion you never posted is not");
    expect(result).toContain("close with a short line like `.`");
  });

  it("teaches how to call react and edit_message, not just that they exist", () => {
    // #625: the Tool Usage line listed `react` by name but never said what it
    // takes, so instances remembered the tool existed (permanent instructions)
    // and forgot how to call it (conversation, lost to compaction). Both tools
    // take a named `message_id`, so both are taught here — and the schemas are
    // named-parameter objects (ReactArgs = { message_id, emoji }), never
    // positional, so the wording must not read like `react(emoji, message_id)`.
    const result = buildFleetInstructions(base);
    expect(result).toContain("react: add an emoji reaction — needs `message_id` + `emoji`");
    expect(result).toContain("edit_message: update a sent message — needs `message_id` + `text`");
    expect(result).toContain("`message_id` comes from the inbound message header line `(message_id: ... | correlation_id: ...)`");
    expect(result).not.toContain("react(emoji, message_id)");
  });

  it("does not repeat the reserved-emoji rule that lives in Context Protection", () => {
    // The 👀 ⏳ ✅ ❌ carve-out belongs to the workflow template's Context
    // Protection section; duplicating it next to `react` was explicitly
    // rejected in #625.
    const result = buildFleetInstructions({ ...base, workflow: false });
    expect(result).not.toContain("👀");
  });

  it("routes user replies and instance replies to different tools", () => {
    const result = buildFleetInstructions(base);
    expect(result).toContain("reply with the `reply` tool");
    expect(result).toContain("`send_to_instance` or `report_result`, NOT the `reply` tool");
  });

  it("keeps fleet-topic cross-instance replies off the human channel", () => {
    const params = {
      ...base,
      runtimeIdentity: { kind: "fleet-topic" as const, backend: "codex", model: "gpt-5.6-sol" },
      workflow: false,
    };
    const full = buildFleetInstructions(params);
    const core = buildMcpCoreInstructions(params);

    expect(full).toContain("`send_to_instance` or `report_result`, NOT the `reply` tool");
    expect(full).toContain("Reply via send_to_instance or report_result, NOT reply");
    expect(core).toContain("Never `reply`");
    expect(full).not.toContain("bound ClassicBot channel");
    expect(core).not.toContain("bound ClassicBot channel");
  });

  it("lets ClassicBot perform only explicitly requested human-facing channel work", () => {
    const params = {
      ...base,
      runtimeIdentity: { kind: "classic" as const, backend: "codex", model: "gpt-5.6-sol" },
      workflow: false,
    };
    const full = buildFleetInstructions(params);
    const core = buildMcpCoreInstructions(params);

    for (const instructions of [full, core]) {
      expect(instructions).toContain("Only when the request explicitly asks");
      expect(instructions).toContain("bound ClassicBot channel");
      expect(instructions).toContain("ask, notify, follow up, or mention someone");
      expect(instructions).toContain("With `requires_reply=true`, also report the outcome to the sender");
    }
    // The exception is keyed only by instance kind, not by request_kind, so
    // send_to_instance and delegate_task can assign the same channel work.
    expect(core).toContain("`delegate_task` → work silently → `report_result`");
    expect(Buffer.byteLength(core, "utf8")).toBeLessThan(2048);
    expect(full).not.toContain("NOT the `reply` tool");
    expect(core).not.toContain("Never `reply`");
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

  it("applies the same runtime-scoped exception in CLI mode", () => {
    const cliInstructions = readFileSync(
      new URL("../src/agent-cli-instructions.md", import.meta.url),
      "utf8",
    );
    const classic = buildFleetInstructions({
      ...base,
      runtimeIdentity: { kind: "classic", backend: "grok", model: "grok-code-fast-1" },
      cliInstructions,
      workflow: false,
    });
    const fleetTopic = buildFleetInstructions({
      ...base,
      runtimeIdentity: { kind: "fleet-topic", backend: "grok", model: "grok-code-fast-1" },
      cliInstructions,
      workflow: false,
    });

    expect(classic).toContain("This is a ClassicBot instance");
    expect(classic).toContain("Only when the request explicitly asks");
    expect(classic).toContain("use `agend-agent reply` for that channel-facing action");
    expect(classic).toContain("With `requires_reply=true`, also report the outcome to the sender");
    expect(fleetTopic).toContain("This is a fleet-topic instance");
    expect(fleetTopic).toContain("never use `agend-agent reply`");
    expect(fleetTopic).not.toContain("bound ClassicBot channel");
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
