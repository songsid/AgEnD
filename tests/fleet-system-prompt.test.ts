import { describe, it, expect } from "vitest";
import { generateFleetSystemPrompt } from "../src/fleet-system-prompt.js";

describe("generateFleetSystemPrompt", () => {
  const prompt = () => generateFleetSystemPrompt({
    instanceName: "my-project",
    workingDirectory: "/home/user/project",
  });

  it("includes the instance name", () => {
    expect(prompt()).toContain("**my-project**");
  });

  it("includes the working directory", () => {
    expect(prompt()).toContain("`/home/user/project`");
  });

  it("documents message format with [user:] and [from:] prefixes", () => {
    const result = prompt();
    expect(result).toContain("[user:");
    expect(result).toContain("[from:");
    expect(result).toContain("`reply` tool");
  });

  it("lists communication tools", () => {
    const result = prompt();
    expect(result).toContain("reply");
    expect(result).toContain("send_to_instance");
    expect(result).toContain("request_information");
    expect(result).toContain("delegate_task");
    expect(result).toContain("report_result");
  });

  it("lists fleet management tools", () => {
    const result = prompt();
    expect(result).toContain("list_instances");
    expect(result).toContain("describe_instance");
    expect(result).toContain("start_instance");
    expect(result).toContain("create_instance");
    expect(result).toContain("delete_instance");
  });

  it("warns against using reply tool for cross-instance messages", () => {
    expect(prompt()).toContain("NOT the `reply` tool");
  });

  it("advises discovery before assumption", () => {
    expect(prompt()).toContain("list_instances");
  });

  it("documents scope awareness", () => {
    expect(prompt()).toContain("working directory");
  });
});
