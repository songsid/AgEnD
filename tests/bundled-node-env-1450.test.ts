/**
 * #1450 (leader, from a user question: "does the bundled Node affect codex and the other CLIs I installed?"). AgEnD's
 * own Node runs AgEnD and nothing else:
 *   1. the service's PATH (rendered unit / plist) — which the fleet, its tmux server and every instance inherit — never
 *      contains the bundled runtime's directory, even when AgEnD itself runs on that Node;
 *   2. so a CLI npm installed with `#!/usr/bin/env node` (codex, claude…) resolves the system (or nvm) Node there;
 *   3. while the MCP server AgEnD registers with those CLIs is started by AgEnD's own Node, by absolute path — and each
 *      instance start rewrites it, so an upgrade (2.1's `node` from PATH → the bundled Node) leaves no stale command.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServicePath, renderLaunchdPlist, renderSystemdUnit } from "../src/service-installer.js";
import { CodexBackend } from "../src/backend/codex.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** A global npm prefix with AgEnD and its bundled runtime, plus a system Node elsewhere — each a marker `node`. */
function host() {
  const root = mkdtempSync(join(tmpdir(), "agend-bundled-env-"));
  roots.push(root);
  const prefix = join(root, "prefix");
  const pkg = join(prefix, "lib", "node_modules", "@songsid", "agend");
  const runtimeBin = join(pkg, "node_modules", "@songsid", "agend-node-linux-x64", "bin");
  const systemBin = join(root, "system", "bin");
  for (const [dir, who] of [[runtimeBin, "bundled"], [systemBin, "system"]] as const) {
    mkdirSync(dir, { recursive: true });
    // A `node` that says which one it is (then exits): what `#!/usr/bin/env node` would run.
    writeFileSync(join(dir, "node"), `#!/bin/sh\necho ${who}-node\n`);
    chmodSync(join(dir, "node"), 0o755);
  }
  mkdirSync(join(pkg, "dist"), { recursive: true });
  const entry = join(pkg, "dist", "cli.js");
  writeFileSync(entry, "");
  // An npm-installed CLI, as codex is: a script whose interpreter is `env node`.
  const fakeCli = join(prefix, "bin", "npm-installed-cli");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(fakeCli, "#!/usr/bin/env node\n");
  chmodSync(fakeCli, 0o755);
  return { root, prefix, pkg, entry, runtimeBin, runtimeNode: join(runtimeBin, "node"), systemBin, fakeCli };
}
const pathOf = (unit: string) => /^Environment=PATH=(.*)$/m.exec(unit)?.[1] ?? "";
const plistPath = (plist: string) => /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? "";

describe("1. the service PATH never contains the bundled runtime, even when AgEnD runs on it", () => {
  it("buildServicePath: the runtime directory is dropped from the base PATH AND never added as this Node's fallback", () => {
    const h = host();
    const base = [h.runtimeBin, join(h.prefix, "lib", "node_modules", ".bin"), h.systemBin, "/usr/bin"].join(":");
    const path = buildServicePath(base, h.entry, join(h.root, "home"), h.runtimeNode).split(":");
    expect(path).not.toContain(h.runtimeBin);
    expect(path.filter(d => d.includes("/node_modules/"))).toEqual([]);
    expect(path).toContain(h.systemBin);
    expect(path).toContain(join(h.prefix, "bin"));                   // the npm prefix's bin (where codex lives) stays
  });

  it("the rendered unit and plist carry that PATH: no runtime directory in either", () => {
    const h = host();
    const vars = { label: "com.agend.fleet", execPath: h.entry, nodePath: h.runtimeNode, path: [h.runtimeBin, h.systemBin, "/usr/bin"].join(":"), workingDirectory: h.root, logPath: join(h.root, "fleet.log") };
    for (const path of [pathOf(renderSystemdUnit(vars)), plistPath(renderLaunchdPlist(vars))]) {
      expect(path).not.toBe("");
      expect(path.split(":")).not.toContain(h.runtimeBin);
      expect(path).not.toContain("/agend-node-");
    }
  });
});

describe("2. in that environment an npm-installed `#!/usr/bin/env node` CLI runs on the system Node", () => {
  it("a fake npm-installed CLI (as codex is), run with the rendered PATH, reaches the system node — never the bundled one", () => {
    const h = host();
    const vars = { label: "com.agend.fleet", execPath: h.entry, nodePath: h.runtimeNode, path: [h.runtimeBin, h.systemBin, "/usr/bin", "/bin"].join(":"), workingDirectory: h.root, logPath: join(h.root, "fleet.log") };
    const path = pathOf(renderSystemdUnit(vars));
    const r = spawnSync(h.fakeCli, [], { encoding: "utf8", env: { PATH: path, HOME: join(h.root, "home") } });
    expect(r.stdout.trim()).toBe("system-node");
    // The fleet passes this PATH on unchanged: no backend sets PATH for an instance's command (checked across src/backend).
    const backendSources = spawnSync("grep", ["-rlE", "\\bPATH=|\\.PATH ?=|\\bPATH:", join(process.cwd(), "src", "backend")], { encoding: "utf8" });
    expect(backendSources.stdout.trim()).toBe("");
  });
});

describe("3. the MCP server AgEnD registers runs on AgEnD's Node, by absolute path, rewritten at each start", () => {
  const saved = { AGEND_HOME: process.env.AGEND_HOME, CODEX_HOME: process.env.CODEX_HOME };
  let root: string, instance: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agend-bundled-mcp-"));
    instance = join(root, "agend", "instances", "worker-t1");
    process.env.AGEND_HOME = join(root, "agend");
    process.env.CODEX_HOME = join(root, "shared");
    mkdirSync(instance, { recursive: true });
    mkdirSync(join(root, "shared"), { recursive: true });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(root, { recursive: true, force: true });
  });
  const BUNDLED = "/opt/prefix/lib/node_modules/@songsid/agend/node_modules/@songsid/agend-node-linux-x64/bin/node";
  const config = (command: string) => ({
    workingDirectory: instance, instanceDir: instance, instanceName: "worker",
    mcpServers: { agend: { command, args: ["/opt/prefix/lib/node_modules/@songsid/agend/dist/channel/mcp-server.js"], env: {} } },
  });

  it("codex: the instance's config.toml names the bundled Node; a 2.1-era `node` entry (shared or private) is replaced", () => {
    // What 2.1 left behind: an AgEnD table in the user's shared config whose command is `node` from PATH.
    writeFileSync(join(root, "shared", "config.toml"), `model = "gpt-5"\n\n[mcp_servers.agend]\ncommand = "node"\nargs = ["/old/mcp-server.js"]\n`);
    const backend = new CodexBackend(instance);
    backend.writeConfig(config("node"));                                // the first start, before the upgrade
    backend.writeConfig(config(BUNDLED));                               // the next start, on the bundled Node
    const toml = readFileSync(join(CodexBackend.shortHomeFor(instance), "config.toml"), "utf8");
    expect(toml).toContain(`command = "${BUNDLED}"`);
    expect(toml).not.toMatch(/command = "node"/);
    expect(toml).toContain(`model = "gpt-5"`);                          // the user's own settings are kept
  });

  it("claude: mcp-config.json names the bundled Node and is rewritten at each start", () => {
    const backend = new ClaudeCodeBackend(instance);
    backend.writeConfig(config("node"));
    backend.writeConfig(config(BUNDLED));
    const json = JSON.parse(readFileSync(join(instance, "mcp-config.json"), "utf8"));
    expect(json.mcpServers.agend.command).toBe(BUNDLED);
  });
});
