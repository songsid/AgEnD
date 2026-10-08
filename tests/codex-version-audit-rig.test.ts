/**
 * The codex version audit rig (scripts/manual/codex-version-audit) stays runnable: its shell steps parse, gen-cmd.ts
 * produces AgEnD's production launch with the mock provider in the instance config, and the mock answers each mode
 * the way the audit relies on. No codex runs: a stub binary stands in on PATH.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RIG = fileURLToPath(new URL("../scripts/manual/codex-version-audit/", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "agend-cx-rig-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("rig shell steps", () => {
  it.each(["rig.sh", "pass1.sh", "pass2.sh"])("%s parses", (file) => {
    expect(() => execFileSync("bash", ["-n", join(RIG, file)])).not.toThrow();
  });
});

describe("gen-cmd.ts: the production launch, pointed at the mock", () => {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex"), "#!/bin/sh\necho codex-cli 0.0.0\n"); chmodSync(join(bin, "codex"), 0o755);
  const gen = (name: string, ...args: string[]) => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGEND_HOME: join(root, "agend"), CODEX_HOME: join(root, "shared") };
    const cmd = execFileSync("npx", ["tsx", join(RIG, "gen-cmd.ts"), join(root, `inst-${name}`), join(root, `work-${name}`), "18799", ...args],
      { cwd: REPO, env, encoding: "utf8" });
    const home = /^CODEX_HOME='([^']+)'/.exec(cmd)![1]!;
    return { cmd, config: readFileSync(join(home, "config.toml"), "utf8") };
  };

  it("fresh + trusted: AgEnD's flags, the mock provider, the trust entry and the nudge flag", () => {
    const { cmd, config } = gen("a", "fresh", "trust");
    expect(cmd).toContain(`${bin}/codex --dangerously-bypass-approvals-and-sandbox`);
    expect(cmd).toContain("-c check_for_update_on_startup=false --no-alt-screen -c features.instant_interrupt=false");
    expect(config).toContain(`model_provider = "mock"`);
    expect(config).toContain(`base_url = "http://127.0.0.1:18799/v1"`);
    expect(config).toContain(`[projects."${join(root, "work-a")}"]`);
    expect(config).toMatch(/^notice\.hide_rate_limit_model_nudge = true$/m);
  }, 60_000);

  it("untrusted leaves the folder untrusted; nudge drops AgEnD's nudge flag", () => {
    const { config } = gen("b", "fresh", "untrusted", "nudge");
    expect(config).not.toContain("[projects.");
    expect(config).not.toMatch(/hide_rate_limit_model_nudge/);
  }, 60_000);
});

describe("mock.mjs: one response shape per mode", () => {
  let mock: ChildProcess; let port = 0; const modeFile = join(root, "mode");
  beforeAll(async () => {
    port = await new Promise<number>(resolve => { const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
    mock = spawn(process.execPath, [join(RIG, "mock.mjs")], { env: { ...process.env, PORT: String(port), MOCK_MODE_FILE: modeFile, SLOW_MS: "10" }, stdio: "ignore" });
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/v1/models`); return; } catch { await new Promise(r => setTimeout(r, 50)); } }
  });
  afterAll(() => { mock?.kill(); });
  const turn = async (mode: string) => {
    writeFileSync(modeFile, mode);
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", body: "{}" });
    return { status: res.status, headers: res.headers, body: await res.text() };
  };

  it.each([
    ["ok", 200, "response.completed"],
    ["slow", 200, "response.completed"],
    ["near", 200, "response.completed"],
    ["capacity", 200, "server_is_overloaded"],
    ["usage", 429, "usage_limit_reached"],
    ["e401", 401, "invalid_api_key"],
    ["e500", 500, "server_error"],
  ])("%s → HTTP %i with %s", async (mode, status, marker) => {
    const r = await turn(mode);
    expect(r.status).toBe(status);
    expect(r.body).toContain(marker);
    if (mode === "near") expect(r.headers.get("x-codex-primary-used-percent")).toBe("96");
  });
});
