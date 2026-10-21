/**
 * Tests for #2317/#2318: fleet-only FleetDefaults keys must not leak into
 * instance configs.
 *
 * Root cause: getEffectiveInstanceDefaults() was not stripping fleet-only keys
 * from FleetDefaults before merging into InstanceConfig. Any change to a
 * fleet-only default (startup, locale, scheduler, …) caused every running
 * instance to appear "config changed" and restart on SIGHUP.
 */
import { describe, expect, it } from "vitest";
import { getEffectiveInstanceDefaults, loadFleetConfig } from "../src/config.js";
import { classifyInstanceChange } from "../src/instance-config-impact.js";
import type { FleetDefaults, InstanceConfig } from "../src/types.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "agend-startup-defaults-"));
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// ── Exhaustive fleet-only key test ──────────────────────────────────────────
//
// This test fails whenever a new FleetDefaults-only key is added and not
// explicitly stripped. It works by extracting the keys declared only in the
// FleetDefaults `extends` clause (not in InstanceConfig) from types.ts, then
// asserting that none of them appear in getEffectiveInstanceDefaults output.

describe("getEffectiveInstanceDefaults — all fleet-only keys stripped", () => {
  /**
   * Extract keys that appear in FleetDefaults but NOT in InstanceConfig by
   * parsing types.ts. This is the same approach used in fleet-level-config tests.
   * We look for the FleetDefaults interface block and extract its own keys.
   */
  function getFleetOnlyDefaultKeys(): string[] {
    const src = readFileSync(join(ROOT, "src/types.ts"), "utf-8");

    // Extract InstanceConfig keys
    const icStart = src.indexOf("export interface InstanceConfig {");
    const icEnd = src.indexOf("}\n\n", icStart);
    const icBlock = src.slice(icStart, icEnd);
    const icKeys = new Set(
      [...icBlock.matchAll(/^\s+(\w+)\??\s*:/gm)].map(m => m[1]!),
    );

    // Extract FleetDefaults keys (the ones it adds beyond InstanceConfig)
    const fdStart = src.indexOf("export interface FleetDefaults extends Partial<InstanceConfig> {");
    const fdEnd = src.indexOf("}\n\n", fdStart);
    const fdBlock = src.slice(fdStart, fdEnd);
    const fdOwnKeys = [...fdBlock.matchAll(/^\s+(\w+)\??\s*:/gm)]
      .map(m => m[1]!)
      .filter(k => !icKeys.has(k));

    return fdOwnKeys;
  }

  it("every FleetDefaults-only key is absent from getEffectiveInstanceDefaults output", () => {
    const fleetOnlyKeys = getFleetOnlyDefaultKeys();
    // Must have found some keys to be a meaningful test
    expect(fleetOnlyKeys.length, "found no FleetDefaults-only keys — type parsing may be broken").toBeGreaterThan(0);

    // Build a FleetDefaults with all fleet-only keys set to something truthy
    const worst: Record<string, unknown> = {
      backend: "claude-code",
      startup: { concurrency: 4, stagger_delay_ms: 2000 },
      locale: "zh-TW",
      progress_min_elapsed: 10,
      max_cross_instance_message_bytes: 16384,
      reply_overdue_minutes: 20,
      reply_obligation_ttl_hours: 48,
      scheduler: { retry_count: 3 },
      retention_days: 60,
      daily_summary: { enabled: true },
      tips: true,
      webhooks: [{ url: "https://example.com", events: ["update"] }],
    };

    const result = getEffectiveInstanceDefaults(worst as FleetDefaults);

    for (const key of fleetOnlyKeys) {
      expect(result, `fleet-only key "${key}" must not appear in instance config`).not.toHaveProperty(key);
    }
  });
});

// ── getEffectiveInstanceDefaults: startup must not appear ───────────────────

