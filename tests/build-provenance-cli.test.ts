import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../src/locale.js";
const state = vi.hoisted(() => ({ lines: [] as string[],
  build: { version: "1.22.0", source: { format: 1, channel: "alpha", ref: "release/2.3.5-alpha", commit: "a".repeat(40), modified: null, from: "archive" }, label: "2.3.5-alpha · aaaaaaaaaaaa (changes unknown)" },
  forbidden: vi.fn(() => { throw Error("host service forbidden"); }) }));
vi.mock("../src/build-provenance.js", async original => ({ ...await original<typeof import("../src/build-provenance.js")>(), readInstalledBuild: () => state.build }));
vi.mock("../src/service-installer.js", () => ({ inspectService: () => ({ installed: false }), installService: state.forbidden, activateService: state.forbidden }));
vi.mock("../src/hub/init/existing-fleet.js", async original => ({ ...await original<typeof import("../src/hub/init/existing-fleet.js")>(), realFleetProbe: () => ({ pidAlive: () => false }) }));
vi.mock("../src/hub/init/prompt.js", async original => {
  const mod = await original<typeof import("../src/hub/init/prompt.js")>();
  return { ...mod, terminalIO: () => ({ say: (line: string) => state.lines.push(line), ask: async () => { throw new mod.WizardCancelled(); }, askHidden: state.forbidden }) };
});
import { registerBuildInfoCommand } from "../src/build-provenance-cli.js";
import { runHubInitCommand } from "../src/hub/init/cli.js";
import { FakeIdentity } from "./support/hub-init-fixtures.js";
const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
let root: string | undefined;
afterEach(() => {
  if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as { isTTY?: boolean }).isTTY;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); setLocale("en"); state.lines.length = 0;
  if (root) rmSync(root, { recursive: true, force: true }); root = undefined;
});
describe("read-only build identity commands", () => {
  it("prints exact source identity or JSON without changing machine --version", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command().version("1.22.0").exitOverride(); registerBuildInfoCommand(program);
    await program.parseAsync(["build-info"], { from: "user" });
    expect(output.mock.calls.flat().join("\n")).toContain(`release/2.3.5-alpha @ ${"a".repeat(40)}`);
    output.mockClear(); await program.parseAsync(["build-info", "--json"], { from: "user" });
    expect(output.mock.calls[0][0]).toBe(JSON.stringify(state.build));
    expect(JSON.parse(output.mock.calls[0][0])).toEqual(state.build);
    expect(program.version()).toBe("1.22.0"); expect(state.forbidden).not.toHaveBeenCalled();
  });
  it.each(["en", "zh-TW"] as const)("shows the source stamp before setup prompts in %s, without directory or service effects", async locale => {
    root = mkdtempSync(join(tmpdir(), "agend-build-init-")); vi.stubEnv("AGEND_HOME", root); vi.stubEnv("HOME", root);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true }); setLocale(locale);
    expect(await runHubInitCommand(new FakeIdentity())).toBe("cancelled");
    expect(state.lines[0]).toContain("2.3.5-alpha · aaaaaaaaaaaa"); expect(state.lines[0]).toContain("1.22.0");
    expect(state.lines[0]).toContain(locale === "en" ? "changes unknown" : "變更狀態不明");
    expect(state.forbidden).not.toHaveBeenCalled();
  });
});
