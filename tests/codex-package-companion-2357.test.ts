/**
 * #2357: a codex binary copied without `bin/codex-code-mode-host` starts and takes messages, then fails every tool call
 * of a code-mode-only account (AgEnD's reply included) while its pane shows only `⚠ N warnings · f2 to view`.
 * Fixtures: tests/fixtures/codex-0.163.0-companion-missing (SOURCES.md) — the official 0.163.0 package with the host
 * deleted, run offline through AgEnD's production launch.
 *
 * What is held here: the package check (read-only, the layout of the codex AgEnD launches) in `agend doctor` and at
 * every launch, and the exact rollout tool output codex records, told once per launch.
 */
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  codexCodeModeHostMissingRoot, codexPackageWarning, inspectCodexPackage, type CodexPackageFs,
} from "../src/backend/codex-package.js";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";
import { collectDoctorReport } from "../src/doctor.js";
import { resetSharedRolloutIndexesForTests } from "../src/rollout-index.js";
import { CodexRolloutSource } from "../src/transcript-sources.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";

const FIX = fileURLToPath(new URL("./fixtures/codex-0.163.0-companion-missing/", import.meta.url));
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");
const MANIFEST = JSON.stringify({ layoutVersion: 1, version: "0.163.0", target: "x86_64-unknown-linux-musl", variant: "codex",
  entrypoint: "bin/codex", resourcesDir: "codex-resources", pathDir: "codex-path" });
const MISSING = (root: string) => `Codex install incomplete — \`codex-code-mode-host\` is missing next to the codex binary (${root}/bin); reinstall Codex with the full official package`;

/** A stub filesystem: links, files (with the executable bit) and package resolution, nothing else. */
function stubFs(opts: { links?: Record<string, string>; files?: Record<string, string | true>; noExec?: string[]; resolved?: Record<string, string> }): CodexPackageFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    realpath: path => { const to = opts.links?.[path] ?? path; if (!(to in (opts.files ?? {}))) throw new Error("ENOENT"); return to; },
    readFile: path => { reads.push(path); const v = opts.files?.[path]; if (typeof v !== "string") throw new Error("ENOENT"); return v; },
    isFile: path => path in (opts.files ?? {}),
    isExecutable: path => path in (opts.files ?? {}) && !(opts.noExec ?? []).includes(path),
    resolveFrom: (_from, spec) => opts.resolved?.[spec] ?? null,
  };
}
const STANDALONE = "/home/u/.codex/packages/standalone/releases/0.163.0";
const standalone = (extra: { host?: boolean; noExec?: boolean; manifest?: string } = {}) => stubFs({
  links: { "/home/u/.local/bin/codex": `${STANDALONE}/bin/codex` },
  files: {
    [`${STANDALONE}/bin/codex`]: true,
    [`${STANDALONE}/codex-package.json`]: extra.manifest ?? MANIFEST,
    ...(extra.host === false ? {} : { [`${STANDALONE}/bin/codex-code-mode-host`]: true }),
  },
  noExec: extra.noExec ? [`${STANDALONE}/bin/codex-code-mode-host`] : [],
});

