/**
 * #1450 C5: everything AgEnD starts for itself runs on AgEnD's own Node by absolute path, with every argument quoted —
 * no `node` or `agend` from PATH, nothing a path or argument can turn into shell syntax. Each wrapper is run through a
 * real shell with an inert stand-in at a hostile path, and with no node on PATH.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GrokBackend } from "../src/backend/grok.js";
import { KiroBackend } from "../src/backend/kiro.js";
import { MuseBackend } from "../src/backend/muse.js";
import { AntigravityBackend } from "../src/backend/antigravity.js";
import type { CliBackendConfig } from "../src/backend/types.js";
import { DELAYED_EXEC_SCRIPT, canonicalCliEntry, delayedSelfCommand, selfCommand } from "../src/cli-entry.js";

const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend c5-")); roots.push(d); return d; };
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); });

/** Hostile, but a legal file name: a space, `$`, a backtick and `$(…)`. */
const HOSTILE = "dir with space $HOME `id` $(touch PWNED)";
const ARGS = ["a b", "$HOME", "`id`", "$(touch PWNED)", "it's", ""];

/** An inert stand-in "server" at a hostile path that records exactly the argv it got. */
function inertServer(root: string): { command: string; seen: () => string[] } {
  const dir = join(root, HOSTILE);
  mkdirSync(dir, { recursive: true });
  const out = join(root, "argv.json");
  const command = join(dir, "node");
  writeFileSync(command, `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(command, 0o755);
  return { command, seen: () => JSON.parse(readFileSync(out, "utf8")) };
}

/** A PATH with what the wrappers use and NO node. */
function pathWithoutNode(root: string): string {
  const dir = join(root, "tools");
  mkdirSync(dir);
  for (const tool of ["seq", "sleep", "bash", "sh"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(dir, tool), `#!/bin/sh\nexec '${found}' "$@"\n`);
    chmodSync(join(dir, tool), 0o755);
  }
  return dir;
}

let socketDir: string;
let socketPath: string;
let server: Server;
beforeAll(async () => {
  socketDir = mkdtempSync(join(tmpdir(), "agend-c5-sock-"));
  roots.push(socketDir);
  socketPath = join(socketDir, "s.sock");
  server = createServer();
  await new Promise<void>(r => server.listen(socketPath, r));
});
afterAll(() => { server.close(); });

function config(root: string, command: string): CliBackendConfig {
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  return { workingDirectory: work, instanceDir: join(root, "inst"), instanceName: "c5", mcpServers: { agend: { command, args: ARGS, env: { AGEND_SOCKET_PATH: socketPath } } } } as CliBackendConfig;
}

describe("MCP wrapper scripts quote the command and every argument (kiro, grok, muse)", () => {
  const cases: Array<[string, (root: string) => { write: (c: CliBackendConfig) => void; wrapper: (root: string) => string }]> = [
    // A fixed compatibility: without one the constructor probes a real kiro-cli.
    ["kiro", root => ({ write: c => new KiroBackend(join(root, "inst"), { version: "kiro-cli 2.21.0", supportsLegacyUi: true, supportsTui: true, supportsV3: true, agentEngines: ["v2", "v1", "v3"], supportsEffortFlag: true, source: "version" }).writeConfig(c), wrapper: r => join(r, "inst", "mcp-wrapper-agend.sh") })],
    ["grok", root => ({ write: c => new GrokBackend(join(root, "inst")).writeConfig(c), wrapper: r => join(r, "inst", "mcp-wrapper-agend.sh") })],
    ["muse", root => {
      vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
      return { write: c => new MuseBackend(join(root, "inst")).writeConfig(c), wrapper: r => join(r, "inst", "mcp-wrapper-agend.sh") };
    }],
  ];
  it.each(cases)("%s: run by bash with no node on PATH, the server gets exactly its argv and nothing is executed", (_name, make) => {
    const root = scratch();
    mkdirSync(join(root, "inst"), { recursive: true });
    const srv = inertServer(root);
    const backend = make(root);
    backend.write(config(root, srv.command));
    const wrapper = backend.wrapper(root);
    expect(existsSync(wrapper), wrapper).toBe(true);
    const run = spawnSync("bash", [wrapper], { cwd: root, encoding: "utf8", timeout: 20_000, env: { PATH: pathWithoutNode(root), HOME: root } });
    expect(run.status, run.stderr).toBe(0);
    expect(srv.seen()).toEqual(ARGS);
    expect(existsSync(join(root, "PWNED"))).toBe(false);
  });
});

describe("the antigravity statusline runs on AgEnD's Node, not a node from PATH", () => {
  it("prints the context line with no node on PATH", () => {
    const root = scratch();
    const agendHome = join(root, "agend home");
    const instanceDir = join(agendHome, "instances", "agy");
    mkdirSync(instanceDir, { recursive: true });
    mkdirSync(join(root, "home"), { recursive: true });
    const backend = new AntigravityBackend(instanceDir, join(root, "home"), agendHome);
    (backend as unknown as { enableStatusLine(): void }).enableStatusLine();
    const script = join(agendHome, "agy-statusline.sh");
    expect(readFileSync(script, "utf8")).toContain(`exec '${process.execPath}' -e '`);
    const run = spawnSync("bash", [script], { input: JSON.stringify({ context_window: { used_percentage: 41.6 } }), encoding: "utf8", env: { PATH: pathWithoutNode(root) } });
    expect(run.stdout.trim()).toBe("Context 42% used");
  });
});

describe("AgEnD re-runs itself on this Node and the canonical entry", () => {
  it("selfCommand: process.execPath + the canonical dist/cli.js + the arguments", () => {
    expect(selfCommand(["fleet", "start"])).toEqual({ command: process.execPath, args: [...process.execArgv, canonicalCliEntry(), "fleet", "start"] });
  });

  it("canonicalCliEntry is <module dir>/cli.js, realpath'd — never process.argv[1]", () => {
    const root = scratch();
    mkdirSync(join(root, "real", "dist"), { recursive: true });
    writeFileSync(join(root, "real", "dist", "cli.js"), "");
    spawnSync("ln", ["-s", join(root, "real"), join(root, "link")]);
    expect(canonicalCliEntry(`file://${join(root, "link", "dist", "cli-entry.js")}`)).toBe(join(root, "real", "dist", "cli.js"));
    writeFileSync(join(root, "real", "dist", "cli.ts"), "");
    expect(canonicalCliEntry(`file://${join(root, "link", "dist", "cli-entry.ts")}`)).toBe(join(root, "real", "dist", "cli.ts"));   // from source
  });

  it("the delayed form passes every value as data through real sh: a hostile path and arguments run as written", () => {
    const root = scratch();
    const srv = inertServer(root);
    const c = delayedSelfCommand(0, ["fleet", "restart", "--reload"]);
    expect(c.args.slice(0, 4)).toEqual(["-c", DELAYED_EXEC_SCRIPT, "sh", "0"]);
    expect(c.args.slice(4)).toEqual([process.execPath, ...process.execArgv, canonicalCliEntry(), "fleet", "restart", "--reload"]);
    // The same script with the inert stand-in in place of this Node.
    const run = spawnSync("sh", ["-c", DELAYED_EXEC_SCRIPT, "sh", "0", srv.command, ...ARGS], { cwd: root, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(srv.seen()).toEqual(ARGS);
    expect(existsSync(join(root, "PWNED"))).toBe(false);
  });
});
