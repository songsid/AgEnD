/**
 * #1490 row 54: `agend topic bind/unbind` used to `yaml.dump` the defaults-expanded
 * fleet config over fleet.yaml (comments gone, a legacy `channel:` duplicated as
 * `channels`, working_directory expanded). These spawn src/cli.ts against a scratch
 * AGEND_HOME the way tests/cli-command-cleanup-2359.test.ts does.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const LEGACY_FLEET = `# keep-this-file-comment
channel:
  type: telegram
  group_id: 1
  bot_token_env: T
defaults:
  backend: mock
  locale: en
instances:
  worker:
    # keep-this-instance-comment
    backend: mock
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-cli-topic-")); roots.push(dir);
  writeFileSync(join(dir, "fleet.yaml"), LEGACY_FLEET);
  mkdirSync(join(dir, "instances", "worker"), { recursive: true });
  mkdirSync(join(dir, "workspaces", "worker"), { recursive: true });
  return dir;
}

function spawnCli(dir: string, args: string[]) {
  return spawnSync(process.execPath, ["--require", join(process.cwd(), "tests/helpers/health-process-stub.cjs"), "--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, AGEND_HOME: dir, HOME: dir, NOTIFY_SOCKET: "", PATH: process.env.PATH },
  });
}

function run(dir: string, args: string[]) {
  const child = spawnCli(dir, args);
  expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
  return child.stdout;
}

function assertRawShape(yamlText: string) {
  expect(yamlText).toContain("# keep-this-file-comment");
  expect(yamlText).toContain("# keep-this-instance-comment");
  expect(yamlText).toMatch(/^channel:/m);
  expect(yamlText).not.toMatch(/^channels:/m);
  expect(yamlText).not.toMatch(/working_directory:/);
  expect(yamlText).not.toMatch(/\bid:\s*telegram\b/);
  expect(yamlText).not.toMatch(/\bmode:\s*topic\b/);
}

describe("#1490 row 54: topic bind/unbind is a raw YAML leaf edit", () => {
  it("bind writes topic_id and keeps comments plus a legacy channel", () => {
    const dir = fixture();
    expect(run(dir, ["topic", "bind", "worker", "42"])).toContain("Bound worker");
    const after = readFileSync(join(dir, "fleet.yaml"), "utf8");
    assertRawShape(after);
    expect(after).toMatch(/topic_id:\s*"?42"?/);
    expect(run(dir, ["topic", "list"])).toMatch(/worker.*42/);
  }, 30_000);

  it("unbind removes only topic_id and still keeps comments plus a legacy channel", () => {
    const dir = fixture();
    run(dir, ["topic", "bind", "worker", "7"]);
    expect(run(dir, ["topic", "unbind", "worker"])).toContain("Unbound worker");
    const after = readFileSync(join(dir, "fleet.yaml"), "utf8");
    assertRawShape(after);
    expect(after).not.toMatch(/topic_id:/);
    expect(run(dir, ["topic", "list"])).toContain("No topic bindings configured");
  }, 30_000);

  it("a missing instance is refused and the file is left alone", () => {
    const dir = fixture();
    const child = spawnCli(dir, ["topic", "bind", "no-such", "1"]);
    expect(child.status).not.toBe(0);
    expect(`${child.stderr}${child.stdout}`).toContain('Instance "no-such" not found');
    expect(readFileSync(join(dir, "fleet.yaml"), "utf8")).toBe(LEGACY_FLEET);
  }, 20_000);
});
