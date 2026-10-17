/**
 * #2010 (a): an opt-in Claude prompt-cache TTL per instance — `backend_options.claude-code.prompt_cache_ttl: "1h" | "5m"`.
 * Unset (the default) leaves the launch command exactly as it was, so the CLI chooses. A value adds
 * CLAUDE_CODE_PROMPT_CACHE_TTL and CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL to the launch env; it takes effect on the next
 * launch. The validator refuses anything else, on an instance and in defaults.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { promptCacheTtl } from "../src/backend/types.js";
import { validateFleetConfig } from "../src/config-validator.js";

const ENV = ["AGEND_HOME", "HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};
let root: string, inst: string, work: string;
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "agend-2010-"));
  inst = join(root, "inst"); work = join(root, "work");
  for (const d of [join(root, "agend"), join(root, "home"), inst, work]) mkdirSync(d, { recursive: true });
  process.env.AGEND_HOME = join(root, "agend"); process.env.HOME = join(root, "home");
  delete process.env.CLAUDE_CONFIG_DIR; delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_BASE_URL;
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});
const backend = () => { const b = new ClaudeCodeBackend(inst); (b as any).binaryPath = "/usr/bin/claude"; return b; };
const cfg = (backendOptions?: Record<string, unknown>) => ({ workingDirectory: work, instanceDir: inst, instanceName: "w", mcpServers: {}, skipPermissions: true, ...(backendOptions ? { backendOptions } : {}) }) as any;
const BIN = (i: string) => `/usr/bin/claude --settings ${i}/claude-settings.json --mcp-config ${i}/mcp-config.json --dangerously-skip-permissions`;
const TODAY = (i: string) => `CMUX_CLAUDE_HOOKS_DISABLED=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 ${BIN(i)}`;

describe("the launch env", () => {
  it("unset, or a value it does not know: the command is exactly today's", () => {
    for (const opts of [undefined, {}, { prompt_cache_ttl: "" }, { prompt_cache_ttl: "2h" }, { prompt_cache_ttl: 1 }, { prompt_cache_ttl: "1H" }]) {
      expect(backend().buildCommand(cfg(opts)), JSON.stringify(opts)).toBe(TODAY(inst));
    }
  });
  it("\"1h\" and \"5m\": the main thread's and the subagents' TTL, before the binary", () => {
    for (const ttl of ["1h", "5m"]) {
      expect(backend().buildCommand(cfg({ prompt_cache_ttl: ttl }))).toBe(
        `CMUX_CLAUDE_HOOKS_DISABLED=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 CLAUDE_CODE_PROMPT_CACHE_TTL=${ttl} CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=${ttl} ${BIN(inst)}`);
    }
  });
  it("beside a credential profile: both", () => {
    const cmd = backend().buildCommand(cfg({ credential_profile: "work", prompt_cache_ttl: "1h" }));
    expect(cmd).toMatch(/ CLAUDE_CONFIG_DIR=\S+ CLAUDE_CODE_PROMPT_CACHE_TTL=1h CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h \/usr\/bin\/claude /);
  });
  it("promptCacheTtl reads only the two values", () => {
    expect([promptCacheTtl(undefined), promptCacheTtl({}), promptCacheTtl({ prompt_cache_ttl: "1h" }), promptCacheTtl({ prompt_cache_ttl: "5m" }), promptCacheTtl({ prompt_cache_ttl: "10m" })])
      .toEqual([null, null, "1h", "5m", null]);
  });
});

describe("the validator", () => {
  const conf = (where: "instance" | "defaults", value: unknown, backend = "claude-code") => {
    const options = { backend_options: { [backend]: { prompt_cache_ttl: value } } };
    return where === "defaults" ? { defaults: options, instances: {} } : { defaults: {}, instances: { w: { working_directory: "/tmp/w", ...options } } };
  };
  const paths = (c: unknown) => validateFleetConfig(c as never).errors.map((e: { path: string }) => e.path);
  it("accepts 1h and 5m on an instance and in defaults", () => {
    for (const where of ["instance", "defaults"] as const) for (const v of ["1h", "5m"]) expect(paths(conf(where, v)), `${where} ${v}`).toEqual([]);
  });
  it("refuses anything else, naming the key", () => {
    for (const v of ["2h", "1H", "", 1, true, null]) {
      expect(paths(conf("instance", v)), JSON.stringify(v)).toEqual(["instances.w.backend_options.claude-code.prompt_cache_ttl"]);
      expect(paths(conf("defaults", v)), JSON.stringify(v)).toEqual(["defaults.backend_options.claude-code.prompt_cache_ttl"]);
    }
    expect(validateFleetConfig(conf("instance", "2h") as never).errors[0]!.message).toBe("must be one of: 1h, 5m");
  });
  it("is a claude-code key: another backend's namespace does not check it", () => {
    expect(paths(conf("instance", "2h", "codex"))).toEqual([]);
  });
});
