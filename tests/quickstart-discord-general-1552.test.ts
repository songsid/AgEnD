/**
 * Discord general_channel_id location fix (#1552):
 * - planQuickstart must write general_channel_id under options (not top-level)
 * - discordGeneralChannelId reads options first, falls back to legacy top-level
 *
 * Reverse mutations:
 *   removing options write → test 1 fails (top-level set, options undefined)
 *   removing legacy fallback → test 4 fails (returns null instead of legacy value)
 */
import { describe, expect, it } from "vitest";
import { planQuickstart } from "../src/quickstart-api.js";
import { discordGeneralChannelId } from "../src/fleet-manager.js";

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

    expect((plan.channel as any).options?.general_channel_id).toBe("111222333444555666");
    expect((plan.channel as any).general_channel_id).toBeUndefined();
  });

  it("no general_channel_id: no phantom field", () => {
    const plan = planQuickstart({ ...DISCORD_BASE }, ENV);
    expect((plan.channel as any).general_channel_id).toBeUndefined();
    expect((plan.channel as any).options?.general_channel_id).toBeUndefined();
  });
});

describe("discordGeneralChannelId: options-first, legacy fallback (#1552)", () => {
  it("reads options.general_channel_id (new location)", () => {
    expect(discordGeneralChannelId({
      options: { general_channel_id: "OPTIONS_VALUE" },
    })).toBe("OPTIONS_VALUE");
  });

  it("falls back to top-level general_channel_id for old fleet.yaml files", () => {
    expect(discordGeneralChannelId({
      general_channel_id: "LEGACY_TOP_LEVEL",
    })).toBe("LEGACY_TOP_LEVEL");
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
