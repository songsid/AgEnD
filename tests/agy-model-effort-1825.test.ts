/**
 * #1825, from the real agy 1.3.5 (and 1.3.4) binary, offline (tests/fixtures/agy-1.3.5-audit/README.md):
 *
 * - agy prints `--help` to STDERR (stdout is empty), so reading stdout alone saw no `--effort`: a configured effort
 *   never reached agy (#1811's gate skipped it) and the CLI env probe cached `effortLevels: []`.
 * - agy's catalog has one model per effort level (`gemini-3.8-flash-high` "Gemini 3.8 Flash (High)", …). `--model` with
 *   another level's `--effort`, a label with any `--effort`, a level the model lacks, or a model it does not list each
 *   make agy run ANOTHER model (a warning row only). So a configured effort picks the exact variant, and `--model` never
 *   goes out with `--effort`.
 * - agy's trust prompt under AgEnD's own statusLine ends with "Context 0% used" at column 0, and for a model without
 *   levels with a right-aligned "GPT-OSS 120B (Medium)": neither has the "·" the detector required.
 *
 * No real CLI, fleet or tmux runs here (bd0c88aa): the "binaries" are generated shell scripts.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AntigravityBackend, agyLoginScreenActive, agyTrustDialogState, parseAntigravityModelsOutput } from "../src/backend/antigravity.js";
import { agyModelEffortLevels, agyModelFamily, readEffortMetadata } from "../src/backend/effort-metadata.js";
import { cliHelp, flagEffort, readHelpText, resetCliHelpCache, resolveAgyLaunch } from "../src/backend/launch-effort.js";
import { t } from "../src/locale.js";
import { registerExecutableFixture } from "./support/process-guard.js";

const FIX = join(import.meta.dirname, "fixtures");
const AUDIT = join(FIX, "agy-1.3.5-audit");
const audit = (name: string) => readFileSync(join(AUDIT, name), "utf-8");
const HELP_135 = readFileSync(join(FIX, "agy-help", "agy-help-1.3.5.stderr.txt"), "utf-8");
const CATALOG = parseAntigravityModelsOutput(audit("agy-models.stdout.txt"));

let root: string;
const saved = process.env.AGEND_HOME;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-agy-1825-"));
  process.env.AGEND_HOME = join(root, "agend");
  resetCliHelpCache();
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

/** A generated stand-in for agy: `--help` prints the real 1.3.5 help on stderr (stdout empty), like the real one. */
function fakeAgy(name = "agy", help = HELP_135, stream: "stderr" | "stdout" = "stderr"): string {
  const path = join(root, name);
  const helpFile = join(root, `${name}.help`);
  writeFileSync(helpFile, help);
  writeFileSync(path, `#!/bin/sh\ncase "$1" in\n  --help) cat '${helpFile}'${stream === "stderr" ? " >&2" : ""} ;;\n`
    + `  --version) echo '1.3.5' ;;\n  *) exit 1 ;;\nesac\n`);
  chmodSync(path, 0o755);
  registerExecutableFixture(path);
  return path;
}

/** The CLI env probe's cache, as the fleet writes it. */
function cacheCliEnv(env: Record<string, unknown>): void {
  mkdirSync(join(root, "agend", "cli-env"), { recursive: true });
  writeFileSync(join(root, "agend", "cli-env", "antigravity.json"),
    JSON.stringify({ backend: "antigravity", probedAt: Date.now(), version: "1.3.5", models: CATALOG, ...env }));
}

