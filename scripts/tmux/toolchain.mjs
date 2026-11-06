#!/usr/bin/env node
// The bundled tmux's build toolchain, pinned (M-2457 §3; Prism #3173 r1): the same commit must build with the same
// compiler, assembler, linker and static libc, not whatever a live package repository or runner image offers today.
//
//   node scripts/tmux/toolchain.mjs install-alpine   # inside the pinned Alpine image: the exact locked packages
//
// - Linux: the Alpine image is pinned by digest (tmux-sources.json toolchain.alpine.image; the workflow runs it), and
//   every package that takes part in the build is installed at its EXACT locked version and checked afterwards. If
//   the live repository no longer carries a locked version, the install fails: the lock is updated in a reviewed
//   change (like a source pin), never silently.
// - macOS: Xcode is selected explicitly (DEVELOPER_DIR of the locked Xcode), and its build number and SDK version
//   must equal the lock.
// The identity (versions plus the sha256 of the compiler, assembler, linker and libc) goes into build-info.json.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSources } from "./build-tmux.mjs";

const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const out = (cmd, args, env) => execFileSync(cmd, args, { encoding: "utf8", env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] }).trim();

/** `apk info -v` lines ("gcc-13.2.1_git20240309-r1") → { name: version }. */
export function parseApkInfo(text) {
  const installed = {};
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const m = /^(.+)-([^-]+-r\d+)$/.exec(line);
    if (m) installed[m[1]] = m[2];
  }
  return installed;
}

/** Locked packages that are missing or at another version: [] when the toolchain is exactly the lock. */
export function lockMismatches(lock, installed) {
  return Object.entries(lock).filter(([name, version]) => installed[name] !== version).map(([name, version]) => `${name}: want ${version}, have ${installed[name] ?? "none"}`);
}

function alpineLock(sources) {
  const a = sources.toolchain?.alpine;
  if (!a || !/^alpine:[\d.]+@sha256:[0-9a-f]{64}$/.test(a.image ?? "") || !a.release || !a.packages || !Object.keys(a.packages).length) {
    throw new Error("tmux-sources.json: toolchain.alpine needs image (by digest), release and packages");
  }
  return a;
}

function darwinLock(sources) {
  const d = sources.toolchain?.darwin;
  if (!d || !d.developerDir || !d.xcodeBuild || !d.sdk) throw new Error("tmux-sources.json: toolchain.darwin needs developerDir, xcodeBuild and sdk");
  return d;
}

/** The environment a darwin build runs with: the locked Xcode, explicitly. */
export function toolchainEnv(target, sources = readSources()) {
  return target.startsWith("darwin") ? { DEVELOPER_DIR: darwinLock(sources).developerDir } : {};
}

/**
 * Check this host's toolchain against the lock and describe it. Throws on any mismatch: a build never runs on an
 * unlocked toolchain.
 */
export function toolchainIdentity(target, sources = readSources()) {
  if (target.startsWith("linux")) {
    const a = alpineLock(sources);
    const release = existsSync("/etc/alpine-release") ? readFileSync("/etc/alpine-release", "utf8").trim() : null;
    if (release !== a.release) throw new Error(`this build image is Alpine ${release ?? "(not Alpine)"}, not the locked ${a.release} (${a.image})`);
    const bad = lockMismatches(a.packages, parseApkInfo(out("apk", ["info", "-v"])));
    if (bad.length) throw new Error(`the toolchain is not the locked one: ${bad.join("; ")}`);
    const tool = (name) => realpathSync(out("gcc", [`-print-prog-name=${name}`]).replace(/^(?!\/)/, "/usr/bin/"));
    const files = { gcc: realpathSync(out("sh", ["-c", "command -v gcc"])), cc1: tool("cc1"), as: tool("as"), ld: tool("ld"), "libc.a": "/usr/lib/libc.a" };
    return {
      kind: "alpine", image: a.image, release, packages: a.packages,
      gcc: out("gcc", ["--version"]).split("\n")[0],
      sha256: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, sha256File(f)])),
    };
  }
  const d = darwinLock(sources);
  const env = { ...process.env, DEVELOPER_DIR: d.developerDir };
  if (!existsSync(d.developerDir)) throw new Error(`the locked Xcode is not on this runner: ${d.developerDir}`);
  const xcode = out("xcodebuild", ["-version"], env);
  if (!xcode.includes(`Build version ${d.xcodeBuild}`)) throw new Error(`Xcode is not the locked build ${d.xcodeBuild}: ${xcode.replace(/\n/g, ", ")}`);
  const sdk = out("xcrun", ["--sdk", "macosx", "--show-sdk-version"], env);
  if (sdk !== d.sdk) throw new Error(`the macOS SDK is ${sdk}, not the locked ${d.sdk}`);
  const clang = out("xcrun", ["-f", "clang"], env);
  return {
    kind: "xcode", developerDir: d.developerDir, xcode: xcode.replace(/\n/g, ", "), sdk,
    clang: out(clang, ["--version"], env).split("\n")[0],
    sha256: { clang: sha256File(realpathSync(clang)), ld: sha256File(realpathSync(out("xcrun", ["-f", "ld"], env))), strip: sha256File(realpathSync(out("xcrun", ["-f", "strip"], env))) },
  };
}

/** Inside the pinned Alpine image: install exactly the locked packages, then prove the result is the lock. */
function installAlpine(sources) {
  const a = alpineLock(sources);
  const release = readFileSync("/etc/alpine-release", "utf8").trim();
  if (release !== a.release) throw new Error(`this image is Alpine ${release}, not the locked ${a.release}`);
  const r = spawnSync("apk", ["add", "--no-cache", ...Object.entries(a.packages).map(([n, v]) => `${n}=${v}`)], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("apk could not install the locked toolchain (a locked version no longer in the repository? update the lock in a reviewed change)");
  const bad = lockMismatches(a.packages, parseApkInfo(out("apk", ["info", "-v"])));
  if (bad.length) throw new Error(`after install, the toolchain is not the lock: ${bad.join("; ")}`);
  console.log(`toolchain: Alpine ${release}, ${Object.keys(a.packages).length} locked packages at their exact versions`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const cmd = process.argv[2];
    if (cmd === "install-alpine") installAlpine(readSources());
    else if (cmd === "identity") console.log(JSON.stringify(toolchainIdentity(process.argv[3], readSources()), null, 2));
    else { console.error("usage: toolchain.mjs install-alpine | identity <target>"); process.exit(2); }
  } catch (e) { console.error(`toolchain: ${e.message}`); process.exit(1); }
}
