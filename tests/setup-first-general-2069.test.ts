/**
 * M-2069: on a fresh fleet, the agent the setup page (or the dashboard's Setup wizard) creates on a Telegram or Discord
 * connection is the fleet's General — general_topic, in the chat's own General topic — not a second agent next to the
 * one the fleet adds at start. And an agent named "general" without general_topic never leaves the fleet without a
 * dispatcher.
 *
 * The cause, from code: the setup wrote the first agent without general_topic; the fleet's auto-General (Phase 3) then
 * skipped because the name "general" was taken, and autoCreateTopics made a new forum topic for an ordinary agent
 * (createForumTopic(basename(working_directory)) → "general", #3040) instead of binding thread 1.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  execFileSync: vi.fn(() => { throw Error("no binary discovery in this test"); }),
}));
import { agentConflict, becomesGeneral, defaultWorkingDirectory, draftQuickstart, handleQuickstartRequest, planQuickstart, withGeneral, withWorkingDirectory, type WizardPlanInput } from "../src/quickstart-api.js";
import { adoptGeneralByName, freeGeneralName, generalTopicFor } from "../src/general-instance.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { FleetConfig } from "../src/types.js";

const DC_GENERAL = "111111111111111111";
const TG = { id: "telegram", type: "telegram", mode: "topic", bot_token_env: "AGEND_TEST_TG_TOKEN", group_id: "-100111", access: { mode: "locked", allowed_users: ["42"] } };
const DC = (general?: string) => ({ id: "discord", type: "discord", mode: "topic", bot_token_env: "AGEND_TEST_DC_TOKEN", group_id: "222",
  access: { mode: "locked", allowed_users: [] }, ...(general ? { options: { general_channel_id: general } } : {}) });
const cfgOf = (instances: Record<string, unknown> = {}, channels: unknown[] = []) => ({ defaults: { backend: "codex" }, instances, channels }) as unknown as FleetConfig;
const TG_IN = { platform: "telegram", admin_user_id: "42", group_id: "-100111", backend: "claude-code", working_directory: "", instance_name: "general", token_env: "AGEND_TEST_TG_TOKEN" } as WizardPlanInput;
const DC_IN = (general?: string) => ({ platform: "discord", admin_user_id: "987654321012345678", guild_id: "222", ...(general ? { general_channel_id: general } : {}),
  backend: "claude-code", working_directory: "", instance_name: "general", token_env: "AGEND_TEST_DC_TOKEN" }) as WizardPlanInput;
// As the routes do: the directory filled in first (#2726), then the plan and the draft.
const plan = (cfg: FleetConfig, input: WizardPlanInput) => withGeneral(planQuickstart(withWorkingDirectory(input), { backends: ["claude-code"], has_fleet: false, channels: [] }), cfg, withWorkingDirectory(input));
const draft = (cfg: FleetConfig, input: WizardPlanInput) => draftQuickstart(cfg, withWorkingDirectory(input), plan(cfg, input));

describe("M-2069: the setup's first agent on a chat connection is the General", () => {
  it("a new agent on the first connection of a fleet with no General: yes; anything else: no", () => {
    expect(becomesGeneral(cfgOf(), TG_IN)).toBe(true);
    expect(becomesGeneral(null, TG_IN), "no fleet.yaml yet (the setup host)").toBe(true);
    expect(becomesGeneral(cfgOf({ a: { working_directory: "/w/a" } }), TG_IN), "a web-only fleet's agents do not stop it").toBe(true);
    expect(becomesGeneral(cfgOf(), { ...TG_IN, existing_agent: true }), "an existing agent's role is never rewritten").toBe(false);
    expect(becomesGeneral(cfgOf(), { ...TG_IN, connection_only: true })).toBe(false);
    expect(becomesGeneral(cfgOf(), { web_only: true }), "web only has no chat General").toBe(false);
    expect(becomesGeneral(cfgOf({}, [TG]), TG_IN), "not the first connection").toBe(false);
    expect(becomesGeneral(cfgOf({ boss: { working_directory: "/w/b", general_topic: true } }), TG_IN), "a General exists").toBe(false);
    expect(becomesGeneral(cfgOf({ general: { working_directory: "/w/g" } }), { ...TG_IN, instance_name: "boss" }),
      "#2744 review: an agent already called general is the one the fleet adopts — no second General").toBe(false);
  });

  it("#2744 review: a typed directory makes a worker, never a General in the user's project; its own workspace path is no directory", () => {
    expect(becomesGeneral(cfgOf(), { ...TG_IN, working_directory: "/home/you/projects/app" })).toBe(false);
    expect(becomesGeneral(cfgOf(), withWorkingDirectory(TG_IN)), "the filled-in default").toBe(true);
    expect(becomesGeneral(cfgOf(), { ...TG_IN, working_directory: defaultWorkingDirectory("other") }), "another agent's workspace is a typed directory").toBe(false);
    const typed = { ...TG_IN, instance_name: "app", working_directory: "/home/you/projects/app" };
    expect(draft(cfgOf(), typed).instances.app).toEqual(expect.not.objectContaining({ general_topic: true }));
    expect(plan(cfgOf(), typed).instance?.general).toBeUndefined();
    expect(agentConflict({ ...TG_IN, working_directory: "/home/you/projects/app" }, cfgOf()) ?? "").toMatch(/the General agent works in its own folder — leave the working directory empty/);
  });

  it("Telegram: written with general_topic in the group's built-in General (thread 1), and the plan says so", () => {
    const cfg = cfgOf(), p = plan(cfg, TG_IN), d = draft(cfg, TG_IN);
    expect(d.instances.general).toMatchObject({ general_topic: true, topic_id: 1, channel_id: "telegram", working_directory: defaultWorkingDirectory("general"), backend: "claude-code" });
    expect(p.instance?.general).toEqual({ topic_id: "1" });
    expect(validateFleetConfig(d).valid, JSON.stringify(validateFleetConfig(d).errors)).toBe(true);
  });

  it("Discord: the connection's general channel; without a valid one it is the General, unbound (as the fleet's own is)", () => {
    const withChannel = draft(cfgOf(), DC_IN(DC_GENERAL));
    expect(withChannel.instances.general).toMatchObject({ general_topic: true, topic_id: DC_GENERAL, channel_id: "discord" });
    const without = draft(cfgOf(), DC_IN());
    expect(without.instances.general.general_topic).toBe(true);
    expect(without.instances.general.topic_id ?? null).toBeNull();
    expect(plan(cfgOf(), DC_IN()).instance?.general).toEqual({ topic_id: null });
  });

  it("any name works for the General; a second connection's or an existing agent's draft gets no general_topic", () => {
    const named = { ...TG_IN, instance_name: "boss" };
    expect(draft(cfgOf(), named).instances.boss.general_topic).toBe(true);
    const second = cfgOf({ general: { working_directory: "/w/g", general_topic: true, topic_id: 1 } }, [TG]);
    const input = { ...TG_IN, instance_name: "beta", group_id: "-100222", token_env: "AGEND_TEST_TG2_TOKEN" };
    const p = withGeneral(planQuickstart(input, { backends: [], has_fleet: true, channels: [{ id: "telegram", type: "telegram", token_env: "AGEND_TEST_TG_TOKEN", group_id: "-100111" }] }), second, input);
    expect(p.instance?.general).toBeUndefined();
    expect(draftQuickstart(second, input, p).instances.beta.general_topic).toBeUndefined();
  });

  it("the name general is refused for a new chat agent that would not be the General; free on a fresh fleet and for web only", () => {
    expect(agentConflict(TG_IN, cfgOf({}, [TG])) ?? "").toMatch(/the name "general" is kept for the fleet's General agent/);
    expect(agentConflict(TG_IN, cfgOf({ boss: { working_directory: "/w/b", general_topic: true } })) ?? "").toMatch(/kept for the fleet's General/);
    expect(agentConflict(TG_IN, cfgOf())).toBeNull();
    expect(agentConflict({ instance_name: "general", web_only: true }, cfgOf({}, []))).toBeNull();
    expect(agentConflict({ ...TG_IN, instance_name: "beta" }, cfgOf({}, [TG]))).toBeNull();
  });
});

describe("M-2069: the setup routes and pages", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  function call(method: string, path: string, cfg: FleetConfig, body?: unknown) {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-test-2069-")); roots.push(dataDir);
    return new Promise<{ status: number; body: any }>((resolve) => {
      const req: any = Object.assign(new EventEmitter(), { method, url: path, headers: {}, destroy: vi.fn() });
      const res: any = { headersSent: false, setHeader: vi.fn(), writeHead(s: number) { this.status = s; this.headersSent = true; }, end(t: string) { resolve({ status: this.status, body: JSON.parse(t) }); } };
      const ctx: any = { fleetConfig: cfg, dataDir, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
      expect(handleQuickstartRequest(req, res, new URL(path, "http://localhost"), ctx)).toBe(true);
      if (body !== undefined) queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    });
  }

  it("the environment says whether a new chat agent would be the General; the plan marks it", async () => {
    expect((await call("GET", "/api/settings/quickstart/environment", cfgOf())).body.first_general).toBe(true);
    expect((await call("GET", "/api/settings/quickstart/environment", cfgOf({}, [TG]))).body.first_general).toBe(false);
    const r = await call("POST", "/api/settings/quickstart/plan", cfgOf(), { ...TG_IN, token_env: undefined });
    expect([r.status, r.body.instance?.general]).toEqual([200, { topic_id: "1" }]);
  });

  it("the dashboard's wizard names a General-to-be general (the setup page: tests/setup-i18n-2726.test.ts, run as a page)", () => {
    const wizard = readFileSync(join(__dirname, "../src/ui/settings-wizard.js"), "utf8");
    expect(wizard).toContain('const general = !!e.first_general && !names.has("general");');
    expect(wizard).toContain('instance_name: general ? "general" : `agent-${n}`');
    expect(wizard).toContain('asGeneral(w) ? html`<p class="note">${tn("wizardGeneralNote")}</p>` : null');
    expect(wizard, "#2744 review: a typed directory makes a worker").toContain("const asGeneral = (x) => x.general && !x.working_directory;");
  });
});

describe("M-2069: an agent named general never leaves a chat fleet without a dispatcher", () => {
  const logger = { warn: vi.fn() };
  const own = () => true;
  it("made the General, in its chat's General topic: Telegram thread 1 (the stray forum topic is left behind)", () => {
    const fleet = cfgOf({ general: { working_directory: "/w/g", topic_id: 3040 }, alpha: { working_directory: "/w/a", topic_id: 7 } }, [TG]);
    expect(adoptGeneralByName(fleet, logger, own)).toBe(true);
    expect(fleet.instances.general).toMatchObject({ general_topic: true, topic_id: 1 });
    expect(fleet.instances.alpha.general_topic).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ topic_from: 3040, topic_to: 1 }), expect.stringMatching(/made it the General/));
  });
  it("Discord: its general channel; none valid: the General keeps the topic it has", () => {
    const withChannel = cfgOf({ general: { working_directory: "/w/g", topic_id: "333333333333333333" } }, [DC(DC_GENERAL)]);
    expect(adoptGeneralByName(withChannel, logger, own)).toBe(true);
    expect(withChannel.instances.general.topic_id).toBe(DC_GENERAL);
    const without = cfgOf({ general: { working_directory: "/w/g", topic_id: "333333333333333333" } }, [DC()]);
    expect(adoptGeneralByName(without, logger, own)).toBe(true);
    expect(without.instances.general).toMatchObject({ general_topic: true, topic_id: "333333333333333333" });
  });
  it("left alone: no chat, a General already there, bound to another connection, or no agent of that name", () => {
    const cases = [
      cfgOf({ general: { working_directory: "/w/g" } }, []),
      cfgOf({ general: { working_directory: "/w/g" }, boss: { working_directory: "/w/b", general_topic: true } }, [TG]),
      cfgOf({ general: { working_directory: "/w/g", channel_id: "telegram-2" } }, [TG, { ...TG, id: "telegram-2", group_id: "-100222" }]),
      cfgOf({ alpha: { working_directory: "/w/a" } }, [TG]),
    ];
    for (const fleet of cases) {
      const before = JSON.stringify(fleet);
      expect(adoptGeneralByName(fleet, logger, own)).toBe(false);
      expect(JSON.stringify(fleet)).toBe(before);
    }
  });
  it("#2744 review: a general in a folder AgEnD does not own is left alone; the fleet makes its General under a free name", () => {
    const fleet = cfgOf({ general: { working_directory: "/home/you/projects/app" } }, [TG]);
    const seen: string[] = [];
    expect(adoptGeneralByName(fleet, logger, dir => { seen.push(dir); return false; })).toBe(false);
    expect([seen, fleet.instances.general.general_topic ?? null]).toEqual([["/home/you/projects/app"], null]);
    expect(freeGeneralName(fleet.instances, "general")).toBe("general-2");
    expect(freeGeneralName({ general: {}, "general-2": {} }, "general")).toBe("general-3");
    expect(freeGeneralName({}, "general")).toBe("general");
    const fm = readFileSync(join(__dirname, "../src/fleet-manager.ts"), "utf8");
    expect(fm, "Phase 3 no longer skips a taken name").not.toContain("if (fleet.instances[name]) continue;");
    expect(fm).toContain("name = freeGeneralName(fleet.instances, taken);");
    expect(fm).toContain("dir => insideManagedWorkspaces(dir) || resolvePath(dir) === join(getAgendHome(), GENERAL_NAME)");
  });
  it("runs before the fleet's General phases, so the auto-General sees it (and Phase 3 no longer meets a taken name)", () => {
    const fm = readFileSync(join(__dirname, "../src/fleet-manager.ts"), "utf8");
    const adopt = fm.indexOf("let generalsCreated = adoptGeneralByName(fleet, this.logger,");
    expect(adopt).toBeGreaterThan(0);
    expect(adopt).toBeLessThan(fm.indexOf("const generalInstances = Object.entries(fleet.instances).filter(([, inst]) => inst.general_topic === true);"));
    expect(generalTopicFor({ type: "telegram" })).toBe(1);
    expect(generalTopicFor({ type: "discord", general_channel_id: DC_GENERAL }), "a legacy top-level id is read too").toBe(DC_GENERAL);
    expect(generalTopicFor({ type: "discord", options: { general_channel_id: "1" } }), "never the TG convention").toBeNull();
  });
});

describe("M-2069 cause #2: the General binds the chat's General topic; no forum topic is made", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  /** The fleet as a restart loads it (the real loader), its topics made by the real autoCreateTopics (creation inert). */
  async function restart(fleet: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "agend-test-2069-restart-"));
    const path = join(dir, "fleet.yaml");
    writeFileSync(path, JSON.stringify(fleet));
    const fm = new FleetManager(dir) as any;
    clearInterval(fm.sessionPruneTimer);
    fm.loadConfig(path);
    fm.createForumTopic = vi.fn(async () => 3040);
    fm.saveFleetConfig = vi.fn();
    await fm.topicCommands.autoCreateTopics();
    return { fm, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("the setup's draft: no createForumTopic, thread 1; control: the pre-M-2069 draft (no general_topic) made forum topic 'general'", async () => {
    vi.stubEnv("AGEND_TEST_TG_TOKEN", "fake");
    const d = draft(cfgOf(), TG_IN);
    const now = await restart(d as unknown as Record<string, unknown>);
    try {
      expect(now.fm.createForumTopic).not.toHaveBeenCalled();
      expect(now.fm.fleetConfig.instances.general.topic_id).toBe(1);
    } finally { now.done(); }
    const before = structuredClone(d) as any;
    delete before.instances.general.general_topic; delete before.instances.general.topic_id;
    const old = await restart(before);
    try {
      expect(old.fm.createForumTopic.mock.calls.map((c: unknown[]) => c[0])).toEqual(["general"]);   // basename of its workspace — #3040
      expect(old.fm.fleetConfig.instances.general.topic_id).toBe(3040);
    } finally { old.done(); }
  });
});
