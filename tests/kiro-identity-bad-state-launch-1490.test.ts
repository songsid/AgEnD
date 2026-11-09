/**
 * #1490 row 49 at launch: the production KiroBackend (writeConfig + buildCommand) with one malformed entry beside a valid
 * key in the identity state file. The launch stays isolated — a fresh conversation as the instance's agent, never kiro's
 * own newest-in-directory `--resume` — the file is kept byte for byte, and the warning names it. Scratch homes only; no
 * kiro-cli is run (the compatibility is given).
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFileSync: vi.fn(() => { throw new Error("no kiro-cli"); }) }));
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroBackend, type KiroCliCompatibility } from "../src/backend/kiro.js";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "acc3025-")); vi.stubEnv("AGEND_HOME", join(root, "agend")); vi.stubEnv("XDG_DATA_HOME", join(root, "xdg")); vi.stubEnv("KIRO_HOME", join(root, "kh")); mkdirSync(join(root, "agend", "instances", "worker"), { recursive: true }); mkdirSync(join(root, "work")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const COMPAT: KiroCliCompatibility = { version: "kiro-cli 2.34.0", supportsLegacyUi: true, supportsTui: true, supportsV3: true, agentEngines: ["v2", "v1", "v3"], supportsEffortFlag: true, supportsInstanceAgent: true, source: "version" };
it("a malformed entry beside a valid key: --agent (never --resume), the file kept, the warning names it", () => {
  const dir = join(root, "agend", "instances", "worker");
  const cfg = (o = {}) => ({ workingDirectory: join(root, "work"), instanceDir: dir, instanceName: "worker", mcpServers: { agend: { command: "node", args: ["s.js"], env: {} } }, instructions: "# AgEnD\nhi", kiroAgentEngine: "v1", ...o }) as never;
  const launch = (o = {}) => { const b = new KiroBackend(dir, COMPAT); b.writeConfig(cfg(o)); const cmd = b.buildCommand(cfg(o)); return { cmd: cmd.replace(/\S*kiro-cli\S*/, "kiro-cli").replace(root, "<scratch>"), warning: b.consumeLaunchWarning() }; };
  const out: string[] = [];
  const st = join(root, "agend", "kiro-identity", "instances", createHash("sha256").update("worker").digest("hex").slice(0, 32) + ".json");
  const first = launch();
  out.push(`1 clean launch: ${first.cmd.split(" ").filter(w => /^--/.test(w)).join(" ")} | warning=${first.warning}`);
  const s = JSON.parse(readFileSync(st, "utf8")); out.push(`  state keys after 1: ${Object.keys(s.keys).length}`);
  s.keys['["v1","/elsewhere","broken"]'] = { engine: "v1", workingDirectory: 42 };
  const bad = JSON.stringify(s) + "\n"; writeFileSync(st, bad);
  // Control: a sibling instance in the same directory holds its own conversation's claim.
  const claims = join(root, "agend", "kiro-identity", "claims", "v1");
  mkdirSync(claims, { recursive: true });
  writeFileSync(join(claims, "sibling-conv"), "other\n");
  const claimsBefore = readdirSync(claims).sort().map(f => f + "=" + readFileSync(join(claims, f), "utf8")).join(";");
  const second = launch();
  out.push(`2 malformed entry beside the valid key: ${second.cmd.split(" ").filter(w => /^--/.test(w)).join(" ")} | warning=${second.warning}`);
  out.push(`  state file byte-identical: ${readFileSync(st, "utf8") === bad}; keys now ${Object.keys(JSON.parse(readFileSync(st, "utf8")).keys).length}`);
  const mcp = join(root, "work", ".kiro", "settings", "mcp.json");
  out.push(`  shared mcp.json has this instance's entry: ${existsSync(mcp) ? Object.keys(JSON.parse(readFileSync(mcp, "utf8")).mcpServers ?? {}).join(",") : "none"}`);
  out.push(`  agents dir: ${existsSync(join(root, "work", ".kiro", "agents")) ? readdirSync(join(root, "work", ".kiro", "agents")).join(",") : "none"}`);
  expect(first.cmd).toMatch(/ --agent\b/);
  expect(second.cmd).toMatch(/ --agent\b/);
  expect(second.cmd).not.toMatch(/--resume/);
  expect(second.warning).toContain(st);
  expect(second.warning).toContain("cannot be fully read");
  expect(readFileSync(st, "utf8")).toBe(bad);
  expect(readdirSync(claims).sort().map(f => f + "=" + readFileSync(join(claims, f), "utf8")).join(";")).toBe(claimsBefore);
  if (process.env.ACC_OUT) writeFileSync(process.env.ACC_OUT, out.join("\n").replaceAll(root, "<scratch>") + "\n");
});
