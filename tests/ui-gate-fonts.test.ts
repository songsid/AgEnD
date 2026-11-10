import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { load } from "js-yaml";
import { prepareUiGateFonts } from "../scripts/ci/prepare-ui-gate-fonts.mjs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
type Result = { status: number | null; stdout?: string; stderr?: string; signal?: string | null; error?: Error };
function fixture(warm = true) {
  const root = mkdtempSync(join(tmpdir(), "agend-cjk-")); dirs.push(root);
  const cacheDir = join(root, "cache"), outputDir = join(root, "fonts & copy"); mkdirSync(cacheDir);
  const pin = { package: "fixture", version: "1", archive: "fixture.deb", url: "https://example.invalid/font.deb", digest: hash("archive"),
    fontconfigRule: { path: "usr/share/fontconfig/conf.avail/70-fonts-noto-cjk.conf", digest: hash("rules") },
    files: { "regular.ttc": hash("regular"), "bold.ttc": hash("bold") },
    checks: [{ pattern: "Noto Sans CJK TC:lang=zh-tw", file: "regular.ttc", family: "Noto Sans CJK TC" },
      { pattern: "Noto Sans CJK TC:lang=zh-tw:weight=bold", file: "bold.ttc", family: "Noto Sans CJK TC" }] };
  const archive = join(cacheDir, pin.archive);
  if (warm) writeFileSync(archive, "archive");
  const run = vi.fn((file: string, args: string[], _options: unknown): Result => {
    if (file === "curl") writeFileSync(args[args.indexOf("--output") + 1]!, "archive");
    else if (file === "dpkg-deb") {
      const fonts = join(args[2]!, "usr/share/fonts/opentype/noto"); mkdirSync(fonts, { recursive: true });
      const rules = join(args[2]!, "usr/share/fontconfig/conf.avail"); mkdirSync(rules, { recursive: true });
      writeFileSync(join(rules, "70-fonts-noto-cjk.conf"), "rules");
      writeFileSync(join(fonts, "regular.ttc"), "regular"); writeFileSync(join(fonts, "bold.ttc"), "bold");
    } else if (file === "fc-match") {
      const bold = args.at(-1)!.includes("bold");
      return { status: 0, stdout: `${join(outputDir, "usr/share/fonts/opentype/noto", bold ? "bold.ttc" : "regular.ttc")}\nNoto Sans CJK TC\n${bold ? "Bold" : "Regular"}\n` };
    }
    return { status: 0, stdout: "" };
  });
  const prepare = () => prepareUiGateFonts({ cacheDir, outputDir, pin, run, log: () => {} });
  return { root, cacheDir, outputDir, archive, pin, run, prepare };
}

