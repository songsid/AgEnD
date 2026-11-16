import { beforeEach, describe, expect, it, vi } from "vitest";
import { win32 } from "node:path";
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/child-process.js", async () => {
  const { promisify } = await import("node:util");
  const execFile = Object.defineProperty(() => { throw Error("Use the promise entry"); }, promisify.custom, { value: run });
  return { execFile };
});
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
  statSync: (path: string) => ({ isFile: () => path === "C:\\Program Files\\PowerShell\\7\\pwsh.exe" }) }));
import { checkPersonalCodexPrompt, resolvePersonalCodexShell } from "../src/runtime-personal-preflight.js";
import { PERSONAL_CODEX_DISABLED_FEATURES, personalAgentProfile } from "../src/runtime-personal-profile.js";
import { stagePersonalProbe, type PersonalStageHost } from "../src/runtime-personal-stage.js";
const cwd = "C:\\Private\\job\\work", home = "C:\\Private\\job\\auth";
const plan = () => personalAgentProfile({ cli: "codex", question: "Question", folder: "C:\\Shared", canonicalFolder: "C:\\Shared",
  context: { home: "C:\\Users\\Owner", systemRoots: [], privateRoots: [] }, work: cwd, home, runtimeReads: [], disabledSkills: [] });
const flags = PERSONAL_CODEX_DISABLED_FEATURES.map(n => `${n} stable false`).concat("skip_host_skill_discovery stable true").join("\n");
const rendered = JSON.stringify([{ role: "developer", content: [{ text: "An isolated workspace." }] }]);
beforeEach(() => { run.mockReset(); });
describe("personal Codex shell readiness", () => {
  it("does not call a Node-only sandbox success ready when the chosen PowerShell cannot read", async () => {
    run.mockImplementation(async (_command, args: string[]) => {
      if (args.includes("features")) return { stdout: flags };
      if (args.includes("prompt-input")) return { stdout: rendered };
      if (args.includes(process.execPath)) return { stdout: "PERSONAL_PROFILE_READY" };
      throw Error("Get-Content is unavailable: drive C does not exist");
    });
    await expect(checkPersonalCodexPrompt({ path: "codex.exe", command: "codex.exe", args: [] }, plan(), {})).rejects.toMatchObject({ reason: "profile-unavailable" });
  });
  it("requires the shell to read a staged canary with the same isolated profile and hidden bounded process", async () => {
    run.mockImplementation(async (_command, args: string[]) => ({ stdout: args.includes("features") ? flags : args.includes("prompt-input") ? rendered : "PERSONAL_PROFILE_READY\r\n" }));
    await checkPersonalCodexPrompt({ path: "codex.exe", command: "codex.exe", args: [] }, plan(), {});
    const [, args, options] = run.mock.calls.find(([, args]) => args.includes("Get-Content -LiteralPath 'C:\\Private\\job\\work\\.personal-read-check' -Raw -ErrorAction Stop"))!;
    expect(args).toContain("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(args.slice(args.indexOf("sandbox"), args.indexOf("--") + 1)).toEqual(["sandbox", "-P", "hub-personal", "--"]);
    expect(args).toContain("-NoProfile"); expect(args).toContain("-NonInteractive");
    expect(options).toMatchObject({ cwd, windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 4096 });
    expect(args).not.toContain("exec");
  });
  it("refuses a successful shell exit with missing or wrong readback", async () => {
    run.mockImplementation(async (_command, args: string[]) => ({ stdout: args.includes("features") ? flags : args.includes("prompt-input") ? rendered : args.includes(process.execPath) ? "PERSONAL_PROFILE_READY" : "" }));
    await expect(checkPersonalCodexPrompt({ path: "codex.exe", command: "codex.exe", args: [] }, plan(), {})).rejects.toMatchObject({ reason: "profile-unavailable" });
  });
  it("stages the read canary without reading authentication and removes it with the private stage", () => {
    const files = new Map<string, string>(); let cleaned = false;
    const host: PersonalStageHost = { platform: "win32", userHome: "C:\\Users\\Owner", environment: {}, now: () => 0, realDirectory: p => p,
      readPrivate: () => { throw Error("No authentication read permitted"); }, writePrivate: (p, v) => { files.set(p, v); },
      create: () => ({ work: cwd, home, cleanup: () => { cleaned = true; files.clear(); } }) };
    const stage = stagePersonalProbe({ cli: "codex", folder: "C:\\Shared", question: "Local check", runtimeReads: [] }, host);
    expect(files.get(win32.join(cwd, ".personal-read-check"))).toBe("PERSONAL_PROFILE_READY");
    expect(files.has(win32.join(home, "auth.json"))).toBe(false);
    stage.cleanup(); expect(cleaned).toBe(true); expect(files.size).toBe(0);
  });
  it("follows pwsh then Windows PowerShell discovery without selecting Store launchers or changing PATH", () => {
    const pwsh = "D:\\Shell\\pwsh.exe", winPs = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const env = { PATH: "C:\\Users\\Owner\\AppData\\Local\\Microsoft\\WindowsApps;D:\\Shell" };
    const saved = { ...env };
    expect(resolvePersonalCodexShell(env, p => p === pwsh || p.endsWith("WindowsApps\\pwsh.exe"))).toBe(pwsh);
    expect(resolvePersonalCodexShell({}, p => p === winPs)).toBe(winPs);
    expect(resolvePersonalCodexShell({}, () => false)).toBe(null);
    expect(env).toEqual(saved);
  });
});
