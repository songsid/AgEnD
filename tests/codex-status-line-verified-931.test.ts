/**
 * #931: the Context status item AgEnD adds to a Codex config must land in the
 * TUI's effective `tui.status_line` — verified by parsing the result — and a
 * config that cannot be made verifiable warns the operator instead of leaving
 * the pane silently unready. Every case runs the production writeConfig.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

let root: string;
const saved = process.env.CODEX_HOME;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-codex-931-"));
  process.env.CODEX_HOME = join(root, "shared");
  mkdirSync(process.env.CODEX_HOME);
});
afterEach(() => {
  if (saved === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

/** The user's shared config → the private config AgEnD launches with. */
function launchWith(userConfig: string) {
  writeFileSync(join(process.env.CODEX_HOME!, "config.toml"), userConfig);
  const instanceDir = join(root, "instance");
  const backend = new CodexBackend(instanceDir);
  const config = { workingDirectory: root, instanceDir, instanceName: "w", mcpServers: {}, skipResume: true };
  backend.writeConfig(config);
  backend.buildCommand(config);
  const text = readFileSync(join((backend as any).isolatedCodexHome, "config.toml"), "utf8");
  return { text, parsed: parse(text) as any, warning: backend.consumeLaunchWarning(), again: backend.consumeLaunchWarning() };
}

describe("the Context item lands in the TUI's effective status_line (#931)", () => {
  it.each([
    ["the issue's quoted key", '"tui"."status_line" = ["model-with-reasoning"]\n', ["model-with-reasoning"]],
    ["a quoted section", '["tui"]\n"status_line" = ["model-with-reasoning"]\n', ["model-with-reasoning"]],
    ["a dotted key", 'tui.status_line = ["model-with-reasoning"]\n', ["model-with-reasoning"]],
    ["an inline table", 'tui = { status_line = ["model-with-reasoning"], animations = false }\n', ["model-with-reasoning"]],
    ["a multi-line array", '[tui]\nstatus_line = [\n  "model-with-reasoning",\n  "current-dir",\n]\n', ["model-with-reasoning", "current-dir"]],
    ["an empty array", "[tui]\nstatus_line = []\n", []],
    ["a comment inside the array", '[tui]\nstatus_line = [ # mine\n "model-with-reasoning" ]\n', ["model-with-reasoning"]],
    ["no status_line at all", "[tui]\nanimations = false\n", []],
    ["dotted tui keys without status_line", "tui.animations = false\n", []],
    ["an inline tui table without status_line", "tui = { animations = false }\n", []],
    ["an empty inline tui table", "tui = {}\n", []],
    ["no config", "", []],
  ])("%s → context-remaining first, the user's items kept in order", (_label, userConfig, userItems) => {
    const { parsed, warning } = launchWith(userConfig as string);
    expect(parsed.tui.status_line).toEqual(["context-remaining", ...(userItems as string[])]);
    expect(warning).toBeNull();
  });

  it("edits the TUI's status_line, not a same-named key in another table", () => {
    const { parsed, warning } = launchWith('[notice]\nstatus_line = ["x"]\n\n[tui]\nstatus_line = ["model-with-reasoning"]\n');
    expect(parsed.tui.status_line).toEqual(["context-remaining", "model-with-reasoning"]);
    expect(parsed.notice.status_line).toEqual(["x"]);
    expect(warning).toBeNull();
  });

  it("is not fooled by a context item in another table", () => {
    const { parsed } = launchWith('[notice]\nstatus_line = ["context-remaining"]\n\n[tui]\nstatus_line = ["model-with-reasoning"]\n');
    expect(parsed.tui.status_line).toEqual(["context-remaining", "model-with-reasoning"]);
    expect(parsed.notice.status_line).toEqual(["context-remaining"]);
  });

  it("leaves a status_line that already shows context untouched, wherever the item sits", () => {
    const user = '[tui]\nstatus_line = ["model-with-reasoning", "context-used"]\n';
    const { text, warning } = launchWith(user);
    expect(text).toContain('status_line = ["model-with-reasoning", "context-used"]');
    expect(warning).toBeNull();
  });
});

describe("a status_line AgEnD cannot make verifiable is surfaced, not silent (#931)", () => {
  it.each([
    ["a status_line that is not a list", '[tui]\nstatus_line = "model-with-reasoning"\n'],
    ["a status_line list with a non-string item", "[tui]\nstatus_line = [1]\n"],
    // Valid TOML whose key no text edit can find: the escape spells status_line.
    ["an escaped key spelling", '[tui]\n"status\\u005fline" = ["model-with-reasoning"]\n'],
  ])("%s: the config is left as the user wrote it and the launch warns once", (_label, userConfig) => {
    const { parsed, warning, again } = launchWith(userConfig);
    // Only the unrelated update-check key is added; the TUI table is the user's.
    expect(parsed.tui).toEqual((parse(userConfig) as any).tui);
    expect(warning).toMatch(/could not add a Context item/);
    // Where the user's status_line lives — the private copy is rebuilt each launch.
    expect(warning).toContain(join(process.env.CODEX_HOME!, "config.toml"));
    expect(again).toBeNull();
  });
});

describe("a verified edit that cannot be written is surfaced too (#931 follow-up)", () => {
  it.skipIf(process.getuid?.() === 0)("warns, naming the shared config, instead of swallowing the write error", () => {
    writeFileSync(join(process.env.CODEX_HOME!, "config.toml"), '"tui"."status_line" = ["model-with-reasoning"]\n');
    const instanceDir = join(root, "instance");
    const backend = new CodexBackend(instanceDir) as any;
    const config = { workingDirectory: root, instanceDir, instanceName: "w", mcpServers: {}, skipResume: true };
    // The private config is written twice: by writeConfig, then by the
    // status-line edit. Make only the second fail, after the edit verified:
    // the atomic write needs a temp file in the (now read-only) home.
    const enable = backend.enableContextStatusLine.bind(backend);
    backend.enableContextStatusLine = () => {
      chmodSync(backend.isolatedCodexHome, 0o500);
      try { enable(); } finally { chmodSync(backend.isolatedCodexHome, 0o700); }
    };
    backend.writeConfig(config);
    const warning = backend.consumeLaunchWarning();
    expect(warning).toMatch(/could not be written: EACCES/);
    expect(warning).toContain(join(process.env.CODEX_HOME!, "config.toml"));
  });
});
