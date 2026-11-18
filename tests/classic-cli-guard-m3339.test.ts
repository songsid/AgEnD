import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import type { CliBackendConfig } from "../src/backend/types.js";
import { classicGuardStatus, classicOwnerMcpServers, classicPlanDigest, invalidateClassicGuard, stageClaudeClassicGuard, type ClassicRestrictedPlan } from "../src/classic-cli-guard.js";
import { CLASSIC_RESTRICTED_TOOLS } from "../src/contact-auth-types.js";

const versionReader = vi.hoisted(() => vi.fn(async () => "2.1.327"));
vi.mock("../src/backend-version-static.js", async original => ({ ...await original<typeof import("../src/backend-version-static.js")>(), staticBackendVersion: versionReader }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("loads a fail-closed room guard instead of the unrestricted Claude launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "classic-guard-test-")); roots.push(root);
  const instanceDir = join(root, "instance"), cwd = join(root, "room");
  mkdirSync(instanceDir); mkdirSync(cwd);
  const binary = join(root, "fixture-binary"); writeFileSync(binary, "fixture only, never executed");
  const backend = new ClaudeCodeBackend(instanceDir); backend.refreshLaunchBinary(binary);
  const config = { instanceDir, workingDirectory: cwd, instanceName: "sample-room", skipResume: true,
    mcpServers: { agend: { command: process.execPath, args: ["/fixture/mcp-server.js"], env: {} } },
    classicRestriction: { roomKey: "sample-room", policyRevision: 1, publicRead: true,
      allowedAgendTools: ["reply"], allowedMcpTools: [] } } as CliBackendConfig;
  await (backend as typeof backend & { prepareLaunch?(c: CliBackendConfig): Promise<void> }).prepareLaunch?.(config);
  backend.writeConfig(config);
  const command = backend.buildCommand(config);
  expect(command).toContain(binary);
  expect(command).toContain("--strict-mcp-config");
  expect(command).toContain("--setting-sources ''");
  expect(command).toContain("--tools 'WebSearch,WebFetch'");
  expect(command).not.toContain("--dangerously-skip-permissions");
  expect(command).toContain("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0");
  expect(command).toContain("CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0");
  // The selected per-launch settings path is deliberately quoted.
  const settingsPath = /--settings '([^']+)'/.exec(command)![1]!;
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(settings.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: "command", onFailure: "block" });
  expect(settings.hooks.UserPromptSubmit[0].hooks[0].onFailure).toBe("block");
});

const plan = (): ClassicRestrictedPlan => ({ roomKey: "sample-room", policyRevision: 1, publicRead: true,
  allowedAgendTools: [...CLASSIC_RESTRICTED_TOOLS], allowedMcpTools: [{ name: "mcp__selected__lookup", kind: "mcp", usesOwnerAccount: false }] });