describe("help on stderr", () => {
  it("the real 1.3.5 help is all on stderr, and lists --effort with five levels", () => {
    expect(HELP_135).toMatch(/^Usage of agy:/);
    expect(HELP_135).toMatch(/^\s+--effort\s+.*\(low\|medium\|high\|xhigh\|max\)$/m);
  });

  it("readHelpText: stdout when it has the help, else stderr; a failing CLI throws", () => {
    expect(readHelpText(fakeAgy("agy-err"))).toBe(HELP_135);
    expect(readHelpText(fakeAgy("agy-out", "  --effort  x (low|high)\n", "stdout"))).toBe("  --effort  x (low|high)\n");
    const failing = join(root, "agy-fail");
    writeFileSync(failing, "#!/bin/sh\necho usage >&2\nexit 2\n");
    chmodSync(failing, 0o755);
    registerExecutableFixture(failing);
    expect(() => readHelpText(failing)).toThrow(/exited 2/);
  });

  it("the launch gate passes --effort for an agy whose help is on stderr (it skipped it before)", () => {
    const bin = fakeAgy();
    expect(cliHelp(bin)).toBe(HELP_135);
    expect(flagEffort("antigravity", "high", bin)).toEqual({ arg: " --effort high", note: null, level: "high" });
  });

  it("the CLI env probe reads the levels from stderr", async () => {
    const be = new AntigravityBackend(root, root, join(root, "agend"));
    (be as unknown as { binaryPath: string }).binaryPath = fakeAgy();
    (be as unknown as { listModels: () => Promise<unknown[]> }).listModels = async () => CATALOG;
    expect((await be.probeCLIEnv()).effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("the catalog: one model per level", () => {
  it("1.3.5's `agy models` parses to the ten slug/label pairs", () => {
    expect(CATALOG).toHaveLength(10);
    expect(CATALOG[0]).toEqual({ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" });
    expect(CATALOG.at(-1)).toEqual({ id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" });
  });

  it("a family from a variant's slug, its label, or the base slug; none for a base label or an unlisted name", () => {
    const gemini = new Map([["low", "gemini-3.8-flash-low"], ["medium", "gemini-3.8-flash-medium"], ["high", "gemini-3.8-flash-high"]]);
    for (const name of ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (High)", "gemini-3.8-flash"]) {
      expect(agyModelFamily(name, CATALOG), name).toEqual({ base: "gemini-3.8-flash", variants: gemini });
    }
    expect(agyModelFamily("gpt-oss-120b-medium", CATALOG)).toEqual({ base: "gpt-oss-120b", variants: new Map([["medium", "gpt-oss-120b-medium"]]) });
    for (const name of ["Gemini 3.8 Flash", "Gemini 3.5 Flash (High)", "gemini-3.5-flash-high", "gemini"]) {
      expect(agyModelFamily(name, CATALOG), name).toBeNull();
    }
    // A listed model whose slug has no level has no family (it is not its own base).
    expect(agyModelFamily("plain-model", [...CATALOG, { id: "plain-model", label: "Plain" }])).toBeNull();
    // …even when the catalog also lists level-suffixed models under that name: a listed model is a model, not a base.
    expect(agyModelFamily("plain-model", [...CATALOG, { id: "plain-model", label: "Plain" }, { id: "plain-model-high", label: "Plain (High)" }])).toBeNull();
  });

  it("per-model levels: the family's levels the binary takes; none for a listed model without levels", () => {
    cacheCliEnv({ effortLevels: ["low", "medium", "high", "xhigh", "max"], currentModel: "claude-opus-5-5-high" });
    expect(agyModelEffortLevels("gemini-3.8-flash-medium")).toEqual(["low", "medium", "high"]);
    expect(agyModelEffortLevels("GPT-OSS 120B (Medium)")).toEqual(["medium"]);
    expect(agyModelEffortLevels(null)).toEqual(["low", "medium", "high"]);                 // agy's own model (claude-opus-5-5)
    expect(agyModelEffortLevels("not-listed")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(readEffortMetadata("antigravity", root, "gpt-oss-120b-medium")).toEqual({ strategy: "runtime", levels: ["medium"] });
    cacheCliEnv({ effortLevels: ["low", "high"], models: [...CATALOG, { id: "plain-model", label: "Plain" }] });
    expect(agyModelEffortLevels("gemini-3.8-flash")).toEqual(["low", "high"]);              // what the binary takes, too
    expect(agyModelEffortLevels("plain-model")).toEqual([]);
  });

  it("no valid cache: the binary's levels, as before", () => {
    expect(agyModelEffortLevels("gemini-3.8-flash-medium")).toEqual(["low", "medium", "high"]);
    cacheCliEnv({ probedAt: Date.now() - 25 * 60 * 60 * 1000, effortLevels: ["max"] });
    expect(agyModelEffortLevels("gpt-oss-120b-medium")).toEqual(["low", "medium", "high"]);
  });
});

describe("the fleet's /effort levels for an agy instance are its model's", () => {
  it("the instance's model, else the fleet default's, else agy's own (the probe's currentModel)", async () => {
    cacheCliEnv({ effortLevels: ["low", "medium", "high", "xhigh", "max"], currentModel: "claude-opus-5-5-medium" });
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(join(root, "agend")) as any;
    try {
      fm.fleetConfig = { defaults: {}, instances: {
        oss: { backend: "antigravity", model: "gpt-oss-120b-medium", working_directory: root },
        gem: { backend: "antigravity", model: "Gemini 3.8 Flash (High)", working_directory: root },
        own: { backend: "antigravity", working_directory: root },
      } };
      expect(fm.effortLevelsFor("oss")).toEqual(["medium"]);
      expect(fm.effortLevelsFor("gem")).toEqual(["low", "medium", "high"]);
      expect(fm.effortLevelsFor("own")).toEqual(["low", "medium", "high"]);
      expect(fm.effortStrategyFor("oss")).toBe("runtime");
      fm.fleetConfig.defaults.model = "gpt-oss-120b-medium";
      expect(fm.effortLevelsFor("own")).toEqual(["medium"]);
    } finally { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); fm.memoryPressure.stop(); }
  });
});

describe("past the CLI env TTL: the catalog still counts while the probed binary is the one installed (review P2)", () => {
  const DAY_AND_MORE = Date.now() - 25 * 60 * 60 * 1000;
  const identity = (path: string) => { const st = statSync(path); return { path, size: st.size, mtimeMs: st.mtimeMs }; };
  const launch = (bin: string, over: Record<string, unknown>) => {
    const dir = join(root, "agend", "instances", "worker");
    mkdirSync(dir, { recursive: true });
    const be = new AntigravityBackend(dir, root, join(root, "agend"));
    (be as unknown as { binaryPath: string }).binaryPath = bin;
    const cmd = be.buildCommand({ workingDirectory: dir, instanceDir: dir, instanceName: "worker", mcpServers: {}, ...over } as never);
    return { cmd, notes: be.consumeQuietLaunchNotes() };
  };

  it("the probe records the file it ran", async () => {
    const bin = fakeAgy();
    const be = new AntigravityBackend(root, root, join(root, "agend"));
    (be as unknown as { binaryPath: string }).binaryPath = bin;
    (be as unknown as { listModels: () => Promise<unknown[]> }).listModels = async () => CATALOG;
    expect((await be.probeCLIEnv()).binary).toEqual(identity(bin));
  });

  it("a day-old cache of this same binary → the level's variant at launch, and the model's levels for /effort", () => {
    const bin = fakeAgy();
    cacheCliEnv({ probedAt: DAY_AND_MORE, binary: identity(bin), effortLevels: ["low", "medium", "high", "xhigh", "max"] });
    const { cmd, notes } = launch(bin, { model: "gemini-3.8-flash-medium", effort: "high" });
    expect(cmd).toContain(" --model 'gemini-3.8-flash-high'");
    expect(cmd).not.toContain("--effort");
    expect(notes).toEqual([t("effort.launch_agy_variant", "high", "gemini-3.8-flash-high", "gemini-3.8-flash-medium")]);
    expect(agyModelEffortLevels("gpt-oss-120b-medium")).toEqual(["medium"]);
    expect(readEffortMetadata("antigravity", root, "gemini-3.8-flash-low").levels).toEqual(["low", "medium", "high"]);
  });

  it("a day-old cache of another binary — replaced at that path, or a different path — is not read", () => {
    const bin = fakeAgy();
    const stale = (binary: unknown) => cacheCliEnv({ probedAt: DAY_AND_MORE, binary, effortLevels: ["low", "medium", "high", "xhigh", "max"] });
    const noCatalog = [t("effort.launch_skipped", "high", "antigravity", t("effort.launch_agy_no_catalog", "gemini-3.8-flash-medium"))];
    stale({ ...identity(bin), size: identity(bin).size + 1 });
    expect(launch(bin, { model: "gemini-3.8-flash-medium", effort: "high" }).notes).toEqual(noCatalog);
    expect(agyModelEffortLevels("gpt-oss-120b-medium")).toEqual(["low", "medium", "high"]);
    const other = fakeAgy("agy-other");
    stale(identity(other));
    expect(launch(bin, { model: "gemini-3.8-flash-medium", effort: "high" }).notes).toEqual(noCatalog);
    stale({ ...identity(bin), mtimeMs: identity(bin).mtimeMs - 1000 });                     // agy updated in place
    expect(launch(bin, { model: "gemini-3.8-flash-medium", effort: "high" }).notes).toEqual(noCatalog);
    // A recorded file that is gone (agy uninstalled or moved) describes nothing.
    for (const binary of [undefined, null, { path: bin }, "x", { path: join(root, "gone"), size: 1, mtimeMs: 1 }]) {
      stale(binary);
      expect(agyModelEffortLevels("gpt-oss-120b-medium"), JSON.stringify(binary)).toEqual(["low", "medium", "high"]);
    }
  });
});

describe("resolveAgyLaunch: never --model with another level's --effort", () => {
  const skipped = (level: string, why: string) => t("effort.launch_skipped", level, "antigravity", why);
  const GEMINI = "low, medium, high";

  it("no effort: the configured model, as it is (agy resolves a variant's slug and its label exactly)", () => {
    for (const model of ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (High)", "Gemini 3.5 Flash (High)", undefined]) {
      expect(resolveAgyLaunch(model, null, CATALOG)).toEqual({ model, effort: null, note: null });
    }
  });

  it.each([
    ["gemini-3.8-flash-medium", "medium", "gemini-3.8-flash-medium", null],
    ["gemini-3.8-flash-medium", "high", "gemini-3.8-flash-high", t("effort.launch_agy_variant", "high", "gemini-3.8-flash-high", "gemini-3.8-flash-medium")],
    ["Gemini 3.8 Flash (High)", "high", "gemini-3.8-flash-high", t("effort.launch_agy_variant", "high", "gemini-3.8-flash-high", "Gemini 3.8 Flash (High)")],
    ["Gemini 3.8 Flash (High)", "low", "gemini-3.8-flash-low", t("effort.launch_agy_variant", "low", "gemini-3.8-flash-low", "Gemini 3.8 Flash (High)")],
    ["gemini-3.8-flash", "high", "gemini-3.8-flash-high", t("effort.launch_agy_variant", "high", "gemini-3.8-flash-high", "gemini-3.8-flash")],
    ["claude-opus-5-5-low", "high", "claude-opus-5-5-high", t("effort.launch_agy_variant", "high", "claude-opus-5-5-high", "claude-opus-5-5-low")],
  ])("%s + %s → --model %s, no --effort", (model, level, launched, note) => {
    expect(resolveAgyLaunch(model, level, CATALOG)).toEqual({ model: launched, effort: null, note });
  });

  it.each([
    ["gemini-3.8-flash-medium", "xhigh", t("effort.launch_level_not_offered", GEMINI)],
    ["gpt-oss-120b-medium", "high", t("effort.launch_level_not_offered", "medium")],
    ["Gemini 3.5 Flash (High)", "high", t("effort.launch_agy_model_not_listed", "Gemini 3.5 Flash (High)")],
    ["Gemini 3.8 Flash", "high", t("effort.launch_agy_model_not_listed", "Gemini 3.8 Flash")],
  ])("%s + %s → the configured model, no --effort, and why", (model, level, why) => {
    expect(resolveAgyLaunch(model, level, CATALOG)).toEqual({ model, effort: null, note: skipped(level, why) });
  });

  it("a listed model without levels, or no catalog cached → the configured model, no --effort", () => {
    const withPlain = [...CATALOG, { id: "plain-model", label: "Plain" }];
    expect(resolveAgyLaunch("plain-model", "high", withPlain))
      .toEqual({ model: "plain-model", effort: null, note: skipped("high", t("effort.launch_agy_model_no_levels", "plain-model")) });
    for (const catalog of [null, []]) {
      expect(resolveAgyLaunch("gemini-3.8-flash-medium", "high", catalog))
        .toEqual({ model: "gemini-3.8-flash-medium", effort: null, note: skipped("high", t("effort.launch_agy_no_catalog", "gemini-3.8-flash-medium")) });
    }
  });

  it("no model: a bare --effort on agy's own model, unless that model is known to lack the level", () => {
    expect(resolveAgyLaunch(undefined, "high", CATALOG, "gemini-3.8-flash-medium")).toEqual({ model: undefined, effort: "high", note: null });
    expect(resolveAgyLaunch(undefined, "high", null, null)).toEqual({ model: undefined, effort: "high", note: null });
    expect(resolveAgyLaunch(undefined, "high", CATALOG, "something-else")).toEqual({ model: undefined, effort: "high", note: null });
    expect(resolveAgyLaunch(undefined, "xhigh", CATALOG, "gemini-3.8-flash-medium"))
      .toEqual({ model: undefined, effort: null, note: skipped("xhigh", t("effort.launch_level_not_offered", GEMINI)) });
    expect(resolveAgyLaunch(undefined, "high", [...CATALOG, { id: "plain-model", label: "Plain" }], "plain-model"))
      .toEqual({ model: undefined, effort: null, note: skipped("high", t("effort.launch_agy_model_no_levels", "plain-model")) });
  });

  it("over every model name and level, a launch never carries both --model and --effort", () => {
    const names = [undefined, ...CATALOG.flatMap(m => [m.id, m.label]), "gemini-3.8-flash", "Gemini 3.8 Flash", "unknown-x", "Unknown (High)"];
    for (const catalog of [CATALOG, null]) {
      for (const model of names) {
        for (const level of [null, "low", "medium", "high", "xhigh", "max"]) {
          const launch = resolveAgyLaunch(model, level, catalog, "gemini-3.8-flash-medium");
          expect(launch.model && launch.effort, `${model} + ${level}`).toBeFalsy();
          // A launched model with an effort configured is the exact catalog variant of that level, or the configured one.
          if (level && launch.model && launch.model !== model) expect(launch.model.endsWith(`-${level}`)).toBe(true);
        }
      }
    }
  });
});

describe("buildCommand: the launch line", () => {
  const backend = () => {
    const dir = join(root, "agend", "instances", "worker");
    mkdirSync(dir, { recursive: true });
    const be = new AntigravityBackend(dir, root, join(root, "agend"));
    (be as unknown as { binaryPath: string }).binaryPath = fakeAgy();
    return { be, dir };
  };
  const config = (dir: string, over: Record<string, unknown>) =>
    ({ workingDirectory: dir, instanceDir: dir, instanceName: "worker", mcpServers: {}, ...over }) as never;

  it("a variant + another level → that level's variant, no --effort; the note says what ran", () => {
    cacheCliEnv({ effortLevels: ["low", "medium", "high", "xhigh", "max"] });
    const { be, dir } = backend();
    const cmd = be.buildCommand(config(dir, { model: "gemini-3.8-flash-medium", effort: "high" }));
    expect(cmd).toContain(" --model 'gemini-3.8-flash-high'");
    expect(cmd).not.toContain("--effort");
    expect(be.consumeQuietLaunchNotes()).toEqual([t("effort.launch_agy_variant", "high", "gemini-3.8-flash-high", "gemini-3.8-flash-medium")]);
  });

  it("an old label + an effort → the variant's slug; the label alone is launched as it is", () => {
    cacheCliEnv({});
    const { be, dir } = backend();
    expect(be.buildCommand(config(dir, { model: "Gemini 3.8 Flash (High)", effort: "low" }))).toContain(" --model 'gemini-3.8-flash-low'");
    const plain = be.buildCommand(config(dir, { model: "Gemini 3.8 Flash (High)" }));
    expect(plain).toContain(" --model 'Gemini 3.8 Flash (High)'");
    expect(plain).not.toContain("--effort");
    expect(be.consumeQuietLaunchNotes()).toEqual([]);
  });

  it("no model: the bare --effort (agy applies it to its own model)", () => {
    cacheCliEnv({ currentModel: "claude-sonnet-5-5-low" });
    const { be, dir } = backend();
    const cmd = be.buildCommand(config(dir, { effort: "medium" }));
    expect(cmd).toContain(" --effort medium");
    expect(cmd).not.toContain("--model");
  });

  it("a level the model lacks → the configured model, no --effort, and the quiet note", () => {
    cacheCliEnv({});
    const { be, dir } = backend();
    const cmd = be.buildCommand(config(dir, { model: "gpt-oss-120b-medium", effort: "high" }));
    expect(cmd).toContain(" --model 'gpt-oss-120b-medium'");
    expect(cmd).not.toContain("--effort");
    expect(be.consumeQuietLaunchNotes()).toEqual([t("effort.launch_skipped", "high", "antigravity", t("effort.launch_level_not_offered", "medium"))]);
  });
});

describe("1.3.5 panes", () => {
  it("trust prompt: model status row, a model without levels, and AgEnD's statusLine row → 'yes'", () => {
    for (const name of ["trust-dialog.pane.txt", "trust-dialog-no-effort-model.pane.txt", "trust-dialog-agend-statusline.pane.txt"]) {
      expect(agyTrustDialogState(audit(name)), name).toBe("yes");
    }
  });

  it("not the live prompt when something else follows the options", () => {
    const pane = audit("trust-dialog-agend-statusline.pane.txt");
    expect(agyTrustDialogState(`${pane.trimEnd()}\n● the trust prompt again`)).toBeNull();
    expect(agyTrustDialogState(pane.replace("Context 0% used", "Context 0% used, said the agent"))).toBeNull();
    expect(agyTrustDialogState(pane.replace("Context 0% used", "  two-column indent"))).toBeNull();
    const status = audit("trust-dialog-no-effort-model.pane.txt");
    expect(agyTrustDialogState(`${status.trimEnd()}\n${" ".repeat(40)}one more right-aligned row`)).toBeNull();     // ≤ 2 rows
    // A status-like row counts only as the last row, under the hint (review P3).
    const hintRow = "  ↑/↓ Navigate · enter Confirm";
    for (const row of ["Context 0% used", `${" ".repeat(40)}GPT-OSS 120B (Medium)`]) {
      const swapped = pane.replace(`${hintRow}\nContext 0% used`, `${row}\n${hintRow}`);
      expect(swapped).not.toBe(pane);
      expect(agyTrustDialogState(swapped), row).toBeNull();
    }
  });

  it("idle, busy, logged-out and the model picker read as on 1.3.1", () => {
    const be = new AntigravityBackend("/nonexistent-agy-1825", "/nonexistent-home", "/nonexistent-agend");
    const idle = audit("idle-agend-statusline.pane.txt"), busy = audit("busy-generating.pane.txt");
    expect(be.getReadyPattern().test(idle)).toBe(true);
    expect(be.getBusyPattern().test(idle)).toBe(false);
    expect(be.getBusyPattern().test(busy)).toBe(true);
    expect(agyLoginScreenActive(audit("logged-out.pane.txt"))).toBe(true);
    const picker = audit("model-picker.pane.txt");
    expect(agyTrustDialogState(picker)).toBeNull();
    expect(agyLoginScreenActive(picker)).toBe(false);
    expect(be.getBusyPattern().test(picker)).toBe(false);
  });
});
