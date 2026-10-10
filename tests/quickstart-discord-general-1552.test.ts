/**
 * Discord general_channel_id location fix (#1552):
 * - planQuickstart must write general_channel_id under options (not top-level)
 * - discordGeneralChannelId reads options first, falls back to legacy top-level
 *
 * Call-site witnesses (P2-2):
 *   W1: topic-commands autoCreateTopics General binding (legacy top-level)
 *   W2: fleet-manager listSecureConnections (legacy top-level)
 * Each witness fails if the call site falls back to options-only.
 *
 * Reverse mutations:
 *   M1 (planQuickstart): channel.general_channel_id = ... instead of options → test 1 fails
 *   M2 (helper): remove legacy fallback → tests 3,4 fail
 *   M3 (topic-commands): ch?.options?.general_channel_id instead of helper → W1 fails
 *   M4 (fleet-manager listSecureConnections): options-only read → W2 fails
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir, join } from "node:path";
import { tmpdir as _td } from "node:os";
import { join as _join } from "node:path";
import { planQuickstart } from "../src/quickstart-api.js";
import { discordGeneralChannelId } from "../src/discord-general.js";

const DISCORD_BASE = {
  platform: "discord" as const,
  token_env: "AGEND_DISCORD_TOKEN",
  backend: "claude-code" as const,
  working_directory: "/tmp/app",
  instance_name: "general",
  guild_id: "123456789012345678",
  admin_user_id: "987654321012345678",
};
const ENV = { backends: ["claude-code"], channels: [], has_fleet: false };

describe("planQuickstart: Discord general_channel_id goes under options (#1552)", () => {
  it("writes general_channel_id under channel.options (not top-level)", () => {
    const plan = planQuickstart({ ...DISCORD_BASE, general_channel_id: "111222333444555666" }, ENV);
    // M1: if written top-level, options.general_channel_id is undefined → this fails
    expect((plan.channel as any).options?.general_channel_id).toBe("111222333444555666");
    expect((plan.channel as any).general_channel_id).toBeUndefined();
  });

  it("no general_channel_id: no phantom field", () => {
    const plan = planQuickstart({ ...DISCORD_BASE }, ENV);
    expect((plan.channel as any).general_channel_id).toBeUndefined();
    expect((plan.channel as any).options?.general_channel_id).toBeUndefined();
  });
});

describe("discordGeneralChannelId helper: options-first, legacy fallback (#1552)", () => {
  it("reads options.general_channel_id (new location)", () => {
    expect(discordGeneralChannelId({ options: { general_channel_id: "OPTIONS_VALUE" } }))
      .toBe("OPTIONS_VALUE");
  });

  it("falls back to top-level general_channel_id for old fleet.yaml files", () => {
    // M2: if fallback is removed, returns null → this fails
    expect(discordGeneralChannelId({ general_channel_id: "LEGACY_TOP_LEVEL" }))
      .toBe("LEGACY_TOP_LEVEL");
  });

  it("options.general_channel_id wins when both are present", () => {
    expect(discordGeneralChannelId({
      general_channel_id: "LEGACY",
      options: { general_channel_id: "OPTIONS_WINS" },
    })).toBe("OPTIONS_WINS");
  });

  it("returns null when neither is set", () => {
    expect(discordGeneralChannelId({})).toBeNull();
  });
});

// ── W1: topic-commands autoCreateTopics General binding ───────────────────────
// Channel has legacy top-level general_channel_id only (no options).
// M3: if autoCreateTopics reads ch?.options?.general_channel_id, gcid is
// undefined, the /^\d{17,}$/ guard fires, and config.topic_id stays null.

describe("W1: autoCreateTopics binds General with legacy top-level general_channel_id (#1552)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("config.topic_id is set when only top-level general_channel_id is present", async () => {
    const { TopicCommands } = await import("../src/topic-commands.js");

    const LEGACY_GCID = "111222333444555666"; // 18-digit — passes /^\d{17,}$/
    const fleetConfig: any = {
      channel: {
        type: "discord",
        bot_token_env: "AGEND_DISCORD_TEST_TOKEN",
        group_id: "999888777666555444",
        general_channel_id: LEGACY_GCID,   // legacy top-level only, no options
      },
      // channels array built from channel in the code
      channels: undefined,
      defaults: {},
      instances: {
        // Name must contain "discord" — platformType detection uses the instance name
        // when no channel_id is configured.
        "discord-general": {
          general_topic: true,
          working_directory: "/tmp/app",
        },
      },
    };

    const saved: any[] = [];
    const ctx: any = {
      fleetConfig,
      logger: { warn: vi.fn(), info: vi.fn() },
      saveFleetConfig: () => { saved.push(JSON.parse(JSON.stringify(fleetConfig))); },
    };

    process.env.AGEND_DISCORD_TEST_TOKEN = "test-token";
    try {
      const tc = new TopicCommands(ctx);
      await tc.autoCreateTopics();
    } finally {
      delete process.env.AGEND_DISCORD_TEST_TOKEN;
    }

    // M3: if options-only read, warn is called and topic_id stays null
    expect(ctx.logger.warn).not.toHaveBeenCalled();
    // topic_id was bound to the legacy gcid
    expect(fleetConfig.instances['discord-general'].topic_id).toBe(LEGACY_GCID);
    expect(saved).toHaveLength(1); // saveFleetConfig was called
  });
});

// ── W2: fleet-manager listSecureConnections ───────────────────────────────────
// Channel has legacy top-level general_channel_id only (no options).
// M4: if listSecureConnections reads options-only, general_channel_id is null.

describe("W2: listSecureConnections returns legacy top-level general_channel_id (#1552)", () => {
  it("general_channel_id is surfaced when only the legacy top-level field is set", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    // Use a real FleetManager instance with a temp dir to satisfy envFileKeys
    const dir = mkdtempSync(_join(_td(), "agend-gcid-legacy-"));
    const fm = new (FleetManager as any)(dir);
    fm.fleetConfig = {
      channels: [{
        id: "dc",
        type: "discord",
        bot_token_env: "AGEND_DISCORD_LEGACY_TOKEN",
        group_id: "123456789012345678",
        general_channel_id: "111222333444555666",  // legacy top-level only
      }],
      instances: {},
    };

    const connections = fm.listSecureConnections();
    // M4: if options-only read, this is null → fails
    expect(connections[0]?.general_channel_id).toBe("111222333444555666");
  });
});