function stage(version = "2.1.327", platform: NodeJS.Platform = "linux", prefix = "classic-guard-unit-") {
  const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root);
  const p = plan();
  const result = stageClaudeClassicGuard({ plan: p, version, platform, instanceDir: root, cwd: root,
    mcpServers: { agend: { command: "node", args: [], env: {} }, selected: { command: "node", args: [], env: {} }, excluded: { command: "node", args: [], env: {} } }, settings: {} });
  const launch = result.launch;
  const run = (event: Record<string, unknown>) => spawnSync(process.execPath, [launch!.hookPath, launch!.policyPath], {
    input: JSON.stringify({ session_id: "fixture-session", cwd: root, ...event }), encoding: "utf8", timeout: 5000,
  });
  return { root, p, result, launch: launch!, run, load: () => run({ hook_event_name: "SessionStart" }) };
}
it("requires the current launch's actual hook load, not generated settings or an old receipt", () => {
  const w = stage();
  expect(classicGuardStatus(w.launch, w.p).state).toBe("restart-required");
  expect(w.run({ hook_event_name: "PreToolUse", tool_name: "mcp__agend__reply" }).status).toBe(2);
  expect(w.load().status).toBe(0);
  expect(classicGuardStatus(w.launch, w.p).state).toBe("ready");
  expect(w.run({ hook_event_name: "UserPromptSubmit" }).status).toBe(0);
  expect(w.run({ hook_event_name: "UserPromptSubmit", session_id: "another-session" }).status).toBe(2);
  expect(w.run({ hook_event_name: "PreToolUse", tool_name: "mcp__agend__reply", cwd: join(w.root, "another-room") }).status).toBe(2);
  expect(classicGuardStatus(w.launch, { ...w.p, policyRevision: 2 }).state).toBe("restart-required");
  invalidateClassicGuard(w.root);
  expect(classicGuardStatus(w.launch, w.p).state).toBe("restart-required");
  expect(w.run({ hook_event_name: "PreToolUse", tool_name: "mcp__agend__reply" }).status).toBe(2);
  expect(w.load().status).toBe(2);
});
it("keeps public reading and exact room tools, and denies file, shell, agent and unselected MCP calls", () => {
  const w = stage(); expect(w.load().status).toBe(0);
  for (const name of ["WebSearch", "WebFetch", ...CLASSIC_RESTRICTED_TOOLS.map(n => `mcp__agend__${n}`), "mcp__selected__lookup"])
    expect(w.run({ hook_event_name: "PreToolUse", tool_name: name, tool_input: name === "WebFetch" ? { url: "https://example.com" } : {} }).status, name).toBe(0);
  for (const name of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "Agent", "Task", "Skill", "CodeMode",
    "mcp__agend__create_instance", "mcp__agend__task", "mcp__selected__write", "mcp__excluded__lookup", "WebSearchAnything"])
    expect(w.run({ hook_event_name: "PreToolUse", tool_name: name }).status, name).toBe(2);
  expect(Object.keys(JSON.parse(readFileSync(w.launch.mcpPath, "utf8")).mcpServers)).toEqual(["agend", "selected"]);
});
it("a policy, MCP config, hook, settings or receipt mutation cannot preserve ready", () => {
  for (const field of ["policyPath", "mcpPath", "hookPath", "settingsPath", "receiptPath"] as const) {
    const w = stage(); expect(w.load().status).toBe(0);
    writeFileSync(w.launch[field], "{}");
    expect(classicGuardStatus(w.launch, w.p).state, field).toBe("failed");
    if (field !== "hookPath") expect(w.run({ hook_event_name: "PreToolUse", tool_name: "mcp__agend__reply" }).status, field).toBe(2);
  }
  const w = stage(); expect(w.load().status).toBe(0); unlinkSync(w.launch.policyPath);
  expect(w.run({ hook_event_name: "UserPromptSubmit" }).status).toBe(2);
});
it("reports unproved platforms/versions and CLI mode honestly", () => {
  for (const version of ["2.1.294", "2.1.326", "2.1.328", "unknown"])
    expect(stage(version).result).toMatchObject({ status: { state: "not-covered" } });
  for (const platform of ["win32", "darwin"] as const)
    expect(stage("2.1.327", platform).result).toMatchObject({ status: { state: "not-covered" } });
  const w = stage();
  expect(stageClaudeClassicGuard({ plan: w.p, version: "2.1.327", platform: "linux", agentMode: "cli",
    instanceDir: w.root, cwd: w.root, mcpServers: {}, settings: {} }).status.state).toBe("not-covered");
  expect(stageClaudeClassicGuard({ plan: w.p, version: "2.1.327", platform: "linux", architecture: "arm64",
    instanceDir: w.root, cwd: w.root, mcpServers: {}, settings: {} }).status.state).toBe("not-covered");
});
it("refuses wildcard/native MCP selections and owner-account tools without the warning", () => {
  for (const name of ["*", "Bash", "mcp__selected__*", "mcp__agend__create_instance"])
    expect(() => classicPlanDigest({ ...plan(), allowedMcpTools: [{ name, kind: "mcp", usesOwnerAccount: false }] })).toThrow("invalid-policy");
  expect(() => classicPlanDigest({ ...plan(), allowedAgendTools: ["create_instance"] })).toThrow("invalid-policy");
  expect(() => classicPlanDigest({ ...plan(), allowedMcpTools: [{ name: "mcp__selected__lookup", kind: "mcp", usesOwnerAccount: true }] })).toThrow("invalid-policy");
});
it("loads its real shell-form command from paths containing spaces and apostrophes", () => {
  const w = stage("2.1.327", "linux", "classic's guard ");
  const command = JSON.parse(readFileSync(w.launch.settingsPath, "utf8")).hooks.SessionStart[0].hooks[0].command;
  const preload = join(w.root, "preload.cjs"), canary = join(w.root, "must-not-load");
  writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(canary)},'unexpected')`);
  const result = spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "fixture-session", cwd: w.root }),
    env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(canary)).toBe(false);
  expect(classicGuardStatus(w.launch, w.p).state).toBe("ready");
});
it("copies only a selected owner-level stdio definition with its warning, never project definitions or credentials in status", () => {
  const w = stage(), path = join(w.root, ".claude.json"), selected = { command: "node", args: ["fixture.mjs"], env: { PRIVATE_FIXTURE: "must-stay-private" } };
  writeFileSync(path, JSON.stringify({ mcpServers: { selected, excluded: selected }, projects: { room: { mcpServers: { project: selected } } } }));
  const approved = { ...w.p, allowedMcpTools: [{ name: "mcp__selected__lookup", kind: "mcp" as const, usesOwnerAccount: true, accountWarning: "Uses the owner's account and quota" }] };
  const configured = { agend: { command: "node", args: [], env: {} } };
  expect(classicOwnerMcpServers(approved, path, configured)).toEqual({ ...configured, selected });
  expect(classicOwnerMcpServers(w.p, path, configured)).toEqual(configured); // Warning was not accepted.
  const absent = { ...approved, allowedMcpTools: [{ ...approved.allowedMcpTools[0]!, name: "mcp__project__lookup" }] };
  const servers = classicOwnerMcpServers(absent, path, configured);
  expect(servers).toEqual(configured);
  const missing = stageClaudeClassicGuard({ plan: absent, version: "2.1.327", platform: "linux", instanceDir: w.root,
    cwd: w.root, mcpServers: servers, settings: {} });
  expect(missing.launch).toBeTruthy(); // Base protection and public reading still launch.
  const policy = JSON.parse(readFileSync(missing.launch!.policyPath, "utf8"));
  expect(policy.allowed).toContain("WebSearch"); expect(policy.allowed).toContain("mcp__agend__reply");
  expect(policy.allowed).not.toContain("mcp__project__lookup");
  spawnSync(process.execPath, [missing.launch!.hookPath, missing.launch!.policyPath], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "fixture", cwd: w.root }), encoding: "utf8",
  });
  expect(classicGuardStatus(missing.launch!, absent)).toMatchObject({ state: "not-covered", reason: "missing-selected-mcp" });
  expect(JSON.stringify(classicGuardStatus(missing.launch!, absent))).not.toContain("must-stay-private");
  writeFileSync(path, JSON.stringify({ mcpServers: { selected: { type: "http", url: "https://example.com/mcp" } } }));
  expect(classicOwnerMcpServers(approved, path, configured)).toEqual(configured);
});
it("fences a replaced binary and never carries a prior version through a failed static read", async () => {
  const root = mkdtempSync(join(tmpdir(), "classic-binary-test-")); roots.push(root);
  const binary = join(root, "fixture-binary"); writeFileSync(binary, "fixture only, never executed");
  const backend = new ClaudeCodeBackend(root); backend.refreshLaunchBinary(binary);
  const config = { instanceDir: root, workingDirectory: root, instanceName: "sample-room", skipResume: true,
    mcpServers: { agend: { command: process.execPath, args: [], env: {} } }, classicRestriction: { ...plan(), allowedMcpTools: [] } };
  await backend.prepareLaunch(config); backend.writeConfig(config);
  expect(backend.buildCommand(config)).toContain("--strict-mcp-config");
  expect(backend.classicNativeGuard(config.classicRestriction).version).toBe("2.1.327");
  writeFileSync(binary, "replaced fixture binary, still never executed");
  expect(backend.classicNativeGuard(config.classicRestriction)).toMatchObject({ state: "failed", reason: "binary-changed" });
  expect(() => backend.buildCommand(config)).toThrow("binary changed");
  versionReader.mockRejectedValueOnce(Error("static metadata unavailable"));
  await expect(backend.prepareLaunch(config)).rejects.toThrow("metadata unavailable");
  backend.writeConfig(config);
  expect(backend.classicNativeGuard(config.classicRestriction).state).toBe("not-covered");
});
it("refuses explicit non-public WebFetch targets without blocking normal public URLs", () => {
  const w = stage(); expect(w.load().status).toBe(0);
  const fetch = (url: unknown) => w.run({ hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: { url } });
  const withCredentials = new URL("https://example.com/"); withCredentials.username = "fixture"; withCredentials.password = "placeholder";
  for (const url of ["file:///tmp/fixture", "http://localhost/", "https://LOCALHOST./", "http://service.localhost/",
    "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/",
    "http://0.0.0.0/", "http://10.0.0.1/", "http://172.16.0.1/", "http://192.168.0.1/", "http://169.254.169.254/",
    "http://100.64.0.1/", "http://198.18.0.1/", "http://192.0.2.1/", "http://224.0.0.1/",
    "http://[::1]/", "http://[::]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
    "http://[fc00::1]/", "http://[fe80::1]/", "http://[ff02::1]/", "http://[2001:db8::1]/",
    "http://room-service/", "https://room-service.internal/", "https://room-service.local/", "https://room-service.home.arpa/",
    "https://room-service.lan/", "https://example.test/", withCredentials.href, "not a URL", null, {}])
    expect(fetch(url).status, String(url)).toBe(2);
  for (const url of ["https://example.com/page", "http://example.com/", "https://example.com./page?q=1",
    "https://8.8.8.8/", "https://1.1.1.1/", "https://[2606:4700:4700::1111]/", "https://[2001:4860:4860::8888]/"])
    expect(fetch(url).status, url).toBe(0);
  expect(fetch("file:///tmp/fixture").stderr).toContain("WebFetch requires a public HTTP(S) target");
});
