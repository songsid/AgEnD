/**
 * User decision 2026-11-06 (after the v2.3.3 report behind #3200): quickstart's "Add another platform" also offers
 * that platform's General — asked with Yes as the default and its cost said — for a platform with its own group or
 * server; never for a Discord persona sharing an earlier connection's guild; never a second one for a connection a
 * General already answers. `agend doctor` (the validator) says which connection lacks one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptersWithoutGeneral, platformGeneralPlan } from "../src/platform-general.js";
import { offerPlatformGeneral } from "../src/quickstart.js";
import { validateFleetConfig } from "../src/config-validator.js";

const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = () => { const h = mkdtempSync(join(tmpdir(), "agend-qs-general-")); homes.push(h); return h; };

const TG = { id: "telegram", type: "telegram", mode: "topic", bot_token_env: "T", group_id: -100123, access: { mode: "locked", allowed_users: [1] } };
const DC = { id: "discord", type: "discord", mode: "topic", bot_token_env: "D", group_id: "1234567890123456789", access: { mode: "locked", allowed_users: ["1"] },
  options: { general_channel_id: "1400000000000000001" } };
const PERSONA = { id: "helper", type: "discord", mode: "topic", bot_token_env: "H", group_id: DC.group_id, access: DC.access };
const firstGeneral = { general: { working_directory: "/w/general", general_topic: true } };

describe("the General offered for an added platform", () => {
  it("both platform orders: general-<adapter>, bound to it, its topic bound like the first General's", () => {
    const h = home();
    // Telegram first, Discord added: the Discord General on its general channel.
    expect(platformGeneralPlan(firstGeneral, [TG, DC], 1, h)).toEqual({ name: "general-discord",
      instance: { working_directory: join(h, "general-discord"), general_topic: true, channel_id: "discord", topic_id: "1400000000000000001" } });
    // Discord first, Telegram added: the Telegram General on the group's General topic (1).
    expect(platformGeneralPlan(firstGeneral, [DC, TG], 1, h)).toEqual({ name: "general-telegram",
      instance: { working_directory: join(h, "general-telegram"), general_topic: true, channel_id: "telegram", topic_id: 1 } });
  });

  it("a Discord connection with no valid general channel: bound to the adapter, its topic left unbound (as the fleet does)", () => {
    const plan = platformGeneralPlan(firstGeneral, [TG, { ...DC, options: {} }], 1, home());
    expect(plan?.instance).not.toHaveProperty("topic_id");
    expect(plan?.instance.channel_id).toBe("discord");
  });

  it("the persona skip: a second bot in the primary's guild gets no General, and doctor asks for none", () => {
    expect(platformGeneralPlan(firstGeneral, [DC, PERSONA], 1, home())).toBeNull();
    expect(adaptersWithoutGeneral(firstGeneral, [DC, PERSONA])).toEqual([]);
  });

  it("re-running never duplicates: a General already bound to that adapter means nothing is offered", () => {
    const both = { ...firstGeneral, "general-discord": { working_directory: "/w/gd", general_topic: true, channel_id: "discord" } };
    expect(platformGeneralPlan(both, [TG, DC], 1, home())).toBeNull();
    // Whatever its name.
    const renamed = { ...firstGeneral, dispatcher: { working_directory: "/w/x", general_topic: true, channel_id: "discord" } };
    expect(platformGeneralPlan(renamed, [TG, DC], 1, home())).toBeNull();
  });

  it("an agent already named general-discord that is not a General: the new one takes a free name", () => {
    const taken = { ...firstGeneral, "general-discord": { working_directory: "/w/p" } };
    expect(platformGeneralPlan(taken, [TG, DC], 1, home())?.name).toBe("general-discord-2");
  });
});

describe("quickstart asks, Yes by default, and says the cost", () => {
  const ask = (answer: string) => ({ question: vi.fn(async (_q: string) => answer) });

  it("Enter (the default) adds it, makes its folder private; the question names the platform, the agent and the cost", async () => {
    const h = home();
    const config: Record<string, any> = { channels: [TG, DC], instances: { ...firstGeneral } };
    const rl = ask("");
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await offerPlatformGeneral(rl, config, config.channels, 1, h)).toBe(true);
    expect(config.instances["general-discord"]).toMatchObject({ general_topic: true, channel_id: "discord" });
    expect(statSync(join(h, "general-discord")).mode & 0o777).toBe(0o700);
    const q = rl.question.mock.calls[0]![0];
    expect(q).toContain("Discord"); expect(q).toContain("general-discord"); expect(q).toMatch(/always-on/); expect(q).toContain("[Y/n]");
  });

  it("n declines: nothing added, no folder", async () => {
    const h = home();
    const config: Record<string, any> = { channels: [TG, DC], instances: { ...firstGeneral } };
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await offerPlatformGeneral(ask("n"), config, config.channels, 1, h)).toBe(false);
    expect(config.instances).not.toHaveProperty("general-discord");
    expect(existsSync(join(h, "general-discord"))).toBe(false);
  });

  it("a second run with it in place asks nothing; the persona is never asked about", async () => {
    const config: Record<string, any> = { channels: [TG, DC], instances: { ...firstGeneral } };
    vi.spyOn(console, "log").mockImplementation(() => {});
    await offerPlatformGeneral(ask(""), config, config.channels, 1, home());
    const again = ask("");
    expect(await offerPlatformGeneral(again, config, config.channels, 1, home())).toBe(false);
    expect(again.question).not.toHaveBeenCalled();
    expect(Object.keys(config.instances).filter((n) => config.instances[n].general_topic)).toEqual(["general", "general-discord"]);
    const persona: Record<string, any> = { channels: [DC, PERSONA], instances: { ...firstGeneral } };
    const p = ask("");
    expect(await offerPlatformGeneral(p, persona, persona.channels, 1, home())).toBe(false);
    expect(p.question).not.toHaveBeenCalled();
  });
});

describe("doctor: a General per connection", () => {
  const warnings = (config: unknown) => validateFleetConfig(config).warnings.map((w) => w.message).filter((m) => m.includes("general_topic"));

  it("a second platform without its General is named; with one (either order), the hint is satisfied", () => {
    for (const [channels, added] of [[[TG, DC], "discord"], [[DC, TG], "telegram"]] as const) {
      const before = warnings({ channels, instances: { ...firstGeneral } });
      expect(before).toHaveLength(1);
      expect(before[0]).toContain(`connection "${added}"`);
      const plan = platformGeneralPlan(firstGeneral, channels, 1, "/home/x/.agend")!;
      expect(warnings({ channels, instances: { ...firstGeneral, [plan.name]: plan.instance } })).toEqual([]);
    }
  });

  it("a persona needs none; a single connection keeps the one fleet-wide hint; no General at all is said once", () => {
    expect(warnings({ channels: [DC, PERSONA], instances: { ...firstGeneral } })).toEqual([]);
    expect(warnings({ channel: TG, instances: { ...firstGeneral } })).toEqual([]);
    const none = warnings({ channels: [TG, DC], instances: { w: { working_directory: "/w" } } });
    expect(none).toHaveLength(1);
    expect(none[0]).toMatch(/^no general_topic instance — /);
  });
});
