import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "../src/daemon.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import {
  buildSettingsImpactSchema,
  CLASSIC_HOT_CONFIG_KEYS,
  HOT_INSTANCE_CONFIG_KEYS,
  batchImpact,
  classicFieldImpact,
  instanceFieldImpact,
} from "../src/instance-config-impact.js";
import type { InstanceConfig } from "../src/types.js";

const dirs: string[] = [];

/**
 * Top-level property names of an interface in src/types.ts.
 *
 * TypeScript types are gone at runtime, so the alternative is a hand-kept list —
 * which would silently stop covering the field someone adds tomorrow, i.e. the
 * exact drift this file exists to catch.
 */
function interfaceKeys(source: string, name: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const start = withoutComments.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`interface ${name} not found`);
  let depth = 0;
  let end = start;
  for (let i = withoutComments.indexOf("{", start); i < withoutComments.length; i++) {
    if (withoutComments[i] === "{") depth++;
    else if (withoutComments[i] === "}" && --depth === 0) { end = i; break; }
  }
  const body = withoutComments.slice(withoutComments.indexOf("{", start) + 1, end);

  const keys: string[] = [];
  let nesting = 0;
  for (const line of body.split("\n")) {
    const match = nesting === 0 ? line.match(/^\s*([A-Za-z_$][\w$]*)\??\s*:/) : null;
    if (match) keys.push(match[1]!);
    for (const ch of line) {
      if (ch === "{" || ch === "[") nesting++;
      else if (ch === "}" || ch === "]") nesting--;
    }
  }
  return keys;
}

function instanceConfigKeys(): string[] {
  const types = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "types.ts"),
    "utf8",
  );
  return interfaceKeys(types, "InstanceConfig");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDaemon() {
  const instanceDir = mkdtempSync(join(tmpdir(), "agend-parity-"));
  dirs.push(instanceDir);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: "info" };
  return new Daemon("parity", {
    working_directory: "/tmp",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as unknown as InstanceConfig, instanceDir, false, { binaryName: "claude" } as never, undefined,
    { child: () => logger } as never);
}

/**
 * One representative value per hot key. A key added to HOT_INSTANCE_CONFIG_KEYS
 * without an entry here fails the first assertion below — which is the point:
 * whoever widens the hot set has to say what a hot update of it looks like.
 */
const HOT_KEY_PROBES: Record<string, unknown> = {
  tool_progress: "verbose",
  reply_completion_guard: false,
  mcp_proxy_reply: true,
  auto_pause_after: 4,
  warm_cap: 7,
  display_name: "Sentinel",
  description: "runtime hot",
  tags: ["one", "two"],
  log_level: "debug",
};

describe("hot/cold parity between the fleet's hot set and the daemon", () => {
  it("applies every key the fleet calls hot to the live daemon", () => {
    for (const key of HOT_INSTANCE_CONFIG_KEYS) {
      expect(
        Object.prototype.hasOwnProperty.call(HOT_KEY_PROBES, key),
        `HOT_INSTANCE_CONFIG_KEYS contains "${key}" but this test has no probe value for it`,
      ).toBe(true);

      const daemon = makeDaemon();
      daemon.applyConfigUpdate({ [key]: HOT_KEY_PROBES[key] });

      expect(
        daemon.getConfigSnapshot()[key],
        `Daemon.applyConfigUpdate ignores "${key}", so a Settings edit of it is reported as applied and silently dropped`,
      ).toEqual(HOT_KEY_PROBES[key]);
    }
  });

  it("ignores cold keys arriving on the same channel", () => {
    // The per-instance socket is reachable by the instance itself; a cold key
    // accepted here would let it rewrite its own process settings.
    const cold: Record<string, unknown> = {
      backend: "kiro-cli",
      model: "opus",
      working_directory: "/etc",
      tool_set: "minimal",
      agent_mode: "cli",
    };
    const daemon = makeDaemon();
    const before = daemon.getConfigSnapshot();

    daemon.applyConfigUpdate(cold);

    const after = daemon.getConfigSnapshot();
    for (const key of Object.keys(cold)) {
      expect(after[key as keyof InstanceConfig]).toEqual(before[key as keyof InstanceConfig]);
    }
  });

  it("accepts nothing outside the hot set, across the whole config type", () => {
    // The forward direction above proves HOT ⊆ accepted. This is the reverse,
    // read off InstanceConfig itself rather than a list kept by hand, so a field
    // added to the type is covered the day it lands.
    const declared = instanceConfigKeys();
    // A parser that stopped seeing the real interface would leave this loop
    // vacuous, so prove it found the whole thing before trusting the subset.
    for (const key of HOT_INSTANCE_CONFIG_KEYS) expect(declared, "parsed InstanceConfig").toContain(key);
    const cold = declared.filter(key => !HOT_INSTANCE_CONFIG_KEYS.has(key as keyof InstanceConfig));
    expect(cold.length).toBeGreaterThan(20);
    expect(cold).toContain("backend");
    expect(cold).not.toContain("tool_progress");

    const daemon = makeDaemon();
    const config = (daemon as unknown as { config: Record<string, unknown> }).config;

    for (const key of cold) {
      // Seed a sentinel so a deletion is as visible as an assignment.
      config[key] = `sentinel:${key}`;
      const before = daemon.getConfigSnapshot();

      // Every shape a check might accidentally admit, including the null that
      // removes a hot value.
      for (const probe of ["hijacked", 99, true, false, ["hijacked"], { hijacked: true }, null]) {
        daemon.applyConfigUpdate({ [key]: probe });
        expect(
          daemon.getConfigSnapshot(),
          `Daemon.applyConfigUpdate took "${key}" (${JSON.stringify(probe)}), which the fleet treats as cold — the per-instance socket must not reach it`,
        ).toEqual(before);
      }
    }
  });

  it("removes a hot value when the update carries null", () => {
    const daemon = makeDaemon();
    daemon.applyConfigUpdate({ display_name: "Sentinel", tags: ["x"] });
    expect(daemon.getConfigSnapshot().display_name).toBe("Sentinel");

    daemon.applyConfigUpdate({ display_name: null, tags: null });

    expect(daemon.getConfigSnapshot().display_name).toBeUndefined();
    expect(daemon.getConfigSnapshot().tags).toBeUndefined();
  });
});

