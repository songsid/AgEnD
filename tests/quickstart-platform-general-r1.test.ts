/**
 * #3203 review (Prism), r1:
 *  1. A General the config loader makes through `defaults.general_topic: true` (an instance with no flag of its own)
 *     already answers for its connection: quickstart offers no second one and doctor asks for none — both adapter
 *     orders; an explicit `general_topic: false` stays not-a-General (the control). Checked against the real loader.
 *  2. The "both platforms already configured" repair path: a General added there is applied to a running fleet
 *     (SIGHUP, as Add allowed users does); declining changes nothing and signals nothing. The whole runQuickstart flow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { platformGeneralPlan, adaptersWithoutGeneral } from "../src/platform-general.js";
import { loadFleetConfigSource } from "../src/config.js";
import { validateFleetConfig } from "../src/config-validator.js";

const answers: string[] = [];
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: async () => answers.shift() ?? "", close: () => {} }),
}));

const homes: string[] = [];
const home = () => { const h = mkdtempSync(join(tmpdir(), "agend-qs-r1-")); homes.push(h); return h; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); answers.length = 0; for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const TG = { id: "telegram", type: "telegram", mode: "topic", bot_token_env: "T", group_id: -100123, access: { mode: "locked", allowed_users: [1] } };
const DC = { id: "discord", type: "discord", mode: "topic", bot_token_env: "D", group_id: "1234567890123456789", access: { mode: "locked", allowed_users: ["1"] },
  options: { general_channel_id: "1400000000000000001" } };

describe("an inherited General (defaults.general_topic: true) answers for its connection", () => {
  for (const [channels, other] of [[[TG, DC], "discord"], [[DC, TG], "telegram"]] as const) {
    const first = channels[0].id;
    it(`channels [${first}, ${other}]: no second General offered, no doctor warning — and the loader agrees`, () => {
      const fleet = { channels, defaults: { general_topic: true }, instances: {
        general: { working_directory: "/w/g", general_topic: true },
        dispatcher: { working_directory: "/w/d", channel_id: other },   // a General only through the default
      } };
      const loaded = loadFleetConfigSource(yaml.dump(fleet));
      expect(loaded.instances.dispatcher!.general_topic).toBe(true);   // the production loader's view
      expect(platformGeneralPlan(fleet.instances, channels, 1, "/h", fleet.defaults)).toBeNull();
      expect(adaptersWithoutGeneral(fleet.instances, channels, fleet.defaults)).toEqual([]);
      expect(validateFleetConfig(fleet).warnings.filter((w) => w.message.includes(`connection "${other}"`))).toEqual([]);
    });

    it(`channels [${first}, ${other}], control: an explicit general_topic: false is not a General, whatever the default`, () => {
      const fleet = { channels, defaults: { general_topic: true }, instances: {
        general: { working_directory: "/w/g", general_topic: true },
        worker: { working_directory: "/w/x", channel_id: other, general_topic: false },
      } };
      expect(loadFleetConfigSource(yaml.dump(fleet)).instances.worker!.general_topic).toBe(false);
      expect(platformGeneralPlan(fleet.instances, channels, 1, "/h", fleet.defaults)?.name).toBe(`general-${other}`);
      expect(validateFleetConfig(fleet).warnings.some((w) => w.message.includes(`connection "${other}"`))).toBe(true);
    });
  }
});

describe("the both-platforms repair path applies an added General to a running fleet (runQuickstart)", () => {
  let dir: string;
  let kill: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = home();
    vi.stubEnv("AGEND_HOME", dir);
    writeFileSync(join(dir, "fleet.yaml"), yaml.dump({ channels: [TG, DC], instances: { general: { working_directory: join(dir, "general"), general_topic: true } } }));
    writeFileSync(join(dir, "fleet.pid"), "424242\n");
    kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    vi.spyOn(console, "log").mockImplementation(() => {});
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  });
  async function run() {
    vi.resetModules();
    const { runQuickstart } = await import("../src/quickstart.js");
    await runQuickstart();
  }
  const generals = () => Object.entries((yaml.load(readFileSync(join(dir, "fleet.yaml"), "utf8")) as any).instances)
    .filter(([, i]: any) => i.general_topic).map(([n]) => n);

  it("Add another platform → (both configured) → Enter: general-discord is saved and the fleet is sent SIGHUP", async () => {
    answers.push("2", "");
    await run();
    expect(generals()).toEqual(["general", "general-discord"]);
    expect(kill).toHaveBeenCalledWith(424242, "SIGHUP");
  });

  it("declining saves nothing and signals nothing; a second run with it in place asks nothing and signals nothing", async () => {
    const before = readFileSync(join(dir, "fleet.yaml"), "utf8");
    answers.push("2", "n");
    await run();
    expect(readFileSync(join(dir, "fleet.yaml"), "utf8")).toBe(before);
    expect(kill).not.toHaveBeenCalledWith(424242, "SIGHUP");
    answers.push("2", "");
    await run();
    kill.mockClear();
    answers.push("2");   // nothing else to answer: no General is offered again
    await run();
    expect(generals()).toEqual(["general", "general-discord"]);
    expect(kill).not.toHaveBeenCalledWith(424242, "SIGHUP");
  });
});

describe("Fable P3 on #3202: a Discord general_channel_id must be a real channel id", () => {
  it("a malformed id leaves the topic unbound; a real snowflake binds it", async () => {
    const { generalTopicId } = await import("../src/platform-general.js");
    for (const bad of ["1", "abc", "12345", "1400000000000000001x", ""]) expect(generalTopicId({ type: "discord", options: { general_channel_id: bad } })).toBeUndefined();
    expect(generalTopicId({ type: "discord", options: { general_channel_id: "1400000000000000001" } })).toBe("1400000000000000001");
  });
});