describe("bounded pinned CJK font preparation", () => {
  it("uses a verified warm cache without any fetch and validates regular/bold face selection", () => {
    const f = fixture(); const result = f.prepare();
    expect(result.source).toBe("cache");
    expect(f.run.mock.calls.map(call => call[0])).toEqual(["dpkg-deb", "fc-cache", "fc-match", "fc-match"]);
    expect(result.matches.map(match => match.family)).toEqual(["Noto Sans CJK TC", "Noto Sans CJK TC"]);
    expect(readFileSync(result.fontconfig, "utf8")).toContain("fonts &amp; copy");
    expect(readFileSync(result.fontconfig, "utf8")).toContain("70-fonts-noto-cjk.conf</include>");
    expect(JSON.parse(readFileSync(join(f.outputDir, "receipt.json"), "utf8")).archiveDigest).toBe(f.pin.digest);
  });

  it("a cold miss fetches once with bounded TLS-only curl, then publishes only a verified archive", () => {
    const f = fixture(false); const result = f.prepare();
    expect(result.source).toBe("download");
    const [file, args, options] = f.run.mock.calls[0]!;
    expect(file).toBe("curl"); expect(args[0]).toBe("--disable");
    for (const [flag, value] of [["--connect-timeout", "10"], ["--max-time", "45"], ["--retry", "0"], ["--proto", "=https"], ["--proto-redir", "=https"]]) {
      expect(args[args.indexOf(flag!) + 1]).toBe(value);
    }
    expect(options).toMatchObject({ timeout: 50_000, killSignal: "SIGKILL" });
    expect(hash(readFileSync(f.archive, "utf8"))).toBe(f.pin.digest);
    expect(readdirSync(f.cacheDir)).toEqual([f.pin.archive]);
    for (const [program, , opts] of f.run.mock.calls) {
      expect((opts as { timeout: number }).timeout).toBeLessThanOrEqual(program === "curl" ? 50_000 : 20_000);
    }
  });

  it("a corrupt cache is replaced through the same pinned fetch", () => {
    const f = fixture(); writeFileSync(f.archive, "corrupt");
    expect(f.prepare().source).toBe("download");
    expect(f.run.mock.calls.filter(call => call[0] === "curl")).toHaveLength(1);
    expect(readFileSync(f.archive, "utf8")).toBe("archive");
  });

  it.each<Result>([{ status: 28, stderr: "operation timed out" }, { status: null, signal: "SIGKILL", error: Error("ETIMEDOUT") }, { status: 0, error: Error("failed") }])(
    "failed/held fetch returns a clear bounded refusal, with no extraction or partial archive: %j", failure => {
      const f = fixture(false); f.run.mockImplementationOnce((_file, args) => { writeFileSync(args[args.indexOf("--output") + 1]!, "partial"); return failure; });
      expect(f.prepare).toThrow("CJK fonts download failed (limit 50s)");
      expect(f.run).toHaveBeenCalledTimes(1); expect(existsSync(f.outputDir)).toBe(false);
      expect(readdirSync(f.cacheDir)).toEqual([]);
    });

  it("refuses a download with the wrong checksum before extraction", () => {
    const f = fixture(false); f.run.mockImplementationOnce((_file, args) => { writeFileSync(args[args.indexOf("--output") + 1]!, "wrong"); return { status: 0 }; });
    expect(f.prepare).toThrow("archive checksum mismatch");
    expect(f.run).toHaveBeenCalledTimes(1); expect(readdirSync(f.cacheDir)).toEqual([]); expect(existsSync(f.outputDir)).toBe(false);
  });

  it("refuses changed font bytes and removes its unadmitted output", () => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((file, args, options) => {
      const result = original(file, args, options);
      if (file === "dpkg-deb") writeFileSync(join(f.outputDir, "usr/share/fonts/opentype/noto/regular.ttc"), "changed");
      return result;
    });
    expect(f.prepare).toThrow("font checksum mismatch: regular.ttc");
    expect(f.run.mock.calls.map(call => call[0])).toEqual(["dpkg-deb"]); expect(existsSync(f.outputDir)).toBe(false);
  });

  it("refuses changed package Fontconfig rules instead of changing regional fallbacks", () => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((file, args, options) => {
      const result = original(file, args, options);
      if (file === "dpkg-deb") writeFileSync(join(f.outputDir, f.pin.fontconfigRule.path), "changed rules");
      return result;
    });
    expect(f.prepare).toThrow("Fontconfig rule checksum mismatch");
    expect(f.run).toHaveBeenCalledTimes(1); expect(existsSync(f.outputDir)).toBe(false);
  });

  it("rejects tofu/another family instead of silently measuring different glyphs", () => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((file, args, options) => {
      const result = original(file, args, options);
      if (file === "fc-match") result.stdout = result.stdout!.replace("Noto Sans CJK TC", "Fallback");
      return result;
    });
    expect(f.prepare).toThrow("glyph selection differs from the pin"); expect(existsSync(f.outputDir)).toBe(false);
  });

  it.each(["dpkg-deb", "fc-cache", "fc-match"])("bounds failed %s and retains no ready output", program => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((file, args, options) => file === program ? { status: null, signal: "SIGKILL" } : original(file, args, options));
    expect(f.prepare).toThrow("failed (limit"); expect(existsSync(f.outputDir)).toBe(false);
    expect(existsSync(f.archive)).toBe(true);
  });

  it("does not delete an existing caller directory on refusal", () => {
    const f = fixture(); mkdirSync(f.outputDir); writeFileSync(join(f.outputDir, "keep"), "keep");
    expect(f.prepare).toThrow(); expect(readFileSync(join(f.outputDir, "keep"), "utf8")).toBe("keep");
  });

  it.skipIf(process.platform === "win32")("the actual CLI reports a failed fetch and never exports a usable fontconfig", () => {
    const f = fixture(false), curl = join(f.root, "curl"), output = join(f.root, "github-output");
    writeFileSync(curl, "#!/bin/sh\nexit 28\n"); chmodSync(curl, 0o755);
    const result = spawnSync(process.execPath, [resolve("scripts/ci/prepare-ui-gate-fonts.mjs"), "--cache-dir", f.cacheDir, "--output-dir", f.outputDir], {
      encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: f.root, GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(1); expect(result.stderr).toContain("::error::CJK fonts download failed");
    expect(existsSync(output)).toBe(false); expect(existsSync(f.outputDir)).toBe(false);
  });

  it("keeps the UI gate deadline and makes cache restore/save optional, bounded optimizations", () => {
    const ci = load(readFileSync(resolve(".github/workflows/ci.yml"), "utf8")) as any;
    const gate = ci.jobs["ui-gate"], steps = gate.steps;
    expect(gate["timeout-minutes"]).toBe(10);
    expect(steps.some((s: any) => /apt-get/.test(s.run ?? ""))).toBe(false);
    const caches = steps.filter((s: any) => String(s.uses).startsWith("actions/cache/")); expect(caches).toHaveLength(2);
    expect(caches[0].with.key).toBe(caches[1].with.key); expect(caches[0].with["restore-keys"]).toBeUndefined();
    for (const step of caches) { expect(step["timeout-minutes"]).toBe(1); expect(step["continue-on-error"]).toBe(true); expect(step.uses).toMatch(/@[a-f0-9]{40}$/); }
    expect(caches[0].env.SEGMENT_DOWNLOAD_TIMEOUT_MINS).toBe("1");
    const prepare = steps.findIndex((s: any) => s.id === "cjk-fonts"), run = steps.findIndex((s: any) => s.name === "Run the UI gate");
    expect(prepare).toBeLessThan(run); expect(steps.indexOf(caches[1])).toBeGreaterThan(run);
    expect(steps[run].env.FONTCONFIG_FILE).toBe("${{ steps.cjk-fonts.outputs.fontconfig }}");
  });
});