describe("the classic hot set is derived, not re-listed", () => {
  it("is a subset of the fleet-wide hot set", () => {
    expect(CLASSIC_HOT_CONFIG_KEYS.size).toBeGreaterThan(0);
    for (const key of CLASSIC_HOT_CONFIG_KEYS) {
      expect(HOT_INSTANCE_CONFIG_KEYS.has(key as keyof InstanceConfig)).toBe(true);
    }
  });

  it("matches exactly what the classic hot payload can carry", async () => {
    // classicBehaviorUpdate() is what a classic hot reload actually sends; a key
    // outside it would be reported as hot and never reach the daemon.
    const { FleetManager } = await import("../src/fleet-manager.js");
    const dir = mkdtempSync(join(tmpdir(), "agend-parity-fm-"));
    dirs.push(dir);
    const fm = new FleetManager(dir);
    (fm as unknown as { classicChannels: unknown }).classicChannels = {
      getToolProgressByInstance: () => "standard",
      getReplyCompletionGuardByInstance: () => true,
    };

    const payload = (fm as unknown as {
      classicBehaviorUpdate(name: string): Record<string, unknown>;
    }).classicBehaviorUpdate("classic-one");

    expect(new Set(Object.keys(payload))).toEqual(new Set(CLASSIC_HOT_CONFIG_KEYS));
  });
});

describe("settings impact schema", () => {
  const schema = buildSettingsImpactSchema();

  it("marks every hot key as immediate and no cold instance key as immediate", () => {
    for (const key of HOT_INSTANCE_CONFIG_KEYS) {
      expect(schema.impacts[`instance.${key}`], `instance.${key}`).toBe("now");
    }
    for (const [path, impact] of Object.entries(schema.impacts)) {
      if (!path.startsWith("instance.") || impact !== "now") continue;
      const key = path.slice("instance.".length);
      expect(HOT_INSTANCE_CONFIG_KEYS.has(key as keyof InstanceConfig), path).toBe(true);
    }
  });

  it("keeps a classic auto_pause_after cold even though the fleet calls it hot", () => {
    // The classic hot payload cannot carry it, so promising "applied now" would
    // be a lie the user only discovers when the setting does nothing.
    expect(HOT_INSTANCE_CONFIG_KEYS.has("auto_pause_after")).toBe(true);
    expect(instanceFieldImpact("auto_pause_after")).toBe("now");
    expect(classicFieldImpact("auto_pause_after")).toBe("instance");
    expect(schema.impacts["classic.auto_pause_after"]).toBe("instance");
  });

  it("treats binding keys as fleet-level even though they sit on an instance", () => {
    expect(schema.impacts["instance.topic_id"]).toBe("fleet");
    expect(schema.impacts["instance.general_topic"]).toBe("fleet");
    // ...and never offers them as a fleet default.
    expect(schema.impacts["defaults.topic_id"]).toBeUndefined();
  });

  it("ships the escalation order so the page does not encode the rule", () => {
    expect(schema.order).toEqual(["now", "instance", "fleet"]);
  });

  it("escalates a batch to its most disruptive member", () => {
    const of = (key: string) => instanceFieldImpact(key);
    expect(batchImpact(["display_name", "tags"], of)).toBe("now");
    expect(batchImpact(["display_name", "backend"], of)).toBe("instance");
    expect(batchImpact(["display_name", "topic_id"], of)).toBe("fleet");
    expect(batchImpact([], of)).toBe("now");
  });
});

