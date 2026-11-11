/**
 * A Windows native pane agent keeps its own system-prompt dialog (Advanced); the field is the one every agent has, so the native path
 * must still (1) put it into the pane's instructions and (2) refuse to start a pane whose prompt changed while it was starting.
 * Removing either `customPrompt: config.systemPrompt` or `now?.systemPrompt !== config.systemPrompt` in fleet-manager.ts must turn this red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

const roots: string[] = [];
beforeEach(() => { vi.stubEnv("AGEND_WINDOWS_CLI", "1"); vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); });
afterEach(() => { vi.unstubAllEnvs(); for (const dir of roots.splice(0)) { if (!resolve(dir).startsWith(resolve(tmpdir()))) throw Error("Unsafe scratch path"); rmSync(dir, { recursive: true, force: true }); } });

const quiet = () => {};
const AGENT = "12345678-1234-4321-abcd-123456789012";
const native = (extra: Record<string, unknown> = {}) => ({ runtime: "windows", native_adapter: "pane", native_agent_id: AGENT, working_directory: "C:\\work", backend: "codex", model: "gpt-5", ...extra });

async function fleet(instance: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), "agend-native-prompt-")); roots.push(home);
  const fm = new FleetManager(home) as any;
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.fleetConfig = { defaults: {}, instances: { desk: instance } };
  const options = (await fm.nativePanes()).options;
  return { fm, options };
}

describe("a Windows native pane agent and its system prompt", () => {
  it("the pane's instructions carry it, once", async () => {
    const config = native({ systemPrompt: "# Role\n\nYou keep the Windows desk tidy." });
    const { options } = await fleet(config);
    const text: string = options.instructions("desk", config);
    expect(text).toContain("You keep the Windows desk tidy.");
    expect(text.split("You keep the Windows desk tidy.").length - 1).toBe(1);
    expect(text).not.toContain("## Agent Instructions");
    const without = options.instructions("desk", native());
    expect(without).not.toContain("tidy");
  });
  it("a pane whose prompt differs from the fleet's by the time it starts is refused", async () => {
    const config = native({ systemPrompt: "persona A" });
    const { options } = await fleet(config);
    expect(() => options.admit("desk", config)).not.toThrow();                                      // positive control: the same configuration starts
    expect(() => options.admit("desk", { ...config, systemPrompt: "persona B" })).toThrow("Native pane configuration or lifetime changed");
    expect(() => options.admit("desk", { ...config, systemPrompt: undefined })).toThrow("Native pane configuration or lifetime changed");
  });
  it("the other fields of that check still refuse too (the prompt is one of them, not the only one)", async () => {
    const config = native({ systemPrompt: "persona A" });
    const { options } = await fleet(config);
    expect(() => options.admit("desk", { ...config, model: "other" })).toThrow("Native pane configuration or lifetime changed");
    expect(() => options.admit("desk", { ...config, working_directory: "C:\\elsewhere" })).toThrow("Native pane configuration or lifetime changed");
  });
});