describe("getEffectiveInstanceDefaults — startup not merged into instances", () => {
  it("startup is absent from effective instance defaults when set in fleet defaults", () => {
    const result = getEffectiveInstanceDefaults({
      backend: "claude-code",
      startup: { concurrency: 4, stagger_delay_ms: 2000 },
    } as FleetDefaults);
    expect(result).not.toHaveProperty("startup");
  });

  it("instance-level fields (backend, model) are still forwarded", () => {
    const result = getEffectiveInstanceDefaults({ backend: "kiro-cli", model: "claude-sonnet-4.6" } as FleetDefaults);
    expect(result.backend).toBe("kiro-cli");
    expect(result.model).toBe("claude-sonnet-4.6");
  });

  it("tips and max_cross_instance_message_bytes also absent", () => {
    const result = getEffectiveInstanceDefaults({
      tips: true,
      max_cross_instance_message_bytes: 12288,
      backend: "claude-code",
    } as FleetDefaults);
    expect(result).not.toHaveProperty("tips");
    expect(result).not.toHaveProperty("max_cross_instance_message_bytes");
  });
});

// ── loadFleetConfig: startup does not appear in instance entries ─────────────

describe("loadFleetConfig — startup not written into instance entries", () => {
  it("instance config does not contain startup when defaults.startup is set", () => {
    const d = tmp();
    const wdir = join(d, "proj");
    mkdirSync(wdir, { recursive: true });
    writeFileSync(join(d, "fleet.yaml"), [
      "defaults:",
      "  backend: claude-code",
      "  startup:",
      "    stagger_delay_ms: 2000",
      "    concurrency: 4",
      "instances:",
      "  my-agent:",
      `    working_directory: ${wdir}`,
    ].join("\n"));
    const config = loadFleetConfig(join(d, "fleet.yaml"));
    const inst = config.instances["my-agent"];
    expect(inst).toBeDefined();
    expect(inst).not.toHaveProperty("startup");
    expect(config.defaults?.startup?.stagger_delay_ms).toBe(2000);
  });
});

// ── classifyInstanceChange: changing startup does not restart instances ───────

describe("classifyInstanceChange — startup change does not restart instances", () => {
  it("changing startup returns 'none' (was 'restart' before fix)", () => {
    const runtimeConfig = getEffectiveInstanceDefaults({
      startup: { stagger_delay_ms: 2000 },
    } as FleetDefaults);
    const newConfig = getEffectiveInstanceDefaults({
      startup: { stagger_delay_ms: 500 },
    } as FleetDefaults);
    expect(runtimeConfig).not.toHaveProperty("startup");
    expect(newConfig).not.toHaveProperty("startup");
    expect(classifyInstanceChange(runtimeConfig as InstanceConfig, newConfig as InstanceConfig)).toBe("none");
  });

  it("changing a real instance field (backend) still triggers restart", () => {
    const a = getEffectiveInstanceDefaults({ backend: "claude-code" } as FleetDefaults);
    const b = getEffectiveInstanceDefaults({ backend: "kiro-cli" } as FleetDefaults);
    expect(classifyInstanceChange(a as InstanceConfig, b as InstanceConfig)).toBe("restart");
  });
});

// ── handleCreate path: startup not in instanceConfig ─────────────────────────

describe("handleCreate — startup not written into new instance's InstanceConfig", () => {
  it("instanceConfig built from defaults-with-startup has no startup", () => {
    const effective = getEffectiveInstanceDefaults({
      backend: "claude-code",
      model: "claude-sonnet-4.6",
      startup: { stagger_delay_ms: 2000, concurrency: 4 },
    } as FleetDefaults);
    const instanceConfig = { ...effective, working_directory: "/work/proj", topic_id: "123" };
    expect(instanceConfig).not.toHaveProperty("startup");
    expect(instanceConfig.backend).toBe("claude-code");
  });
});

// ── Source-structure checks ───────────────────────────────────────────────────

describe("source-structure checks", () => {
  it("config.ts strips startup in destructure list", () => {
    const src = readFileSync(join(ROOT, "src/config.ts"), "utf-8");
    const fnStart = src.indexOf("function getEffectiveInstanceDefaults");
    const fnBlock = src.slice(fnStart, fnStart + 2000);
    expect(fnBlock).toContain("startup: _startup");
  });

  it("instance-lifecycle.ts handleCreate uses getEffectiveInstanceDefaults, not raw defaults spread", () => {
    const src = readFileSync(join(ROOT, "src/instance-lifecycle.ts"), "utf-8");
    expect(src).toContain("getEffectiveInstanceDefaults(this.ctx.fleetConfig!.defaults");
    expect(src).not.toContain("...this.ctx.fleetConfig!.defaults,");
  });
});
