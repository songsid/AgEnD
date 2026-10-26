/**
 * #2726 part 1: the setup page's working directory is optional. None given is the agent's own workspace,
 * <AGEND_HOME>/workspaces/<name> — the folder create_instance makes and the loader gives an entry without one — written
 * as that path, so the plan, the host confirmation and fleet.yaml all say the same thing. A directory that is given is
 * still absolute; an existing agent keeps its own. The real SetupHost on a scratch AGEND_HOME (no fleet is started).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import yaml from "js-yaml";
import { SetupHost } from "../src/setup-host.js";
import { defaultWorkingDirectory, draftQuickstart, planQuickstart, validateWizardInput, withExistingAgent, withWorkingDirectory, type WizardPlanInput } from "../src/quickstart-api.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { loadFleetConfig } from "../src/config.js";
import { setupHttp, decideSetup, inspectSetup } from "./helpers/setup-confirmation-1423.js";

const WEB = { web_only: true, backend: "claude-code", working_directory: "", instance_name: "agent-1" };
const BOT = { platform: "telegram", token_env: "AGEND_BOT_TOKEN", backend: "claude-code", working_directory: "", instance_name: "agent-1",
  group_id: "-100123", admin_user_id: "42" } as WizardPlanInput;
const fixtures: { host?: SetupHost; dir: string }[] = [];
afterEach(async () => {
  for (const { host, dir } of fixtures.splice(0)) { await host?.shutdown(false, "test cleanup"); rmSync(dir, { recursive: true, force: true }); }
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});
function home() {
  const dir = mkdtempSync(join(tmpdir(), "agend-test-workdir-2726-"));
  vi.stubEnv("AGEND_HOME", dir); fixtures.push({ dir });
  return dir;
}
async function harness() {
  const dir = home(), spawnFleet = vi.fn();
  const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, spawnFleet, log: () => {} });
  fixtures.push({ host, dir });
  const { port, path, code } = await host.start();
  const signed = await setupHttp(port, path + "open", "POST", { code });
  return { dir, port, path, cookie: String(signed.headers["set-cookie"]).split(";")[0]! };
}

describe("#2726 validation: none, or an absolute path", () => {
  it("web only and with a bot: empty or absent is accepted; relative or not a string is refused", () => {
    for (const base of [WEB, BOT]) {
      expect(validateWizardInput(base as never), JSON.stringify(base)).toBeNull();
      const { working_directory: _none, ...absent } = base;
      expect(validateWizardInput(absent as never)).toBeNull();
      expect(validateWizardInput({ ...base, working_directory: "/srv/app" } as never)).toBeNull();
      for (const bad of ["relative/app", "~/app", 42, null, true]) {
        expect(validateWizardInput({ ...base, working_directory: bad } as never), String(bad)).toBe("working_directory must be an absolute path, or empty for the agent's own workspace");
      }
    }
  });
  it("(review) a name of only dots is refused on both paths: its workspace would be the workspaces folder or AGEND_HOME", () => {
    for (const base of [WEB, BOT]) for (const name of [".", "..", "..."]) {
      expect(validateWizardInput({ ...base, instance_name: name } as never), `${JSON.stringify(base.instance_name)}→${name}`).toBe("instance_name must be [A-Za-z0-9._-], and not only dots");
    }
    expect(validateWizardInput({ ...BOT, instance_name: "..", existing_agent: true })).toBe("instance_name must be [A-Za-z0-9._-], and not only dots");
    for (const name of ["a.", ".a", "a..b", "agent-1"]) expect(validateWizardInput({ ...WEB, instance_name: name } as never), name).toBeNull();
  });
  it("an existing agent is not asked for one, whatever the field holds", () => {
    expect(validateWizardInput({ ...BOT, existing_agent: true, working_directory: "relative" })).toBeNull();
  });
});

describe("#2726 the default is the agent's own workspace", () => {
  it("is <AGEND_HOME>/workspaces/<name>, filled in only for a new agent with none", () => {
    const dir = home();
    expect(defaultWorkingDirectory("agent-1")).toBe(join(dir, "workspaces", "agent-1"));
    expect(withWorkingDirectory(BOT).working_directory).toBe(join(dir, "workspaces", "agent-1"));
    expect(withWorkingDirectory({ ...BOT, working_directory: "/srv/app" }).working_directory).toBe("/srv/app");
    expect(withWorkingDirectory({ ...BOT, existing_agent: true }).working_directory).toBe("");
    expect(withWorkingDirectory({ ...BOT, connection_only: true }).working_directory).toBe("");
  });
  it("with a bot: the plan, the confirmation's diff and the draft carry that path; an existing agent keeps its own", () => {
    const dir = home(), want = join(dir, "workspaces", "agent-1");
    const cfg = { instances: { old: { working_directory: "/w/old", backend: "codex" } }, defaults: {} } as never;
    const channels = { backends: ["claude-code"], has_fleet: true, channels: [] };
    const plan = planQuickstart(withWorkingDirectory(BOT), channels);
    expect(plan.instance?.working_directory).toBe(want);
    expect((draftQuickstart(cfg, withWorkingDirectory(BOT), plan).instances as any)["agent-1"].working_directory).toBe(want);
    const effect = prepareSettingsEffect("POST", "/api/settings/quickstart/commit", { ...BOT, token: "123:abc" }, { config: cfg, classic: {} }) as any;
    expect(JSON.stringify(effect.diff)).toContain(want);
    const existing = { ...BOT, instance_name: "old", existing_agent: true };
    const kept = planQuickstart(withExistingAgent(withWorkingDirectory(existing), cfg), channels);
    expect(kept.instance?.working_directory).toBe("/w/old");
    expect((draftQuickstart(cfg, withWorkingDirectory(existing), kept).instances as any).old.working_directory).toBe("/w/old");
  });
});

describe("#2726 on the real SetupHost (web only)", () => {
  it("the page learns where workspaces go; plan → host confirmation → fleet.yaml say the same path, and the folder is made private with its own git", async () => {
    const h = await harness(), want = join(h.dir, "workspaces", "agent-1");
    expect((await setupHttp(h.port, h.path + "api/settings/quickstart/environment", "GET", undefined, h.cookie)).body.workspaces_dir).toBe(join(h.dir, "workspaces"));
    const plan = await setupHttp(h.port, h.path + "api/settings/quickstart/plan", "POST", WEB, h.cookie);
    expect(plan.status).toBe(200);
    expect(plan.body.instance.working_directory).toBe(want);
    const pending = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", WEB, h.cookie);
    expect(pending.status).toBe(202);
    expect(existsSync(want), "nothing is made before the host confirms").toBe(false);
    expect(JSON.stringify(await inspectSetup(h.dir, pending.body.pending_change.id))).toContain(want);
    expect((await decideSetup(h.dir, pending.body.pending_change.id)).pending_change.state).toBe("applied");
    const written = yaml.load(readFileSync(join(h.dir, "fleet.yaml"), "utf8")) as Record<string, any>;
    expect(written.instances).toEqual({ "agent-1": { working_directory: want, backend: "claude-code" } });
    expect(statSync(want).mode & 0o777).toBe(0o700);
    expect(existsSync(join(want, ".git"))).toBe(true);
    // What the fleet then reads: the same folder (loadFleetConfig gives a missing entry this path too).
    expect(loadFleetConfig(join(h.dir, "fleet.yaml")).instances["agent-1"]!.working_directory).toBe(want);
  });
  it("a directory that is given is written as given and nothing is made for it", async () => {
    const h = await harness(), given = join(h.dir, "projects", "app");
    const pending = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", { ...WEB, working_directory: given }, h.cookie);
    expect((await decideSetup(h.dir, pending.body.pending_change.id)).pending_change.state).toBe("applied");
    const written = yaml.load(readFileSync(join(h.dir, "fleet.yaml"), "utf8")) as Record<string, any>;
    expect(written.instances["agent-1"].working_directory).toBe(given);
    expect(existsSync(given)).toBe(false);
    expect(existsSync(join(h.dir, "workspaces", "agent-1"))).toBe(false);
  });
  it("(review) a name of only dots never reaches AGEND_HOME: refused by the plan and the commit, nothing made there", async () => {
    const h = await harness();
    for (const name of [".", ".."]) {
      for (const route of ["plan", "commit"]) {
        const r = await setupHttp(h.port, h.path + `api/settings/quickstart/${route}`, "POST", { ...WEB, instance_name: name }, h.cookie);
        expect(r.status, `${route} ${name}`).toBe(400);
      }
    }
    expect((await setupHttp(h.port, h.path + "api/settings/pending", "GET", undefined, h.cookie)).body).toEqual([]);
    expect([existsSync(join(h.dir, ".git")), existsSync(join(h.dir, "workspaces")), existsSync(join(h.dir, "fleet.yaml"))]).toEqual([false, false, false]);
  });
  it("a relative directory is refused before anything is proposed", async () => {
    const h = await harness();
    const planned = await setupHttp(h.port, h.path + "api/settings/quickstart/plan", "POST", { ...WEB, working_directory: "app" }, h.cookie);
    expect([planned.status, planned.body.error]).toEqual([400, "working_directory must be an absolute path, or empty for the agent's own workspace"]);
    // The commit is refused by the confirmation gate first, by its code (the page says it in words, setup-i18n.ts).
    const refused = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", { ...WEB, working_directory: "app" }, h.cookie);
    expect([refused.status, refused.body.error]).toEqual([400, "invalid_quickstart"]);
    expect((await setupHttp(h.port, h.path + "api/settings/pending", "GET", undefined, h.cookie)).body).toEqual([]);
  });
});