describe("the package check reads the layout of the codex AgEnD launches (stub fs)", () => {
  it("standalone install, complete: the symlink on PATH is followed to releases/<ver>, nothing missing", () => {
    expect(inspectCodexPackage("/home/u/.local/bin/codex", standalone(), "linux", "x64")).toEqual({ root: STANDALONE, problems: [] });
  });

  it("standalone install without the host (the incident): missing, with the reinstall sentence", () => {
    const fs = standalone({ host: false });
    expect(inspectCodexPackage("/home/u/.local/bin/codex", fs, "linux", "x64"))
      .toEqual({ root: STANDALONE, problems: [{ file: "bin/codex-code-mode-host", reason: "missing" }] });
    expect(codexPackageWarning("/home/u/.local/bin/codex", fs)).toBe(MISSING(STANDALONE));
  });

  it("the host present but not executable", () => {
    expect(inspectCodexPackage("/home/u/.local/bin/codex", standalone({ noExec: true }), "linux", "x64")?.problems)
      .toEqual([{ file: "bin/codex-code-mode-host", reason: "not-executable" }]);
  });

  it("npm: the bin/codex.js wrapper is followed into its platform package, as the wrapper resolves it", () => {
    const wrapper = "/usr/lib/node_modules/@openai/codex/bin/codex.js";
    const platformPkg = "/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64";
    const root = `${platformPkg}/vendor/x86_64-unknown-linux-musl`;
    const files = { [wrapper]: true as const, [`${platformPkg}/package.json`]: true as const, [`${root}/bin/codex`]: true as const, [`${root}/codex-package.json`]: MANIFEST };
    const fs = stubFs({ links: { "/usr/bin/codex": wrapper }, files, resolved: { "@openai/codex-linux-x64/package.json": `${platformPkg}/package.json` } });
    expect(inspectCodexPackage("/usr/bin/codex", fs, "linux", "x64")).toEqual({ root, problems: [{ file: "bin/codex-code-mode-host", reason: "missing" }] });
    // arm64 resolves its own package; without it nothing is claimed
    expect(inspectCodexPackage("/usr/bin/codex", fs, "linux", "arm64")).toBeNull();
  });

  it("npm without a resolvable platform package: the wrapper's own ../vendor fallback", () => {
    const wrapper = "/opt/codex/bin/codex.js";
    const root = "/opt/codex/vendor/x86_64-unknown-linux-musl";
    const fs = stubFs({ files: { [wrapper]: true, [`${root}/bin/codex`]: true, [`${root}/codex-package.json`]: MANIFEST, [`${root}/bin/codex-code-mode-host`]: true } });
    expect(inspectCodexPackage(wrapper, fs, "linux", "x64")).toEqual({ root, problems: [] });
  });

  it("windows names: codex.exe and codex-code-mode-host.exe", () => {
    const root = "C:/codex/releases/0.163.0";
    const fs = stubFs({ files: { [`${root}/bin/codex.exe`]: true, [`${root}/codex-package.json`]: MANIFEST.replace('"bin/codex"', '"bin/codex.exe"') } });
    expect(inspectCodexPackage(`${root}/bin/codex.exe`, fs, "win32", "x64")?.problems).toEqual([{ file: "bin/codex-code-mode-host.exe", reason: "missing" }]);
  });

  it.each([
    ["no codex on PATH (resolveBinary fell back to the bare name)", "codex", standalone()],
    ["no codex-package.json (an older or unofficial build)", "/x/bin/codex", stubFs({ files: { "/x/bin/codex": true } })],
    ["a manifest of another layout version", "/home/u/.local/bin/codex", standalone({ manifest: MANIFEST.replace('"layoutVersion":1', '"layoutVersion":2') })],
    ["a manifest naming another entrypoint", "/home/u/.local/bin/codex", standalone({ manifest: MANIFEST.replace('"bin/codex"', '"bin/codex2"') })],
    ["an unreadable manifest", "/home/u/.local/bin/codex", standalone({ manifest: "{not json" })],
    ["a binary not under bin/", "/x/codex", stubFs({ files: { "/x/codex": true, "/codex-package.json": MANIFEST } })],
  ])("nothing is claimed for an unknown layout: %s", (_name, binary, fs) => {
    expect(inspectCodexPackage(binary, fs, "linux", "x64")).toBeNull();
  });
});

describe("the package check on a real directory layout", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agend-2357-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const layout = (host: boolean) => {
    const pkg = join(root, "releases", "0.163.0");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    // Never run: a script that would leave a mark if it were.
    writeFileSync(join(pkg, "bin", "codex"), `#!/bin/sh\ntouch ${join(root, "RAN")}\n`); chmodSync(join(pkg, "bin", "codex"), 0o755);
    writeFileSync(join(pkg, "codex-package.json"), MANIFEST);
    if (host) { writeFileSync(join(pkg, "bin", "codex-code-mode-host"), ""); chmodSync(join(pkg, "bin", "codex-code-mode-host"), 0o755); }
    mkdirSync(join(root, "bin")); symlinkSync(join(pkg, "bin", "codex"), join(root, "bin", "codex"));
    return { pkg, binary: join(root, "bin", "codex") };
  };
  const launch = (binary: string) => {
    const b = new CodexBackend(join(root, "instance"));
    (b as unknown as { binaryPath: string }).binaryPath = binary;
    const cmd = b.buildCommand({ workingDirectory: root, instanceDir: join(root, "instance"), skipResume: true } as never);
    return { cmd, warning: b.consumeLaunchWarning(), again: b.consumeLaunchWarning() };
  };

  it("a launch of the incomplete package still launches, and says so once", () => {
    const { pkg, binary } = layout(false);
    const { cmd, warning, again } = launch(binary);
    expect(cmd).toContain(`${binary} --dangerously-bypass-approvals-and-sandbox`);
    expect(warning).toBe(MISSING(pkg));
    expect(again).toBeNull();
    expect(readFileSync(join(pkg, "codex-package.json"), "utf8")).toBe(MANIFEST);
    expect(() => readFileSync(join(root, "RAN"))).toThrow(); // codex was never run
  });

  it("a complete package launches quietly; each launch checks again", () => {
    const { pkg, binary } = layout(true);
    expect(launch(binary).warning).toBeNull();
    rmSync(join(pkg, "bin", "codex-code-mode-host"));
    expect(launch(binary).warning).toBe(MISSING(pkg));
  });

  it("a host without the executable bit", () => {
    const { pkg, binary } = layout(true);
    chmodSync(join(pkg, "bin", "codex-code-mode-host"), 0o644);
    expect(launch(binary).warning).toBe(`Codex install incomplete — \`codex-code-mode-host\` next to the codex binary (${pkg}/bin) is not executable; reinstall Codex with the full official package`);
  });
});

