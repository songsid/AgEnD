import { describe, expect, it } from "vitest";
import { validateFleetConfig } from "../src/config-validator.js";

describe("validateFleetConfig max_cross_instance_message_bytes", () => {
  it("accepts a positive integer under defaults", () => {
    expect(validateFleetConfig({ defaults: { max_cross_instance_message_bytes: 12_288 }, instances: {} }).errors).toEqual([]);
  });

  it.each([0, -1, 1.5, "16384"])("rejects invalid value %j", value => {
    expect(validateFleetConfig({ defaults: { max_cross_instance_message_bytes: value }, instances: {} }).errors)
      .toContainEqual(expect.objectContaining({ path: "defaults.max_cross_instance_message_bytes" }));
  });
});

describe("validateFleetConfig auto_pause_after", () => {
  const config = (value: unknown, at: "defaults" | "instance") => ({
    defaults: at === "defaults" ? { auto_pause_after: value } : {},
    instances: {
      worker: at === "instance"
        ? { working_directory: "/tmp/worker", auto_pause_after: value }
        : { working_directory: "/tmp/worker" },
    },
  });

  it.each([0, 0.5, 30])("accepts non-negative finite value %s", (value) => {
    expect(validateFleetConfig(config(value, "defaults")).errors).toEqual([]);
    expect(validateFleetConfig(config(value, "instance")).errors).toEqual([]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "10", null])("rejects invalid value %s", (value) => {
    expect(validateFleetConfig(config(value, "defaults")).errors.some(e => e.path === "defaults.auto_pause_after")).toBe(true);
    expect(validateFleetConfig(config(value, "instance")).errors.some(e => e.path === "instances.worker.auto_pause_after")).toBe(true);
  });
});

describe("validateFleetConfig Settings Round 2 fields", () => {
  const base = {
    defaults: {},
    instances: { worker: { working_directory: "/tmp/worker" } },
  };

  it("accepts supported runtime, detection, and startup settings", () => {
    const result = validateFleetConfig({
      ...base,
      defaults: {
        agent_mode: "cli",
        tool_set: "minimal",
        log_level: "trace",
        hang_detector: { enabled: true, timeout_minutes: 8.5 },
        startup: { concurrency: 4, stagger_delay_ms: 250 },
      },
      instances: {
        worker: {
          working_directory: "/tmp/worker",
          agent_mode: "mcp",
          tool_set: "standard",
          log_level: "warn",
          lightweight: true,
          display_name: "Worker",
          model_failover: ["sonnet"],
          hang_detector: { timeout_minutes: 12 },
        },
      },
    });
    expect(result.errors).toEqual([]);
  });

  it.each([
    ["defaults.agent_mode", { agent_mode: "http" }],
    ["defaults.tool_set", { tool_set: "everything" }],
    ["defaults.log_level", { log_level: "verbose" }],
    ["defaults.hang_detector.timeout_minutes", { hang_detector: { timeout_minutes: 0 } }],
    ["defaults.startup.concurrency", { startup: { concurrency: 1.5 } }],
    ["defaults.startup.stagger_delay_ms", { startup: { stagger_delay_ms: -1 } }],
  ])("rejects invalid %s", (path, defaults) => {
    const result = validateFleetConfig({ ...base, defaults });
    expect(result.errors.some(e => e.path === path)).toBe(true);
  });

  it("validates editable channel access mode", () => {
    const result = validateFleetConfig({
      ...base,
      channels: [{ type: "discord", bot_token_env: "TOKEN", access: { mode: "paired", allowed_users: [] } }],
    });
    expect(result.errors.some(e => e.path === "channels[0].access.mode")).toBe(true);
  });

  it("warns when locked channel access has no administrators", () => {
    const result = validateFleetConfig({
      ...base,
      channels: [{ type: "discord", bot_token_env: "TOKEN", access: { mode: "locked", allowed_users: [] } }],
    });
    expect(result.warnings).toContainEqual({
      path: "channels[0].access.allowed_users",
      message: "locked access has no allowed users — add an administrator to avoid lockout",
    });
  });
});

describe("validateFleetConfig kiro_ui", () => {
  const base = {
    instances: { worker: { working_directory: "/tmp/worker", backend: "kiro-cli" } },
  };

  it.each(["legacy", "tui"])("accepts %s for defaults and instances", (kiro_ui) => {
    expect(validateFleetConfig({ ...base, defaults: { kiro_ui } }).errors).toEqual([]);
    expect(validateFleetConfig({
      ...base,
      instances: { worker: { ...base.instances.worker, kiro_ui } },
    }).errors).toEqual([]);
  });

  it("refuses v3, and says why rather than just listing the allowed values", () => {
    // Measured on kiro-cli 2.23.0: --v3 stops at two dialogs AgEnD does not
    // answer, and past them a working instance reads as idle. A value that
    // can be written but cannot start looks like AgEnD is broken, so this
    // fails closed with the reason and the issue to read.
    for (const config of [
      { ...base, defaults: { kiro_ui: "v3" } },
      { ...base, instances: { worker: { ...base.instances.worker, kiro_ui: "v3" } } },
    ]) {
      const result = validateFleetConfig(config);
      const kiroError = result.errors.find(e => e.path.endsWith(".kiro_ui"));
      expect(kiroError, "v3 must not validate").toBeDefined();
      expect(kiroError!.message).toContain("not supported yet");
      expect(kiroError!.message, "the message has to say where to read the detail").toContain("#849");
      expect(kiroError!.message, "and what to write instead").toContain("legacy or tui");
    }
  });

  it("rejects an unknown Kiro UI mode", () => {
    const result = validateFleetConfig({
      ...base,
      instances: { worker: { ...base.instances.worker, kiro_ui: "modern" } },
    });
    expect(result.errors).toContainEqual({
      path: "instances.worker.kiro_ui",
      message: "must be legacy or tui",
    });
  });
});

describe("validateFleetConfig terminal", () => {
  const base = {
    channel: {
      type: "discord",
      mode: "topic",
      bot_token_env: "TOKEN",
      access: { mode: "open", allowed_users: [] },
    },
    instances: { worker: { working_directory: "/tmp/worker" } },
  };

  it("accepts global and per-instance logical sizes", () => {
    expect(validateFleetConfig({
      ...base,
      defaults: { terminal: { enabled: true, columns: 120, rows: 36 } },
      instances: {
        worker: {
          working_directory: "/tmp/worker",
          terminal: { enabled: false, columns: 80, rows: 24 },
        },
      },
    }).errors).toEqual([]);
  });

  it.each([
    [{ columns: 79 }, "defaults.terminal.columns"],
    [{ columns: 301 }, "defaults.terminal.columns"],
    [{ columns: 120.5 }, "defaults.terminal.columns"],
    [{ rows: 23 }, "defaults.terminal.rows"],
    [{ rows: 121 }, "defaults.terminal.rows"],
    [{ enabled: "yes" }, "defaults.terminal.enabled"],
  ])("rejects invalid terminal config %j", (terminal, path) => {
    expect(validateFleetConfig({ ...base, defaults: { terminal } }).errors)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
  });
});

describe("validateFleetConfig context_guardian no-op fields (#1296)", () => {
  const base = {
    defaults: {},
    instances: { worker: { working_directory: "/tmp/worker" } },
  };

  it("warns on max_age_hours and grace_period_ms under defaults (raw user config)", () => {
    const result = validateFleetConfig({
      ...base,
      defaults: { context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 } },
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.some(w => w.path === "defaults.context_guardian.max_age_hours")).toBe(true);
    expect(result.warnings.some(w => w.path === "defaults.context_guardian.grace_period_ms")).toBe(true);
  });

  it("warns when max_age_hours is set on an instance (raw user config)", () => {
    const result = validateFleetConfig({
      defaults: {},
      instances: {
        worker: { working_directory: "/tmp/worker", context_guardian: { max_age_hours: 2 } },
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.some(w => w.path === "instances.worker.context_guardian.max_age_hours")).toBe(true);
  });

  it("does not warn when context_guardian is absent", () => {
    const result = validateFleetConfig(base);
    expect(result.warnings.some(w => w.path.includes("context_guardian"))).toBe(false);
  });

  it("loadFleetConfig expansion + Settings save path: no spurious context_guardian warnings", async () => {
    // Regression for P2: Settings validates ctx.fleetConfig (already expanded by
    // loadFleetConfig). An unrelated log_level edit must produce zero context_guardian
    // warnings even though every instance has context_guardian:{} in defaults.
    const { loadFleetConfig } = await import("../src/config.js");
    const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = join(tmpdir(), `agend-cg-regression-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      // A minimal fleet.yaml — no context_guardian keys anywhere.
      writeFileSync(join(dir, "fleet.yaml"),
        "defaults:\n  log_level: info\ninstances:\n  w:\n    working_directory: /tmp\n",
      );
      const expanded = loadFleetConfig(join(dir, "fleet.yaml"));

      // Simulate a Settings PUT /defaults with only log_level changed.
      const before = validateFleetConfig(expanded);
      const after = validateFleetConfig({ ...expanded, defaults: { ...expanded.defaults, log_level: "warn" as const } });

      expect(before.warnings.some(w => w.path.includes("context_guardian")), "before: no spurious warning").toBe(false);
      expect(after.warnings.some(w => w.path.includes("context_guardian")), "after: no spurious warning on log_level edit").toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
