/**
 * AGEND-163: an agent's portable settings as a file and the way back — the allow-list in both directions (nothing outside it is
 * written or read), the secret scan that stops the download, and the "Agent instructions" (the agent's `systemPrompt`, one
 * field: #3626) as the only instructions group — same 24,000-character limit, and a `file:` reference never travels.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { parse as yamlParse } from "yaml";
import { buildAgentExport, parseAgentExport, scanForSecrets, AGENT_EXPORT_MAX_CHARS, AGENT_INSTRUCTIONS_MAX_CHARS } from "../src/agent-export.js";
import { fake } from "./helpers/fake-secrets-163.js";
import { FleetManager } from "../src/fleet-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

const ALL = ["identity", "systemPrompt", "runtime", "behavior"];
const saved = {
  description: "Reviews UI changes", tags: ["review", "ui"],
  systemPrompt: "# Role\n\nBe exact.\n- one\n- two\n", backend: "claude-code", model: "claude-sonnet-5-5", model_failover: ["claude-haiku-5-5"], tool_set: "coordinator", lightweight: true,
  hang_detector: { timeout_minutes: 15 }, tool_progress: "standard", reply_completion_guard: false, log_level: "debug", auto_pause_after: 30, agent_mode: "cli",
  cross_instance_visibility: "summary", board_cards_at_once: 2, resume_interrupted_work: false,
  // Never exported:
  working_directory: "/home/me/work", channel_id: "discord", topic_id: "123456789", general_topic: true, display_name: "Kasa", machine_id: "m-1", runtime: "windows",
  backend_options: { "claude-code": { credential_profile: "personal@example.com" } }, dashboard: { office: "full" }, skipPermissions: true,
  pre_task_command: "rm -rf /", status_emojis: { received: "<:x:1>" }, quota_notice: { threshold: 90 }, workflow: "wf", native_sandbox: "x",
} as any;

describe("export: a file of the portable fields and nothing else", () => {
  const built = buildAgentExport("claude-kasa", saved, ALL);
  const doc = yamlParse(built.text!) as any;
  it("is agend_export: 1, kind agent, the role, and the reserved empty library", () => {
    expect(doc).toMatchObject({ agend_export: 1, kind: "agent", role: "claude-kasa", library: { skills: [], mcp: [] } });
    expect(built.findings).toEqual([]);
    expect(built.empty).toBe(false);
  });
  it("carries every portable field, as written", () => {
    expect(doc.agent).toEqual({
      description: saved.description, tags: saved.tags, systemPrompt: "# Role\n\nBe exact.\n- one\n- two",
      backend: "claude-code", model: "claude-sonnet-5-5", model_failover: ["claude-haiku-5-5"], tool_set: "coordinator", lightweight: true,
    });
    expect(doc.behavior).toEqual({
      hang_detector: { timeout_minutes: 15 }, tool_progress: "standard", reply_completion_guard: false, log_level: "debug", auto_pause_after: 30, agent_mode: "cli",
      cross_instance_visibility: "summary", board_cards_at_once: 2, resume_interrupted_work: false,
    });
  });
  it("never writes an account, key, channel, folder, machine, permission, command or emoji — in any group", () => {
    for (const word of ["home/me", "discord", "123456789", "Kasa", "m-1", "windows", "personal@example.com", "credential_profile", "office", "skipPermissions", "rm -rf", "status_emojis", "quota", "workflow", "native_", "dashboard", "backend_options"]) {
      expect(built.text, word).not.toContain(word);
    }
  });
  it("writes only the chosen groups, and only what the agent itself saved", () => {
    const only = yamlParse(buildAgentExport("r", saved, ["systemPrompt"]).text!) as any;
    expect(only.agent).toEqual({ systemPrompt: "# Role\n\nBe exact.\n- one\n- two" });
    expect(only.behavior).toBeUndefined();
    const bare = buildAgentExport("r", { working_directory: "/w" }, ALL);
    expect(bare.empty).toBe(true);
    expect(yamlParse(bare.text!).agent).toEqual({});
    expect(buildAgentExport("r", saved, ["nonsense"]).empty).toBe(true);
  });
  it("leaves out Agent instructions that name a file (a path on the exporter's computer) and a role name that is not a name", () => {
    const t = buildAgentExport("bad role/name", { systemPrompt: "file:prompts/a.md,prompts/b.md", description: "d" }, ALL).text!;
    expect(t).not.toContain("systemPrompt");
    expect(yamlParse(t).role).toBeUndefined();
  });
  it("a file: part anywhere keeps the whole value out, by the rule the editor and the daemon use — a comma in plain text does not", () => {
    for (const sp of ["file:a.md", "  file:a.md", "Be brief, file:rules.md", "file:a.md, and also this text"]) {
      expect(yamlParse(buildAgentExport("r", { systemPrompt: sp, description: "d" }, ALL).text!).agent, sp).toEqual({ description: "d" });
    }
    const plain = "You are Kuro, a careful reviewer. Never use the file: prefix in prose, but a comma is fine.";
    expect(yamlParse(buildAgentExport("r", { systemPrompt: plain }, ["systemPrompt"]).text!).agent).toEqual({ systemPrompt: plain });
  });
  it("says what it left out, so the preview matches what Load accepts (AGEND-171): a file: value, and a text over the 24,000 limit", () => {
    expect(buildAgentExport("r", { systemPrompt: "file:a.md" }, ["systemPrompt"])).toMatchObject({ empty: true, omitted: [{ field: "systemPrompt", reason: "fileRef" }] });
    const long = "x".repeat(AGENT_INSTRUCTIONS_MAX_CHARS + 1);
    const over = buildAgentExport("r", { systemPrompt: long, description: "d" }, ALL);
    expect(over.omitted).toEqual([{ field: "systemPrompt", reason: "tooLong" }]);
    expect(yamlParse(over.text!).agent).toEqual({ description: "d" });
    // At the limit it is written, and the file reads back whole.
    const edge = "y".repeat(AGENT_INSTRUCTIONS_MAX_CHARS);
    const ok = buildAgentExport("r", { systemPrompt: edge }, ["systemPrompt"]);
    expect(ok.omitted).toEqual([]);
    const back = parseAgentExport(ok.text);
    expect(back.ok && back.fill.systemPrompt).toBe(edge);
    // Nothing is omitted when the group is not chosen, or there is nothing saved.
    expect(buildAgentExport("r", { systemPrompt: "file:a.md" }, ["identity"]).omitted).toEqual([]);
    expect(buildAgentExport("r", {}, ALL).omitted).toEqual([]);
  });
  it("there is no separate instructions group: a stray `instructions` field is not exported, and the group name is ignored", () => {
    expect(buildAgentExport("r", { instructions: "# Role" } as any, ["instructions"]).empty).toBe(true);
    expect(buildAgentExport("r", { instructions: "# Role" } as any, ALL).empty).toBe(true);
  });
});

describe("export: a secret stops the file", () => {
  const secrets: Array<[string, string]> = [
    ["api_key", `use ${fake.anthropicKey()} for it`], ["api_key", fake.githubToken()], ["private_key", fake.privateKeyHeader()],
    ["bot_token", `bot ${fake.telegramToken()}`], ["jwt", fake.jwt()],
    ["bearer", fake.bearer()], ["assignment", fake.assignment()], ["url_password", fake.urlPassword()],
    // AGEND-163 review: shapes with no label of their own — this fleet's own Discord credential and its relatives.
    ["discord_token", `token is ${fake.discordToken()}`], ["webhook", `post to ${fake.discordWebhook()}`], ["webhook", fake.slackWebhook()], ["api_key", fake.slackAppToken()],
  ];
  it.each(secrets)("%s in Agent instructions: no text, a finding with the field and line — and never the secret", (kind, line) => {
    const r = buildAgentExport("r", { systemPrompt: `fine\n${line}\nalso fine` }, ["systemPrompt"]);
    expect(r.text).toBeNull();
    expect(r.findings).toEqual([{ field: "systemPrompt", line: 2, kind }]);
    expect(JSON.stringify(r)).not.toContain(line.slice(-12));
  });
  it("is scanned in Description and the Agent instructions too, but only when that group is chosen", () => {
    const key = fake.labelledToken();
    expect(buildAgentExport("r", { description: key }, ["identity"]).findings[0]).toMatchObject({ field: "description" });
    expect(buildAgentExport("r", { systemPrompt: key }, ["systemPrompt"]).findings[0]).toMatchObject({ field: "systemPrompt" });
    expect(buildAgentExport("r", { systemPrompt: key, description: "ok" }, ["identity"]).text).not.toBeNull();
  });
  it("does not stop ordinary prose or placeholders", () => {
    expect(scanForSecrets("systemPrompt", "Store the token in the TOKEN env var. password: <your-password-here>\nset api_key: ${API_KEY}")).toEqual([]);
  });
});

describe("load: the round trip", () => {
  it("everything exported is read back (the fields the form has), under the form's own values", () => {
    const r = parseAgentExport(buildAgentExport("claude-kasa", saved, ALL).text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role).toBe("claude-kasa");
    expect(r.fill).toEqual({
      description: saved.description, tags: saved.tags, systemPrompt: "# Role\n\nBe exact.\n- one\n- two", model: "claude-sonnet-5-5", model_failover: "claude-haiku-5-5",
      tool_set: "coordinator", lightweight: true, hang_detector: 15, tool_progress: "standard", reply_completion_guard: false, log_level: "debug", auto_pause_after: 30,
      agent_mode: "cli", cross_instance_visibility: "summary", board_cards_at_once: 2, resume_interrupted_work: false,
    });
    // The one it does not fill, with the reason: the runtime switch.
    expect(r.skipped).toEqual([{ path: "agent.backend", reason: "runtimeSwitch" }]);
    expect(r.libraryUsed).toBe(false);
  });
  it("the limit is the editor's own, to the character", () => {
    // The editor's file imports browser-only modules, so its constant is read from the source.
    const ui = readFileSync(new URL("../src/ui/agent-instructions-field.js", import.meta.url), "utf8");
    expect(Number(/export const INSTRUCTIONS_MAX_CHARS = (\d+);/.exec(ui)?.[1])).toBe(AGENT_INSTRUCTIONS_MAX_CHARS);
  });
  it("Agent instructions are read back exactly (Markdown, quotes, colons, unicode, a long one)", () => {
    const text = `# 角色\n\nSay "hi": it's fine — 100%\n\n\`\`\`yaml\nkey: value\n\`\`\`\n${"x".repeat(AGENT_INSTRUCTIONS_MAX_CHARS - 80)}`;
    const r = parseAgentExport(buildAgentExport("r", { systemPrompt: text }, ["systemPrompt"]).text);
    expect(r.ok && r.fill.systemPrompt).toBe(text);
  });
});

describe("load: a hand-edited file", () => {
  const file = (body: string) => `agend_export: 1\nkind: agent\n${body}`;
  const skippedOf = (body: string) => { const r = parseAgentExport(file(body)); if (!r.ok) throw new Error(r.error); return Object.fromEntries(r.skipped.map((s) => [s.path, s.reason])); };
  it("skips every excluded field with its reason and fills nothing from it", () => {
    const r = parseAgentExport(file(`agent:
  working_directory: /etc
  channel_id: discord
  topic_id: "1"
  general_topic: true
  display_name: X
  machine_id: m
  runtime: windows
  native_sandbox: x
  backend_options: { claude-code: { credential_profile: me } }
  dashboard: { office: full }
  office_access: full
  skipPermissions: true
  pre_task_command: "rm -rf /"
  status_emojis: { received: "x" }
  quota_notice: {}
  workflow: wf
  cost_guard: {}
  restart_policy: {}
  profile: p
  something_new: 1
behavior:
  mcp_proxy_reply: true
  pre_task_command: x
`));
    expect(r.ok && r.fill).toEqual({});
    expect(skippedOf(`agent:\n  working_directory: /etc\n  channel_id: d\n  topic_id: "1"\n  general_topic: true\n  display_name: X\n  machine_id: m\n  runtime: windows\n  native_sandbox: x\n  backend_options: {}\n  dashboard: {}\n  office_access: full\n  skipPermissions: true\n  pre_task_command: x\n  status_emojis: {}\n  quota_notice: {}\n  workflow: wf\n  cost_guard: {}\n  profile: p\n  something_new: 1\nbehavior:\n  mcp_proxy_reply: true\n`)).toEqual({
      "agent.working_directory": "machine", "agent.channel_id": "binding", "agent.topic_id": "binding", "agent.general_topic": "binding", "agent.display_name": "name",
      "agent.machine_id": "machine", "agent.runtime": "machine", "agent.native_sandbox": "machine", "agent.backend_options": "account", "agent.dashboard": "permission",
      "agent.office_access": "permission", "agent.skipPermissions": "permission", "agent.pre_task_command": "command", "agent.status_emojis": "emoji", "agent.quota_notice": "notice",
      "agent.workflow": "fleetOnly", "agent.cost_guard": "fleetOnly", "agent.profile": "fleetOnly", "agent.something_new": "unknown", "behavior.mcp_proxy_reply": "permission",
    });
  });
  it("skips values that are the wrong type, not allowed or too long, and keeps the good ones beside them", () => {
    const r = parseAgentExport(file(`agent:
  description: 12
  tags: [a, 5]
  systemPrompt: ${JSON.stringify("x".repeat(AGENT_INSTRUCTIONS_MAX_CHARS + 1))}
  model: "bad model;rm"
  tool_set: god
  lightweight: "yes"
  model_failover: []
behavior:
  hang_detector: { timeout_minutes: -3 }
  tool_progress: loud
  auto_pause_after: -1
  agent_mode: x
  board_cards_at_once: 1.5
  log_level: info
`));
    if (!r.ok) throw new Error(r.error);
    expect(r.fill).toEqual({ log_level: "info" });
    expect(Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]))).toMatchObject({
      "agent.description": "badValue", "agent.tags": "badValue", "agent.systemPrompt": "tooLong", "agent.model": "badValue", "agent.tool_set": "badValue", "agent.lightweight": "badValue",
      "agent.model_failover": "badValue", "behavior.hang_detector": "badValue", "behavior.tool_progress": "badValue", "behavior.auto_pause_after": "badValue", "behavior.agent_mode": "badValue", "behavior.board_cards_at_once": "badValue",
    });
  });
  it("a file: reference in Agent instructions is never filled — it would make the daemon read a path on this computer", () => {
    for (const sp of ["file:~/.ssh/id_rsa", "Be brief, file:/etc/passwd", "file:prompts/a.md, file:prompts/b.md"]) {
      const r = parseAgentExport(file(`agent:\n  systemPrompt: ${JSON.stringify(sp)}\n  description: d\n`));
      if (!r.ok) throw new Error(r.error);
      expect(r.fill, sp).toEqual({ description: "d" });
      expect(r.skipped, sp).toEqual([{ path: "agent.systemPrompt", reason: "fileRef" }]);
    }
  });
  it("Agent instructions that are exactly at the limit load; a blank one fills nothing; a non-text one is a bad value", () => {
    const at = parseAgentExport(file(`agent:\n  systemPrompt: ${JSON.stringify("y".repeat(AGENT_INSTRUCTIONS_MAX_CHARS))}\n`));
    expect(at.ok && at.fill.systemPrompt?.length).toBe(AGENT_INSTRUCTIONS_MAX_CHARS);
    const blank = parseAgentExport(file("agent:\n  systemPrompt: '  '\n"));
    expect(blank.ok && blank.fill).toEqual({});
    const bad = parseAgentExport(file("agent:\n  systemPrompt: [a]\n"));
    expect(bad.ok && bad.skipped).toEqual([{ path: "agent.systemPrompt", reason: "badValue" }]);
  });
  it("a file from the earlier draft format (agent.instructions) is an unknown field, not silently loaded", () => {
    const r = parseAgentExport(file("agent:\n  instructions: '# Role'\n"));
    expect(r.ok && r.fill).toEqual({});
    expect(r.ok && r.skipped).toEqual([{ path: "agent.instructions", reason: "unknown" }]);
  });
  it("reads only the first of several fallback models and says so", () => {
    const r = parseAgentExport(file("agent:\n  model_failover: [a-1, b-2]\n"));
    expect(r.ok && r.fill.model_failover).toBe("a-1");
    expect(r.ok && r.extraFailover).toBe(true);
  });
  it("a unknown top-level key is skipped, a non-empty library is noted and never an error", () => {
    const r = parseAgentExport(file("extra: 1\nlibrary:\n  skills: [{ ref: ui-review, version: 1 }]\n  mcp: []\n  other: 1\nagent:\n  description: d\n"));
    if (!r.ok) throw new Error(r.error);
    expect(r.libraryUsed).toBe(true);
    expect(r.fill).toEqual({ description: "d" });
    expect(r.skipped).toEqual(expect.arrayContaining([{ path: "extra", reason: "unknown" }, { path: "library.other", reason: "unknown" }]));
  });
  it("an inherited-looking key (__proto__, constructor) is just an unknown field", () => {
    const r = parseAgentExport(file("agent:\n  __proto__: { polluted: 1 }\n  constructor: x\n  description: d\n"));
    if (!r.ok) throw new Error(r.error);
    expect(r.fill).toEqual({ description: "d" });
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe("load: files that are refused", () => {
  const err = (text: unknown) => { const r = parseAgentExport(text); return r.ok ? "ok" : r.error; };
  it("empty, too large, not YAML, not an export, a newer version, another kind", () => {
    expect(err("")).toBe("empty");
    expect(err(undefined)).toBe("empty");
    expect(err("agend_export: 1\n" + "a".repeat(AGENT_EXPORT_MAX_CHARS))).toBe("too_large");
    expect(err("agent: [unclosed")).toBe("invalid_yaml");
    expect(err("agent:\n  description: d\n")).toBe("not_export");
    expect(err("- a\n- b\n")).toBe("not_export");
    expect(err("agend_export: 2\nagent: {}\n")).toBe("unsupported_version");
    expect(err("agend_export: '1'\n")).toBe("unsupported_version");
    expect(err("agend_export: 1\nkind: fleet\n")).toBe("wrong_kind");
  });
  it("duplicate keys and aliases (nothing to expand) are refused", () => {
    expect(err("agend_export: 1\nagent:\n  description: a\n  description: b\n")).toBe("invalid_yaml");
    expect(err("agend_export: 1\nagent:\n  tags: &t [a]\n  description: *t\n")).toBe("invalid_yaml");
  });
  it("custom tags do not become code or binary: the value stays plain text", () => {
    const r = parseAgentExport("agend_export: 1\nagent:\n  description: !!js/function 'x'\n  tags: !!binary aGk=\n");
    if (!r.ok) throw new Error(r.error);
    expect(r.fill.description).toBe("x");
    expect(r.fill.tags).toBeUndefined();
  });
});

// ── deploy_template: Agent instructions are the template role's `systemPrompt`; there is no second field ──

const dirs: string[] = [];
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("deploy_template: a role's Agent instructions travel as systemPrompt only", () => {
  const rig = (instanceDef: Record<string, unknown>) => {
    const handleCreate = vi.fn(async (_a: unknown, respond: (r: unknown) => void) => respond({ name: "x", status: "running" }));
    const ctx: any = {
      fleetConfig: { defaults: {}, instances: { x: {} }, templates: { t: { instances: { a: instanceDef } } }, teams: {} },
      lifecycle: { handleCreate }, getWorldForInstance: vi.fn(), saveFleetConfig: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    };
    return { ctx, handleCreate };
  };
  const deploy = async (instanceDef: Record<string, unknown>) => {
    const r = rig(instanceDef);
    let error: unknown = null;
    await outboundHandlers.get("deploy_template")!(r.ctx, { template: "t", directory: temp("agend-163-") }, (_res: unknown, e: unknown) => { error = e ?? null; }, undefined as any);
    return { ...r, error };
  };
  it("passes a template role's systemPrompt to the instance it creates, and nothing named instructions", async () => {
    const { handleCreate, error } = await deploy({ description: "d", systemPrompt: "# Role\nBe exact.", instructions: "# old draft key" });
    expect(error).toBeNull();
    const args = handleCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({ description: "d", systemPrompt: "# Role\nBe exact." });
    expect(args).not.toHaveProperty("instructions");
  });
  it("a template with no systemPrompt creates exactly what it did before", async () => {
    const { handleCreate } = await deploy({ description: "d", tool_set: "worker", lightweight: false, tags: ["t"] });
    const args = handleCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["description", "directory", "lightweight", "tags", "tool_set", "topic_name"]);
  });
});

describe("create_instance: there is no separate instructions argument either", () => {
  async function created(args: Record<string, unknown>) {
    const dataDir = temp("agend-163-fleet-");
    const configPath = join(dataDir, "fleet.yaml");
    writeFileSync(configPath, yaml.dump({ instances: { general: { working_directory: temp("agend-163-g-"), general_topic: true } } }));
    const fm = new FleetManager(dataDir);
    vi.spyOn(fm as any, "startCliEnvProbeWorker").mockReturnValue({ promise: Promise.resolve(null), stopped: Promise.resolve(), terminate() {} });
    fm.loadConfig(configPath);
    vi.spyOn(fm, "createForumTopic").mockResolvedValue("901" as any);
    vi.spyOn(fm.lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
    let name = "", error: string | undefined;
    await fm.lifecycle.handleCreate({ directory: temp("agend-163-p-"), topic_name: "pomodoro", ...args } as any, (r: any, e?: string) => { name = r?.name; error = e; });
    expect(error).toBeUndefined();
    return (yaml.load(readFileSync(configPath, "utf8")) as any).instances[name] as Record<string, unknown>;
  }
  it("systemPrompt is written as given; a stray instructions argument writes no instructions key", async () => {
    expect((await created({ systemPrompt: "# Role\nBe exact." })).systemPrompt).toBe("# Role\nBe exact.");
    expect(await created({ instructions: "# Role" })).not.toHaveProperty("instructions");
  });
});

describe("review follow-ups (AGEND-166)", () => {
  it("a key that is also an Object.prototype name is an unknown field, never an undefined reason", () => {
    const r = parseAgentExport("agend_export: 1\nagent:\n  constructor: x\n  toString: y\n  hasOwnProperty: z\nbehavior:\n  valueOf: 1\n");
    if (!r.ok) throw new Error(r.error);
    expect(r.skipped.map((s) => s.reason)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
  });
  it("more secret shapes stop the file (Stripe, Hugging Face) and tags are scanned too", () => {
    expect(buildAgentExport("r", { systemPrompt: `key ${fake.stripeKey()}` }, ["systemPrompt"]).findings[0]).toMatchObject({ kind: "api_key" });
    expect(buildAgentExport("r", { systemPrompt: fake.hfToken() }, ["systemPrompt"]).text).toBeNull();
    expect(buildAgentExport("r", { tags: ["ok", fake.anthropicKey()] }, ["identity"]).findings[0]).toMatchObject({ field: "tags" });
  });
  it("a secret deep inside a very long line is still found, and a long line does not take long to scan", () => {
    const long = `${"a-".repeat(40_000)} ${fake.anthropicKey()} ${"b".repeat(1000)}`;
    const t0 = Date.now();
    expect(scanForSecrets("systemPrompt", long)).toEqual([{ field: "systemPrompt", line: 1, kind: "api_key" }]);
    expect(scanForSecrets("systemPrompt", "a-".repeat(100_000))).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("FleetManager.rawInstanceConfig: the agent's own saved settings, not the merged ones (AGEND-163 review)", () => {
  it("has fleet.yaml's keys for the agent — no defaults merged in — while fleetConfig has them merged", () => {
    const dataDir = temp("agend-163-raw-");
    const configPath = join(dataDir, "fleet.yaml");
    writeFileSync(configPath, yaml.dump({
      defaults: { backend: "codex", model: "gpt-5", log_level: "debug", systemPrompt: "Fleet-wide rules." },
      instances: { dev: { working_directory: temp("agend-163-w-"), description: "My dev agent" }, odd: "not an object" },
    }));
    const fm = new FleetManager(dataDir);
    vi.spyOn(fm as any, "startCliEnvProbeWorker").mockReturnValue({ promise: Promise.resolve(null), stopped: Promise.resolve(), terminate() {} });
    fm.loadConfig(configPath);
    expect(Object.keys(fm.rawInstanceConfig("dev")!).sort()).toEqual(["description", "working_directory"]);
    expect((fm.fleetConfig as any).instances.dev.systemPrompt).toBe("Fleet-wide rules.");     // the merged copy does have it
    expect(fm.rawInstanceConfig("nobody")).toBeUndefined();
    expect(fm.rawInstanceConfig("__proto__")).toBeUndefined();
    expect(fm.rawInstanceConfig("constructor")).toBeUndefined();
    expect(fm.rawInstanceConfig("odd")).toBeUndefined();
  });
});
