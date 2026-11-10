#!/usr/bin/env node
// CI only. Same Noble font bytes as apt, with no apt indexes, root install or package hooks.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const PIN = JSON.parse(readFileSync(new URL("./ui-gate-fonts.json", import.meta.url), "utf8"));
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const xml = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** @param {{cacheDir: string, outputDir: string, pin?: any, env?: NodeJS.ProcessEnv, log?: (line: string) => void,
 * run?: (file: string, args: string[], options: {encoding: 'utf8', timeout: number, killSignal: 'SIGKILL', env: NodeJS.ProcessEnv}) => {status: number|null, signal?: string|null, error?: unknown, stdout?: string, stderr?: string}}} options */
export function prepareUiGateFonts({ cacheDir, outputDir, pin = PIN, run = spawnSync, env = process.env, log = console.log }) {
  if (!cacheDir || !outputDir || /[\r\n]/.test(cacheDir + outputDir)) throw Error("CJK fonts need explicit cache/output directories without newlines");
  if (basename(pin.archive) !== pin.archive || !/^[a-f0-9]{64}$/.test(pin.digest) || new URL(pin.url).protocol !== "https:") throw Error("Invalid CJK font pin");
  cacheDir = resolve(cacheDir); outputDir = resolve(outputDir);
  const archive = join(cacheDir, pin.archive), pending = archive + `.download-${process.pid}`;
  const checked = (phase, file, args, timeout, childEnv = env) => {
    const result = run(file, args, { encoding: "utf8", timeout, killSignal: "SIGKILL", env: childEnv });
    if (result.error || result.status !== 0 || result.signal) {
      throw Error(`CJK fonts ${phase} failed (limit ${timeout / 1000}s): ${String(result.stderr || result.error || result.signal || result.status).slice(0, 800)}`);
    }
    return result.stdout ?? "";
  };
  mkdirSync(cacheDir, { recursive: true });
  let source = "cache", ownedOutput = false;
  try {
    if (existsSync(archive) && !lstatSync(archive).isFile()) throw Error("CJK archive cache entry is not a regular file");
    if (!existsSync(archive) || digest(archive) !== pin.digest) {
      if (existsSync(archive)) { log("CJK font cache checksum mismatch; replacing it with the pinned archive"); rmSync(archive); }
      source = "download";
      log("CJK font cache miss; fetching the pinned Ubuntu archive (45s maximum, no retries)");
      checked("download", "curl", ["--disable", "--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "10", "--max-time", "45", "--retry", "0", "--output", pending, pin.url], 50_000);
      if (!existsSync(pending) || !lstatSync(pending).isFile() || digest(pending) !== pin.digest) throw Error("CJK font archive checksum mismatch; nothing will be extracted");
      renameSync(pending, archive);
    } else log("CJK font cache hit; archive checksum verified (no download)");

    // Require a fresh, owned directory, so cleanup cannot delete an existing caller directory.
    mkdirSync(outputDir, { mode: 0o700 }); ownedOutput = true;
    checked("extraction", "dpkg-deb", ["--extract", archive, outputDir], 20_000);
    const fontDir = join(outputDir, "usr/share/fonts/opentype/noto");
    for (const [file, expected] of Object.entries(pin.files)) {
      const path = join(fontDir, file);
      if (!existsSync(path) || !lstatSync(path).isFile() || digest(path) !== expected) throw Error(`CJK font checksum mismatch: ${file}`);
    }
    const rule = join(outputDir, pin.fontconfigRule.path);
    if (!existsSync(rule) || !lstatSync(rule).isFile() || digest(rule) !== pin.fontconfigRule.digest) throw Error("CJK Fontconfig rule checksum mismatch");
    const fontconfig = join(outputDir, "fonts.conf"), fontCache = join(outputDir, "font-cache");
    mkdirSync(fontCache);
    writeFileSync(fontconfig, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>\n<include>/etc/fonts/fonts.conf</include>\n<include>${xml(rule)}</include>\n<dir>${xml(fontDir)}</dir>\n<cachedir>${xml(fontCache)}</cachedir>\n</fontconfig>\n`);
    const fontEnv = { ...env, FONTCONFIG_FILE: fontconfig };
    checked("font cache", "fc-cache", ["--force", fontDir], 20_000, fontEnv);
    const matches = pin.checks.map(check => {
      const [file, family, style] = checked("font selection", "fc-match", ["--format", "%{file}\n%{family}\n%{style}\n", check.pattern], 5_000, fontEnv).trim().split("\n");
      if (!file || !existsSync(file) || digest(file) !== pin.files[check.file] || !family?.split(",").includes(check.family)) throw Error(`CJK glyph selection differs from the pin: ${check.pattern} (${family ?? "missing"}, ${file ?? "missing"})`);
      return { pattern: check.pattern, family, style, digest: pin.files[check.file] };
    });
    const receipt = { package: pin.package, version: pin.version, source, archiveDigest: pin.digest, fontconfig, files: pin.files, matches };
    writeFileSync(join(outputDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    log(`CJK fonts ready: ${pin.package} ${pin.version}; ${source}; regular/bold zh-TW faces verified`);
    return receipt;
  } catch (error) {
    if (ownedOutput) rmSync(outputDir, { recursive: true, force: true });
    throw error;
  } finally { rmSync(pending, { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { "cache-dir": { type: "string" }, "output-dir": { type: "string" } } });
    const result = prepareUiGateFonts({ cacheDir: values["cache-dir"], outputDir: values["output-dir"] });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `fontconfig=${result.fontconfig}\n`);
  } catch (error) { console.error(`::error::${error instanceof Error ? error.message : "CJK font preparation failed"}`); process.exitCode = 1; }
}
