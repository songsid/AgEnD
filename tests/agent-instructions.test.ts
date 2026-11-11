// Agent instructions are the agent's `systemPrompt`, promoted: one field (same key, same place in what the AI is told), a better editor
// (tests/agent-instructions-ui.test.ts), and a confirmation card that shows a long text by its length, fingerprint and first words.
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { buildFleetInstructions, buildNativeFleetInstructions } from "../src/instructions.js";
import { settingsChangeDiff, SETTINGS_DIFF_UNITS } from "../src/settings-change.js";
import { instanceFieldImpact } from "../src/instance-config-impact.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { Daemon } from "../src/daemon.js";
import { createBackend } from "../src/backend/factory.js";
import { KiroBackend } from "../src/backend/kiro.js";
import { TEST_KIRO_COMPAT } from "./helpers/kiro-compat.js";
import type { InstanceConfig } from "../src/types.js";
import type { Logger } from "../src/logger.js";
import { matrixCases } from "./helpers/instructions-matrix.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
// Recorded from the instructions code before this change (`release/2.3.5-alpha` at 861ca2ac4): see helpers/instructions-matrix-record.ts.
const GOLDEN: Record<string, string> = JSON.parse(readFileSync(new URL("./fixtures/instructions-matrix.json", import.meta.url), "utf8"));

describe("what an agent is told has not changed", () => {
  const cases = matrixCases();
  it("covers the whole parameter grid, for the fleet and the Windows native builders (systemPrompt is one of its axes)", () => {
    expect(cases.length).toBe(576);
    expect(Object.keys(GOLDEN).length).toBe(cases.length * 3);
    expect(new Set(cases.map(c => c.params.customPrompt)).size).toBe(2);
  });
  it("is word for word what it was before, for every combination (fleet and Windows native)", () => {
    let checked = 0;
    for (const { key, params } of cases) {
      expect(sha(buildFleetInstructions(params)), `fleet|${key}`).toBe(GOLDEN[`fleet|${key}`]);
      expect(sha(buildNativeFleetInstructions(params, false)), `native|${key}`).toBe(GOLDEN[`native|${key}`]);
      expect(sha(buildNativeFleetInstructions(params, true)), `native-general|${key}`).toBe(GOLDEN[`native-general|${key}`]);
      checked += 3;
    }
    expect(checked).toBe(cases.length * 3);
  });
  it("there is no second field: a builder asked for an `agentInstructions` section does not know one (nothing is injected for it)", () => {
    const text = buildFleetInstructions({ instanceName: "a", workingDirectory: "/w", customPrompt: "PERSONA", ...({ agentInstructions: "OWN" } as object) });
    expect(text).not.toContain("OWN");
    expect(text).not.toContain("## Agent Instructions");
    expect(text).toContain("PERSONA");
  });
  it("is a restart-class setting, as it was", () => {
    expect(instanceFieldImpact("systemPrompt")).not.toBe("now");
  });
});

