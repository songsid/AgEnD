import { describe, it, expect } from "vitest";
import { TOOLS } from "../../src/channel/mcp-tools.js";
import { CreateScheduleArgs } from "../../src/outbound-schemas.js";

describe("MCP tool schema", () => {
  it("send_to_instance includes working_directory and branch", () => {
    const tool = TOOLS.find(t => t.name === "send_to_instance");
    expect(tool).toBeDefined();
    const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("working_directory");
    expect(props).toHaveProperty("branch");
  });

  it("send_to_instance requires instance_name and message", () => {
    const tool = TOOLS.find(t => t.name === "send_to_instance");
    const required = (tool!.inputSchema as { required: string[] }).required;
    expect(required).toContain("instance_name");
    expect(required).toContain("message");
  });

  it("create_schedule exposes one-shot at and enforces cron/at exclusivity", () => {
    const tool = TOOLS.find(t => t.name === "create_schedule");
    const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("cron");
    expect(props).toHaveProperty("at");

    const common = { message: "wake up", target: "general" };
    expect(CreateScheduleArgs.safeParse({ ...common, cron: "0 7 * * *" }).success).toBe(true);
    expect(CreateScheduleArgs.safeParse({ ...common, at: "2026-07-26T14:00:00+08:00" }).success).toBe(true);
    expect(CreateScheduleArgs.safeParse(common).success).toBe(false);
    expect(CreateScheduleArgs.safeParse({
      ...common,
      cron: "0 7 * * *",
      at: "2026-07-26T14:00:00+08:00",
    }).success).toBe(false);
    expect(CreateScheduleArgs.safeParse({ ...common, at: "2026-07-26T14:00:00" }).success).toBe(false);
  });
});