describe("agend doctor reports the codex package (read-only, every dependency stubbed)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const home = (backend: string) => {
    const dir = mkdtempSync(join(tmpdir(), "agend-2357-doctor-")); dirs.push(dir);
    writeFileSync(join(dir, "fleet.yaml"), `defaults:\n  backend: ${backend}\ninstances:\n  worker:\n    working_directory: /tmp\n`);
    return dir;
  };
  const run = vi.fn(() => ({ status: 0, stdout: "codex-cli 0.163.0\n", stderr: "", pid: 1, signal: null, output: [], error: undefined }) as never);
  const deps = (codexPackage: () => ReturnType<typeof inspectCodexPackage>) => ({
    env: {}, platform: "linux" as const, run, processAlive: () => false, connectSocket: async () => false,
    networkFamily: () => ({ autoSelectFamily: true, attemptTimeoutMs: 250 }),
    collectResources: async () => ({ disk: [], memory: null }) as never, fetchFleetHealth: async () => ({}),
    systemUnitPath: () => null, codexPackage,
  });
  const service = { installed: false, path: "", manager: "none", enabled: false, active: false } as never;
  const rows = (checks: Array<{ label: string; status: string }>) => checks.filter(c => c.label === "Codex package");

  it("the incomplete package is an error with the reinstall sentence", async () => {
    const report = await collectDoctorReport(home("codex"), service, deps(() => ({ root: STANDALONE, problems: [{ file: "bin/codex-code-mode-host", reason: "missing" }] })));
    expect(rows(report.checks)).toEqual([{ section: "Prerequisites", status: "error", label: "Codex package", detail: MISSING(STANDALONE) }]);
  });

  it("a complete package is ok; an unknown layout claims nothing", async () => {
    expect(rows((await collectDoctorReport(home("codex"), service, deps(() => ({ root: STANDALONE, problems: [] })))).checks))
      .toEqual([{ section: "Prerequisites", status: "ok", label: "Codex package", detail: `complete (${STANDALONE})` }]);
    expect(rows((await collectDoctorReport(home("codex"), service, deps(() => null))).checks)).toEqual([]);
  });

  it("a fleet without codex never looks", async () => {
    const codexPackage = vi.fn(() => null);
    await collectDoctorReport(home("claude-code"), service, deps(codexPackage));
    expect(codexPackage).not.toHaveBeenCalled();
  });

  it("the real check on a fake binary never runs it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-2357-real-")); dirs.push(dir);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "codex"), `#!/bin/sh\ntouch ${join(dir, "RAN")}\n`); chmodSync(join(dir, "bin", "codex"), 0o755);
    writeFileSync(join(dir, "codex-package.json"), MANIFEST);
    const report = await collectDoctorReport(home("codex"), service, deps(() => inspectCodexPackage(join(dir, "bin", "codex"))));
    expect(rows(report.checks).map(c => c.status)).toEqual(["error"]);
    expect(() => readFileSync(join(dir, "RAN"))).toThrow();
  });
});

