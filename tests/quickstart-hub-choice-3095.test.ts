/**
 * #3095 (S-48): a fresh `agend quickstart` first asks what this machine is. "2" (a team Hub) hands over to the same
 * wizard as `agend hub init` before any fleet setup (no tmux or AI CLI needed); an existing fleet keeps its menu and is
 * never asked. Readline scripted on a scratch AGEND_HOME; the Hub wizard itself is replaced by a recorder.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const rl = vi.hoisted(() => ({ answers: [] as string[], asked: [] as string[] }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (q: string) => { rl.asked.push(q); if (!rl.answers.length) throw new Error(`unscripted question: ${q}`); return rl.answers.shift()!; },
    close: () => {},
  }),
}));
const hubInit = vi.hoisted(() => ({ runs: 0 }));
vi.mock("../src/hub/init/cli.js", () => ({ runHubInitCommand: async () => { hubInit.runs += 1; return "cancelled"; } }));

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "agend-test-qshub-")); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rl.answers = []; rl.asked = []; hubInit.runs = 0; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function quickstart(home: string, answers: string[]): Promise<string> {
  vi.stubEnv("AGEND_HOME", home);
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ").replace(/\x1b\[[0-9;]*m/g, "")); });
  try {
    rl.answers = answers;
    const { runQuickstart } = await import("../src/quickstart.js");
    await runQuickstart();
  } finally {
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
  return out.join("\n");
}

describe("quickstart: this machine is a fleet or a team Hub (#3095)", () => {
  it("a fresh setup asks first; 2 runs the Hub wizard and writes no fleet.yaml", async () => {
    const home = tempDir();
    const text = await quickstart(home, ["2"]);
    expect(text).toContain("This machine is:");
    expect(text).toContain("A team Hub (experimental)");
    expect(rl.asked).toHaveLength(1);
    expect(hubInit.runs).toBe(1);
    expect(existsSync(join(home, "fleet.yaml"))).toBe(false);
  });

  it("an existing fleet keeps its own menu and is not asked", async () => {
    const home = tempDir();
    writeFileSync(join(home, "fleet.yaml"), "health_port: 24680\nchannels:\n  - { id: telegram, type: telegram, bot_token_env: AGEND_TELEGRAM_TOKEN, group_id: \"-1\" }\n");
    const text = await quickstart(home, ["5"]);
    expect(text).not.toContain("This machine is:");
    expect(hubInit.runs).toBe(0);
  });
});
