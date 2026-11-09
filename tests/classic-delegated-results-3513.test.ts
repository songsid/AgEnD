import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFleetInstructions, buildMcpCoreInstructions } from "../src/instructions.js";

const base = { instanceName: "classic-room", workingDirectory: "/fixture/room", workflow: false as const };
const cli = readFileSync(new URL("../src/agent-cli-instructions.md", import.meta.url), "utf8");
const skill = readFileSync(new URL("../src/general-knowledge/skills/cross-instance-messaging/SKILL.md", import.meta.url), "utf8");
const params = { ...base, runtimeIdentity: { kind: "classic" as const, backend: "codex", model: "fixture" } };

describe("ClassicBot completes the channel human's delegated request", () => {
  it.each([
    ["MCP core", () => buildMcpCoreInstructions(params), "`reply`"],
    ["full instructions", () => buildFleetInstructions(params), "`reply`"],
    ["CLI instructions", () => buildFleetInstructions({ ...params, cliInstructions: cli }), "`agend-agent reply`"],
  ] as const)("%s: a matched result needs a channel summary without a fresh peer request", (_name, build, reply) => {
    const text = build();
    expect(text).toContain("work you delegated for a channel human");
    expect(text).toContain("correlation_id");
    expect(text).toContain("original requester");
    expect(text).toContain("summarize");
    const resultRule = text.split("\n").find(line => line.includes("work you delegated for a channel human"))!;
    expect(resultRule).toContain(reply);
    if (reply === "`agend-agent reply`") expect(resultRule).not.toContain("with `reply`");
    expect(text).toContain("No new explicit request is needed");
    expect(text).toContain("Peer chatter and FYI stay quiet");
    expect(text).toContain("other channel-facing work");
  });

  it("full MCP and CLI keep the requester association across compaction without guessing the last speaker", () => {
    for (const text of [buildFleetInstructions(params), buildFleetInstructions({ ...params, cliInstructions: cli })]) {
      expect(text).toContain("requester’s name/ID");
      expect(text).toContain("worker and returned correlation_id");
      expect(text).toContain("compaction");
      expect(text).toContain("never substitute the latest speaker");
      expect(text).toContain("unrelated reports");
    }
  });

  it("the shared skill retains ClassicBot's exception instead of restoring a blanket no-reply rule", () => {
    expect(skill).toContain("work you delegated for a channel human");
    expect(skill).toContain("original requester");
    expect(skill).toContain("Peer chatter and FYI stay quiet");
    expect(skill).not.toContain("/ `report_result`, never `reply`");
  });

  it.each([false, true])("fleet-topic/General rules are unchanged (General=%s)", general => {
    const topic = { ...base, ...(general ? { description: "General — fleet administrator" } : {}), runtimeIdentity: { kind: "fleet-topic" as const, backend: "codex", model: "fixture" } };
    expect(buildMcpCoreInstructions(topic)).toContain("Never `reply`");
    expect(buildFleetInstructions(topic)).toContain("NOT the `reply` tool");
    expect(buildFleetInstructions(topic)).not.toContain("work you delegated for a channel human");
  });

  it("fits the actual MCP instruction budget", () => {
    expect(Buffer.byteLength(buildMcpCoreInstructions(params))).toBeLessThan(2048);
    expect(Buffer.byteLength(buildMcpCoreInstructions({
      ...params, instanceName: "classic-宋承翰的ai-4716",
      workingDirectory: "/home/fixture/.agend/workspaces/classic-宋承翰的ai-4716",
      agendVersion: "2.3.5-beta.2",
      runtimeIdentity: { kind: "classic", backend: "codex", model: "gpt-6.1-sol" },
    }))).toBeLessThan(2048);
  });
});
