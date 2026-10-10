/**
 * #1519 P7 (docs/design/ux-onboarding-walkthrough.md §5.1): the CLI points to the web. `agend quickstart`, `agend setup`
 * and `agend init` end with the dashboard's address (the fleet's health_port, else 19280) and how to sign in; quickstart
 * numbers its four steps the same way; `agend init` no longer names a unit that does not exist or a plugin Discord no
 * longer needs. Quickstart and the setup host run for real on a scratch AGEND_HOME (readline scripted, nothing started).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HEALTH_PORT, dashboardLines, dashboardPort } from "../src/next-steps.js";

const rl = vi.hoisted(() => ({ answers: [] as string[], asked: [] as string[] }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (q: string) => { rl.asked.push(q); if (!rl.answers.length) throw new Error(`unscripted question: ${q}`); return rl.answers.shift()!; },
    close: () => {},
  }),
}));

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "agend-test-next-")); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rl.answers = []; rl.asked = []; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const SRC = (f: string) => readFileSync(join(process.cwd(), "src", f), "utf8");
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("where the dashboard is", () => {
  it.each([
    ["health_port: 24680\n", 24680],
    ["defaults: {}\n", DEFAULT_HEALTH_PORT],
    ["health_port: \"24680\"\n", DEFAULT_HEALTH_PORT],
    ["health_port: 0\n", DEFAULT_HEALTH_PORT],
    ["health_port: 70000\n", DEFAULT_HEALTH_PORT],
    ["health_port: 2.5\n", DEFAULT_HEALTH_PORT],
    ["health_port: [\n", DEFAULT_HEALTH_PORT],
    ["", DEFAULT_HEALTH_PORT],
  ])("%j → %i", (text, port) => {
    const file = join(tempDir(), "fleet.yaml");
    writeFileSync(file, text);
    expect(dashboardPort(file)).toBe(port);
  });
  it("no file: the default; the lines name the address and both ways to sign in", () => {
    expect(dashboardPort(join(tempDir(), "missing.yaml"))).toBe(19280);
    expect(dashboardLines(24680)).toEqual(["Web dashboard: http://localhost:24680/", "Sign in with `agend web --code` on this machine, or send /dashboard to your bot."]);
  });
});

describe("agend quickstart", () => {
  it("left as it is (Skip): it still says where the dashboard is — the fleet's own port — before Done", async () => {
    const home = tempDir();
    writeFileSync(join(home, "fleet.yaml"), "health_port: 24680\nchannels:\n  - { id: telegram, type: telegram, bot_token_env: AGEND_TELEGRAM_TOKEN, group_id: \"-1\" }\n");
    vi.stubEnv("AGEND_HOME", home);
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(strip(a.join(" "))); });
    try {
      rl.answers = ["5"];
      const { runQuickstart } = await import("../src/quickstart.js");
      await runQuickstart();
    } finally {
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    const text = out.join("\n");
    expect(text).toContain("Web dashboard: http://localhost:24680/");
    expect(text).toContain("Sign in with `agend web --code` on this machine, or send /dashboard to your bot.");
    expect(text.indexOf("Web dashboard")).toBeLessThan(text.indexOf("═══ Done ═══"));
    expect(text.indexOf("Web dashboard"), "found at all").toBeGreaterThan(-1);
  });

  it("its steps are numbered 1 to 4 out of 4 (was 1/3, 2/4 and two unnumbered)", () => {
    const qs = SRC("quickstart.ts");
    const steps = [...qs.matchAll(/Step (\d)\/(\d)/g)].map(m => `${m[1]}/${m[2]}`);
    expect([...new Set(steps)].sort()).toEqual(["1/4", "2/4", "3/4", "4/4"]);
    expect(qs).toContain('runTelegramFlow(rl, "Step 3/4")');
    expect(qs).toContain('runDiscordFlow(rl, "Step 3/4")');
    // Every way out that says Done says where the dashboard is first: one Done, printed by printDone (five exits).
    expect([qs.match(/═══ Done ═══/g)?.length ?? 0, qs.match(/printDone\(\);/g)?.length ?? 0]).toEqual([1, 5]);
  });
});

describe("agend setup", () => {
  it("handing over to the fleet: the log says where its dashboard will be (the saved health_port)", async () => {
    const { SetupHost } = await import("../src/setup-host.js");
    const dir = tempDir();
    writeFileSync(join(dir, "fleet.yaml"), "health_port: 24681\n");
    const lines: string[] = [];
    const spawnFleet = vi.fn();
    const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, spawnFleet, log: (m: string) => lines.push(m) } as never);
    await host.start();
    (host as unknown as { admittedFinish: boolean }).admittedFinish = true;   // what an admitted Finish sets
    await host.shutdown(true, "finished");
    expect(spawnFleet).toHaveBeenCalledOnce();
    const at = lines.indexOf("Setup complete — starting AgEnD.");
    expect(lines.slice(at, at + 3)).toEqual(["Setup complete — starting AgEnD.", ...dashboardLines(24681)]);
  });
  it("not handing over: no dashboard line (nothing will be there)", async () => {
    const { SetupHost } = await import("../src/setup-host.js");
    const dir = tempDir();
    const lines: string[] = [];
    const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, spawnFleet: vi.fn(), log: (m: string) => lines.push(m) } as never);
    await host.start();
    await host.shutdown(false, "ttl");
    expect(lines.filter(l => l.startsWith("Web dashboard"))).toEqual([]);
  });
  it("the page's last word links the dashboard on the address the fleet just answered on", () => {
    const form = SRC("setup-form.ts");
    expect(form).toContain('link.href = "/"; link.textContent = location.origin + "/";');
    expect(form).toContain("sign in with agend web --code on this machine, or send /dashboard to your bot");
  });
});

describe("agend init", () => {
  it("no unit that does not exist, no plugin to install; the service is started as quickstart does; the dashboard lines", () => {
    const init = SRC("setup-wizard.ts");
    expect([init.includes("enable --now agend"), init.includes("agend-plugin-discord")]).toEqual([false, false]);
    expect(init).toContain('activateService(svcPath, join(DATA_DIR, "fleet.pid"))');
    expect(init).toContain("dashboardLines(dashboardPort(FLEET_CONFIG_PATH))");
  });
});
