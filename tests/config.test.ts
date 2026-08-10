import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadFleetConfig } from "../src/config.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAgendHome } from "../src/paths.js";

describe("loadFleetConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-fleet-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads fleet.yaml with defaults merged into instances", () => {
    const fleetPath = join(tmpDir, "fleet.yaml");
    writeFileSync(
      fleetPath,
      `channel:
  type: telegram
  mode: dm
  bot_token_env: BOT_TOKEN
  access:
    mode: pairing
    allowed_users: []
    max_pending_codes: 5
    code_expiry_minutes: 10
defaults:
  restart_policy:
    max_retries: 3
    backoff: linear
    reset_after: 60
  log_level: debug
instances:
  mybot:
    working_directory: /home/user/mybot
    topic_id: 42
    context_guardian:
      threshold_percentage: 90
      max_idle_wait_ms: 300000
      completion_timeout_ms: 60000
      grace_period_ms: 600000
      max_age_hours: 2
`
    );
    const fleet = loadFleetConfig(fleetPath);

    // restart_policy from defaults should be merged in
    expect(fleet.instances.mybot.restart_policy.max_retries).toBe(3);
    expect(fleet.instances.mybot.restart_policy.backoff).toBe("linear");

    // context_guardian from instance overrides defaults
    expect(fleet.instances.mybot.context_guardian.threshold_percentage).toBe(90);
    expect(fleet.instances.mybot.context_guardian.max_idle_wait_ms).toBe(300000);

    // topic_id preserved
    expect(fleet.instances.mybot.topic_id).toBe(42);

    // top-level channel present
    expect(fleet.channel).toBeDefined();
    expect(fleet.channel!.type).toBe("telegram");
    expect(fleet.channel!.mode).toBe("dm");
  });

  it("validates required fields", () => {
    const fleetPath = join(tmpDir, "fleet.yaml");
    writeFileSync(
      fleetPath,
      `defaults: {}
instances:
  badbot:
    log_level: info
`
    );
    const fleet = loadFleetConfig(fleetPath);
    const expectedDir = join(getAgendHome(), "workspaces", "badbot");
    expect(fleet.instances["badbot"].working_directory).toBe(expectedDir);
    expect(existsSync(expectedDir)).toBe(true);
  });

  it("defaults Kiro UI to legacy and supports per-instance TUI/v3 overrides", () => {
    const fleetPath = join(tmpDir, "fleet.yaml");
    writeFileSync(fleetPath, `instances:
  legacy:
    working_directory: /tmp/kiro-legacy
    backend: kiro-cli
  tui:
    working_directory: /tmp/kiro-tui
    backend: kiro-cli
    kiro_ui: tui
  v3:
    working_directory: /tmp/kiro-v3
    backend: kiro-cli
    kiro_ui: v3
`);

    const fleet = loadFleetConfig(fleetPath);
    expect(fleet.instances.legacy.kiro_ui).toBe("legacy");
    expect(fleet.instances.tui.kiro_ui).toBe("tui");
    expect(fleet.instances.v3.kiro_ui).toBe("v3");
  });

  it("defaults terminal to 120x36 and deep-merges per-instance overrides", () => {
    const fleetPath = join(tmpDir, "fleet.yaml");
    writeFileSync(fleetPath, `defaults:
  terminal:
    columns: 132
instances:
  inherited:
    working_directory: /tmp/tmux-inherited
  custom:
    working_directory: /tmp/tmux-custom
    terminal:
      rows: 40
  legacy:
    working_directory: /tmp/tmux-legacy
    terminal:
      enabled: false
`);

    const fleet = loadFleetConfig(fleetPath);
    expect(fleet.instances.inherited.terminal).toEqual({
      enabled: true,
      columns: 132,
      rows: 36,
    });
    expect(fleet.instances.custom.terminal).toEqual({
      enabled: true,
      columns: 132,
      rows: 40,
    });
    expect(fleet.instances.legacy.terminal).toEqual({
      enabled: false,
      columns: 132,
      rows: 36,
    });
  });

  it("leaves auto-pause disabled unless opted into", () => {
    // Auto-pause shipped defaulting to 30 minutes and was reverted to opt-in
    // (0 = disabled) — see DEFAULT_INSTANCE_CONFIG in src/config.ts, matched by
    // the daemon's own fallback. This assertion tracked the reverted value.
    const fleetPath = join(tmpDir, "fleet.yaml");
    writeFileSync(fleetPath, `instances:
  default-pause:
    working_directory: /tmp/default-pause
  opted-in:
    working_directory: /tmp/opted-in
    auto_pause_after: 45
`);

    const fleet = loadFleetConfig(fleetPath);
    expect(fleet.instances["default-pause"].auto_pause_after).toBe(0);
    expect(fleet.instances["opted-in"].auto_pause_after).toBe(45);
  });

  it("returns empty instances when no fleet.yaml exists", () => {
    const fleet = loadFleetConfig(join(tmpDir, "nonexistent-fleet.yaml"));
    expect(fleet.instances).toEqual({});
    expect(fleet.defaults).toEqual({});
  });

  it("deep-merges backend_options from defaults into instances", () => {
    const fleetPath = join(tmpDir, "fleet.yaml");
    writeFileSync(
      fleetPath,
      `defaults:
  backend_options:
    codex:
      provider: openai
instances:
  glm-coder:
    working_directory: /home/user/glm-coder
    backend: codex
    backend_options:
      codex:
        provider: glm
`
    );
    const fleet = loadFleetConfig(fleetPath);
    expect(fleet.defaults.backend_options?.codex.provider).toBe("openai");
    expect(fleet.instances["glm-coder"].backend_options?.codex.provider).toBe("glm");
  });

  it("preserves default backend_options when instance does not override", () => {
    const fleetPath = join(tmpDir, "fleet.yaml");
    writeFileSync(
      fleetPath,
      `defaults:
  backend_options:
    codex:
      provider: openai
instances:
  default-coder:
    working_directory: /home/user/default-coder
    backend: codex
`
    );
    const fleet = loadFleetConfig(fleetPath);
    expect(fleet.instances["default-coder"].backend_options?.codex.provider).toBe("openai");
  });
});

describe("validateFleetConfig — backend_options", () => {
  it("passes for valid provider", () => {
    const result = validateFleetConfig({
      defaults: {},
      instances: {
        "glm-coder": {
          working_directory: "/tmp",
          backend: "codex",
          backend_options: { codex: { provider: "glm" } },
        } as any,
      },
    });
    expect(result.errors).toEqual([]);
  });

  it("errors on invalid provider characters", () => {
    const result = validateFleetConfig({
      defaults: {},
      instances: {
        "bad-coder": {
          working_directory: "/tmp",
          backend: "codex",
          backend_options: { codex: { provider: "bad provider!" } },
        } as any,
      },
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toContain("Invalid provider name");
    expect(result.errors[0].message).toContain("bad provider!");
  });

  it("errors on non-string provider", () => {
    const result = validateFleetConfig({
      defaults: {},
      instances: {
        "bad-coder": {
          working_directory: "/tmp",
          backend: "codex",
          backend_options: { codex: { provider: 123 } },
        } as any,
      },
    });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].message).toContain("must be a string");
  });

  it("warns on unknown backend namespace", () => {
    const result = validateFleetConfig({
      defaults: {},
      instances: {
        "test": {
          working_directory: "/tmp",
          backend_options: { unknown_backend: { foo: "bar" } },
        } as any,
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContainEqual({
      path: "instances.test.backend_options.unknown_backend",
      message: "unknown backend namespace — option will be ignored",
    });
  });
});
