import { describe, it, expect } from "vitest";
import { TOOLS } from "../../src/channel/mcp-tools.js";

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
});