describe("GET /api/settings/schema", () => {
  function request(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = { method: "GET", destroy: () => undefined };
      let status = 0;
      const res = {
        writeHead(code: number) { status = code; },
        end(payload: string) { resolve({ status, body: JSON.parse(payload) as Record<string, unknown> }); },
      };
      try {
        expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), context())).toBe(true);
      } catch (err) { reject(err); }
    });
  }

  function context(): SettingsApiContext {
    return {
      fleetConfig: { defaults: {}, instances: {} },
      configPath: "/tmp/fleet.yaml",
      dataDir: "/tmp",
      logger: { warn: vi.fn(), info: vi.fn() },
      getRawFleetConfig: () => ({}),
      saveFleetConfig: vi.fn(),
      lifecycle: { isPaused: vi.fn(() => false), pause: vi.fn(), wake: vi.fn() },
    } as unknown as SettingsApiContext;
  }

  it("serves the derived impact map", async () => {
    const res = await request("/api/settings/schema");

    expect(res.status).toBe(200);
    const impacts = (res.body as { impacts: Record<string, string> }).impacts;
    expect(impacts["instance.tool_progress"]).toBe("now");
    expect(impacts["instance.backend"]).toBe("instance");
    expect(impacts["classic.auto_pause_after"]).toBe("instance");
    expect(impacts["fleet.spawn_concurrency"]).toBe("fleet");
  });

  it("follows the hot set rather than a table of its own", () => {
    // Shrinking the authority has to shrink the served schema, or the page keeps
    // promising "applied immediately" for a key that now needs a restart.
    const hot = buildSettingsImpactSchema().impacts["instance.warm_cap"];
    expect(hot).toBe("now");
    expect(HOT_INSTANCE_CONFIG_KEYS.has("warm_cap")).toBe(true);
  });
});

describe("the settings page reads impacts instead of hard-coding them", () => {
  const html = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "settings.html"),
    "utf8",
  );
  const schema = buildSettingsImpactSchema();

  it("asks for a field path the server actually publishes", () => {
    const paths = [...html.matchAll(/impact(?:Of)?\("([^"]+)"\)/g)].map(m => m[1]!);
    expect(paths.length).toBeGreaterThan(40);
    for (const path of paths) {
      expect(schema.impacts, `settings.html asks for "${path}"`).toHaveProperty(path);
    }
  });

  it("carries no hard-coded impact kind and no copy of the hot set", () => {
    expect(html).not.toMatch(/impact\("(now|instance|fleet)"\)/);
    expect(html).not.toMatch(/impact:\s*"(now|instance|fleet)"/);
    expect(html).not.toContain("HOT_FIELDS");
    // The two classic hot-only checks used to name the fields inline.
    expect(html).not.toMatch(/key === "tool_progress" \|\| key === "reply_completion_guard"/);
  });

  it("loads the schema before rendering", () => {
    expect(html).toContain('api("/api/settings/schema")');
  });

  it("costs a batch with the order the server ships, not one of its own", () => {
    expect(html).toContain("const order = state.schema.order;");
    expect(html).not.toMatch(/=== "fleet" \? "fleet" : "instance"/);
  });

  it("classifies every key a classic patch can carry", () => {
    // Keys the classic editor sends; one missing from the schema would fall back
    // to "restart" and quietly stop reporting a hot reload as hot.
    for (const key of ["backend", "model", "auto_pause_after", "tool_progress", "reply_completion_guard", "collab", "context_lines"]) {
      expect(schema.impacts, key).toHaveProperty(`classic.${key}`);
    }
  });
});

describe("no consumer keeps its own copy of the hot sets", () => {
  const read = (file: string) => readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", file),
    "utf8",
  );

  it.each([
    ["settings-api.ts"],
    ["fleet-manager.ts"],
  ])("%s derives the classic hot check instead of naming the fields", file => {
    const src = read(file);

    expect(src).toContain("CLASSIC_HOT_CONFIG_KEYS");
    // `field === "tool_progress" || field === "reply_completion_guard"` and any
    // other inline enumeration of the hot field names in a comparison.
    expect(src).not.toMatch(/===\s*"(tool_progress|reply_completion_guard)"\s*\|\|/);
  });

  it("fleet-manager no longer declares the hot set itself", () => {
    const src = read("fleet-manager.ts");

    expect(src).not.toMatch(/const HOT_INSTANCE_CONFIG_KEYS\s*=/);
    expect(src).toContain('from "./instance-config-impact.js"');
  });
});