describe("the rollout's tool output: codex's own text, matched whole", () => {
  const captured = fixture("rollout-tool-output.jsonl").trim().split("\n").map(line => JSON.parse(line));
  const output = captured.find(r => r.payload.type === "custom_tool_call_output").payload.output as string;
  const root = output.slice("failed to spawn code-mode host ".length, output.indexOf("/bin/codex-code-mode-host"));

  it("the real 0.163.0 output names the package root", () => {
    expect(output).toMatch(/^failed to spawn code-mode host \/.+\/missing163\/bin\/codex-code-mode-host: No such file or directory \(os error 2\)$/);
    expect(codexCodeModeHostMissingRoot(output)).toBe(root);
  });

  it.each([
    ["the model quoting it in a sentence", `I could not run the tool: ${output}. I will retry.`],
    ["the output with more after it", `${output}\nretrying`],
    ["the output with text before it", `error: ${output}`],
    ["a relative path", "failed to spawn code-mode host bin/codex-code-mode-host: No such file or directory (os error 2)"],
    ["a relative package root", "failed to spawn code-mode host opt/codex/bin/codex-code-mode-host: No such file or directory (os error 2)"],
    ["another os error", output.replace("No such file or directory (os error 2)", "Permission denied (os error 13)")],
    ["another helper", output.replace("codex-code-mode-host", "codex-voice-host")],
    ["the F2 warning text", "Code Mode is unavailable because failed to spawn code-mode host /x/bin/codex-code-mode-host: host executable was not found."],
    ["code that names the helper", 'const host = join(root, "bin/codex-code-mode-host"); // install `codex-code-mode-host`'],
    ["content items instead of a string", [{ type: "input_text", text: output }]],
  ])("not matched: %s", (_name, value) => {
    expect(codexCodeModeHostMissingRoot(value)).toBeNull();
  });

  it("the pane never shows it: only the footer's warning count (the TUI after the failing turn)", () => {
    const pane = fixture("tui-after-tool-turn.pane.txt");
    expect(pane).toContain("⚠ 4 warnings · f2 to view");
    expect(pane).not.toContain("codex-code-mode-host");
    expect(fixture("tui-warning-f2.pane.txt")).toContain("Code Mode is unavailable because failed to spawn code-mode host");
  });
});

describe("the codex rollout source reports it (the real rollout records)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-2357-rollout-")); resetSharedRolloutIndexesForTests(0); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a failed tool call yields the root; an ordinary tool output yields nothing", async () => {
    const work = join(dir, "work"); const day = join(dir, "sessions", "2026", "10", "22"); mkdirSync(day, { recursive: true });
    const path = join(day, "rollout-2357.jsonl");
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(path, fixture("rollout-session-meta.jsonl").replaceAll("__CWD__", work)); utimesSync(path, now, now);
    const source = new CodexRolloutSource(work, join(dir, "sessions"));
    await source.poll();
    const records = fixture("rollout-tool-output.jsonl");
    appendFileSync(path, records);
    const first = await source.poll();
    expect(first.toolResults.length).toBe(1);
    expect(first.codexPackageMissingHost).toHaveLength(1);
    expect(first.codexPackageMissingHost![0]).toMatch(/\/missing163$/);
    const ordinary = records.replace(/"output":\s*"failed to spawn[^"]*"/, '"output":"Script completed"');
    expect(ordinary).not.toContain("failed to spawn");
    appendFileSync(path, ordinary);
    const second = await source.poll();
    expect(second.toolResults.length).toBe(1);
    expect(second.codexPackageMissingHost).toBeUndefined();
  });
});

describe("the transcript monitor passes it on", () => {
  it("one event per reported root, with the tool result beside it", async () => {
    const source = { poll: async () => ({ toolUses: [], toolResults: [{ name: "exec" }], assistantTexts: [], codexPackageMissingHost: ["/opt/codex"] }), reset() {} };
    const monitor = new TranscriptMonitor("/not-used", { debug: vi.fn() } as never, source as never);
    const seen: unknown[] = [];
    monitor.on("codex_package_missing_host", (root: unknown) => seen.push(root));
    await monitor.pollIncrement();
    expect(seen).toEqual(["/opt/codex"]);
  });
});

describe("the daemon tells it once per launch", () => {
  it("a model retry loop is one notice; the next launch may notice again", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-2357-daemon-"));
    try {
      const daemon = new Daemon("worker", { working_directory: dir, backend: "codex", log_level: "silent" } as never,
        join(dir, "instance"), false, undefined, undefined, pino({ level: "silent" }) as never) as unknown as {
        noteCodexPackageMissingHost(root: string): void; on(e: string, f: (x: unknown) => void): void; spawnGeneration: number; launchAttempt: number;
      };
      const seen: unknown[] = [];
      daemon.on("backend_launch_warning", e => seen.push(e));
      for (let i = 0; i < 5; i++) daemon.noteCodexPackageMissingHost("/opt/codex");
      expect(seen).toEqual([{ name: "worker", message: MISSING("/opt/codex") }]);
      daemon.launchAttempt++;
      daemon.noteCodexPackageMissingHost("/opt/codex");
      expect(seen).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