describe("every runtime hands the AI the systemPrompt, inline or from a file, where it always did", () => {
  const BACKENDS = ["claude-code", "codex", "opencode", "kiro-cli", "antigravity", "grok", "muse"] as const;
  const cfg = (extra: Partial<InstanceConfig> = {}, backend?: string): InstanceConfig => ({
    working_directory: "/tmp/test", restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 }, log_level: "info", ...(backend ? { backend } : {}), ...extra,
  } as InstanceConfig);
  const spawnText = (backend: string, extra: Partial<InstanceConfig>, mode?: "cli", workDir?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "agend-instr-"));
    try {
      const daemon = new Daemon("w", cfg({ ...extra, ...(mode ? { agent_mode: mode } : {}), ...(workDir ? { working_directory: workDir } : {}) }, backend), dir, false, backend === "kiro-cli" ? new KiroBackend(dir, TEST_KIRO_COMPAT) : createBackend(backend, dir), undefined, pino({ level: "silent" }) as Logger);
      return (daemon as any).buildBackendConfig().instructions as string;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const PROMPT = "# Role\n\nYou review pull requests.\n\n- Be kind\n- Be exact\n";

  it.each(BACKENDS.flatMap(b => [[b, undefined], [b, "cli" as const]] as const))("%s (%s mode): the text is in the instructions once, and a second section is not added", (backend, mode) => {
    const bare = spawnText(backend, {}, mode);
    const withPrompt = spawnText(backend, { systemPrompt: PROMPT }, mode);
    expect(bare).not.toContain("You review pull requests.");
    expect(withPrompt.split(PROMPT.trimEnd()).length - 1).toBe(1);
    expect(withPrompt).not.toContain("## Agent Instructions");
  });

  it("a file: reference is read when the agent starts, relative to its working directory", () => {
    const work = mkdtempSync(join(tmpdir(), "agend-instr-wd-"));
    try {
      mkdirSync(join(work, "prompts"));
      writeFileSync(join(work, "prompts", "dev.md"), "FROM-A-FILE-7413");
      const text = spawnText("claude-code", { systemPrompt: "file:prompts/dev.md" }, undefined, work);
      expect(text).toContain("FROM-A-FILE-7413");
      expect(text).not.toContain("file:prompts/dev.md");
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
});

describe("the confirmation of a systemPrompt (the web Save)", () => {
  const effect = (systemPrompt: string | undefined) => ({ fleet: { instances: { dev: { working_directory: "/w", ...(systemPrompt === undefined ? {} : { systemPrompt }) } } } });
  const long = "A".repeat(20_000) + "\n" + "Z".repeat(4_000);

  it("a long text shows length, fingerprint and the first words — it does not exceed the card (confirmation_diff_too_large) at 24,000 characters", () => {
    expect(long.length).toBeGreaterThan(SETTINGS_DIFF_UNITS);
    const diff = settingsChangeDiff(effect(undefined), effect(long), { operation: "PATCH /api/settings/fleet/instances/dev" });
    expect(diff).not.toBeNull();
    const line = diff!.summary.find(l => l.includes("systemPrompt"))!;
    expect(line).toContain("24001");
    expect(line).toMatch(/[0-9a-f]{12}/);
    expect(line).toContain("AAAA");
    expect(line.length).toBeLessThan(400);
    expect(diff!.summary.join("\n").length).toBeLessThan(SETTINGS_DIFF_UNITS);
  });
  it("a one-character change is a different fingerprint and a different change", () => {
    const a = settingsChangeDiff(effect(long), effect(long + "!"), { operation: "PATCH x" })!;
    const b = settingsChangeDiff(effect(long), effect(long + "?"), { operation: "PATCH x" })!;
    expect(a.summary.join()).not.toBe(b.summary.join());
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
  it("removing a long one is shown too, and the same text is no change", () => {
    const removed = settingsChangeDiff(effect(long), effect(undefined), { operation: "PATCH x" })!;
    expect(removed.summary.join("\n")).toMatch(/systemPrompt.*24001.*→/);
    expect(settingsChangeDiff(effect(long), effect(long), { operation: "PATCH x" })).toBeNull();
  });
  it("a short text or a file: reference is listed whole, as it always was", () => {
    for (const [from, to] of [["old", "new prompt"], ["file:prompts/dev.md", "file:prompts/dev.md, file:rules.md"], [undefined, "Be terse."]] as const) {
      const diff = settingsChangeDiff(effect(from), effect(to), { operation: "PATCH x" })!;
      expect(diff.summary.join("\n")).toContain(to);
      expect(diff.summary.join("\n")).not.toMatch(/fingerprint|指紋/);
    }
  });
  it("the authority classifier (it judges the same change from `instances.<name>`, not from `fleet`) lists it just as shortly", async () => {
    const { settingsEffectAuthority } = await import("../src/settings-authority.js");
    const inst = (systemPrompt?: string) => ({ working_directory: "/w", ...(systemPrompt === undefined ? {} : { systemPrompt }) });
    const cfg = (systemPrompt?: string) => ({ defaults: {}, instances: { dev: inst(systemPrompt) } }) as never;
    expect(() => settingsEffectAuthority(cfg(), cfg(long), {}, {})).not.toThrow();
    expect(() => settingsEffectAuthority(cfg(long), cfg(long + "!"), {}, {})).not.toThrow();
    const diff = settingsChangeDiff({ instances: { dev: inst() } }, { instances: { dev: inst(long) } }, { operation: "authority" })!;
    expect(diff.summary.join("\n").length).toBeLessThan(400);
  });
});

describe("saving it through the Settings API", () => {
  function patch(body: unknown): Promise<{ status: number; body: Record<string, unknown>; saved: ReturnType<typeof vi.fn> }> {
    const saved = vi.fn();
    const ctx = { fleetConfig: { defaults: {}, instances: { worker: { working_directory: "/tmp/worker", systemPrompt: "persona" } } }, configPath: "/tmp/fleet.yaml", dataDir: "/tmp",
      logger: { warn: vi.fn(), info: vi.fn() }, getRawFleetConfig: () => ({}), saveFleetConfig: saved, lifecycle: { isPaused: vi.fn(() => false) } } as unknown as SettingsApiContext;
    return new Promise((resolve, reject) => {
      const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
      req.method = "PATCH"; req.destroy = () => undefined;
      let status = 0;
      const res = { writeHead(code: number) { status = code; }, end(payload: string) { resolve({ status, body: JSON.parse(payload), saved }); } };
      try {
        handleSettingsRequest(req as never, res as never, new URL("http://localhost/api/settings/fleet/instances/worker"), ctx);
        queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
      } catch (err) { reject(err); }
    });
  }
  it("writes the text under `systemPrompt` and nothing else", async () => {
    const r = await patch({ systemPrompt: "# Role\n\nBe exact.\n" });
    expect(r.status).toBe(200);
    expect(r.saved).toHaveBeenCalledWith([{ path: ["instances", "worker", "systemPrompt"], value: "# Role\n\nBe exact.\n", remove: false }]);
  });
  it("accepts a file: reference", async () => {
    const r = await patch({ systemPrompt: "file:prompts/dev.md" });
    expect(r.status).toBe(200);
    expect(r.saved).toHaveBeenCalledWith([{ path: ["instances", "worker", "systemPrompt"], value: "file:prompts/dev.md", remove: false }]);
  });
  it("fleet.yaml validation is the same for a long systemPrompt as before (the editor's 24,000 is the page's limit, not a new rule for existing files)", () => {
    const problems = (v: string) => validateFleetConfig({ instances: { a: { working_directory: "/w", systemPrompt: v } } }).errors.filter(e => e.path.endsWith("systemPrompt"));
    expect(problems("x".repeat(30_000))).toEqual([]);
  });
});
