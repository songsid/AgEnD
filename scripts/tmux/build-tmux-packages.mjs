#!/usr/bin/env node
// Turn the four built bundles (scripts/tmux/build-tmux.mjs, one per runner) into the npm packages
// @songsid/agend-tmux-<os>-<cpu> (M-2457, docs/design/bundled-tmux.md §3/§8).
//
//   node scripts/tmux/build-tmux-packages.mjs --in <dir with tmux-<target>/> --out <dir> [--repack N] [--targets a,b]
//
// --targets: a subset (pull requests build only the Linux targets); a publish always packages all four.
//
// Each package holds bin/tmux, the terminfo subset and LICENSES/, and records in `agendTmux` the tmux version and the
// binary's sha256 — what postinstall verifies (launcher/tmux-bundle.cjs). Its version maps the tmux release onto semver
// (3.8 → 3.8.0, 3.7b → 3.7.2; `-agend.N` for a repack of the same tmux). No `bin` field: npm must never link this tmux
// onto PATH (AgEnD never uses the system tmux, and the user's own `tmux` stays theirs). No libc field: the Linux builds
// are fully static.
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSources, TARGETS } from "./build-tmux.mjs";

/** tmux "3.8" → "3.8.0", "3.7b" → "3.7.2" (the letter is the patch: a = 1). */
export function tmuxSemver(tmuxVersion, repack) {
  const m = /^(\d+)\.(\d+)([a-z]?)$/.exec(tmuxVersion);
  if (!m) throw new Error(`not a tmux release version: ${tmuxVersion}`);
  if (repack !== undefined && !/^[1-9]\d*$/.test(String(repack))) throw new Error(`repack must be a positive integer: ${repack}`);
  const patch = m[3] ? m[3].charCodeAt(0) - 96 : 0;
  return `${m[1]}.${m[2]}.${patch}${repack ? `-agend.${repack}` : ""}`;
}

export function tmuxManifest(target, info, repack) {
  const [os, cpu] = target.split("-");
  return {
    name: `@songsid/agend-tmux-${target}`,
    version: tmuxSemver(info.tmux, repack),
    description: `tmux ${info.tmux} for ${target}, built statically from pinned sources as AgEnD's private terminal multiplexer (M-2457). Not a general-purpose tmux install.`,
    license: "ISC AND BSD-3-Clause AND X11 AND MIT AND Unicode-3.0" + (os === "darwin" ? " AND BSD-2-Clause" : ""),
    repository: { type: "git", url: "git+https://github.com/songsid/AgEnD.git" },
    os: [os],
    cpu: [cpu],
    files: ["bin/tmux", "share/terminfo/", "LICENSES/", "build-info.json"],
    agendTmux: { tmux: info.tmux, sha256: info.sha256, size: info.size },
  };
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const input = resolve(arg("--in") ?? "tmux-build");
  const out = resolve(arg("--out") ?? "tmux-packages");
  const repack = arg("--repack") || undefined;
  const targets = arg("--targets") ? arg("--targets").split(",") : TARGETS;
  for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`unknown target ${t}`);
  const sources = readSources();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const target of targets) {
    const dir = join(input, `tmux-${target}`);
    if (!existsSync(dir)) throw new Error(`missing build for ${target}: ${dir}`);
    const info = JSON.parse(readFileSync(join(dir, "build-info.json"), "utf8"));
    if (info.target !== target || info.tmux !== sources.tmux.version) throw new Error(`${dir}: built ${info.target} tmux ${info.tmux}, not ${target} tmux ${sources.tmux.version}`);
    const bin = readFileSync(join(dir, "bin/tmux"));
    const sha = createHash("sha256").update(bin).digest("hex");
    if (sha !== info.sha256 || bin.length !== info.size) throw new Error(`${dir}: bin/tmux is not the binary build-info.json describes`);
    const pkg = join(out, `agend-tmux-${target}`);
    mkdirSync(pkg, { recursive: true });
    for (const part of ["bin", "share", "LICENSES", "build-info.json"]) cpSync(join(dir, part), join(pkg, part), { recursive: true });
    // CI artifacts lose file modes on the way between jobs: the binary is executable again here, checked above by sha.
    chmodSync(join(pkg, "bin/tmux"), 0o755);
    const manifest = tmuxManifest(target, info, repack);
    writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(pkg, "README.md"), `# ${manifest.name}\n\ntmux ${info.tmux} for ${target}, AgEnD's private tmux (always run on its own socket, never on PATH).\nInstalled by \`@songsid/agend\`; not meant to be installed on its own. Licenses: LICENSES/.\n`);
    console.log(`${manifest.name}@${manifest.version}: ${readdirSync(join(pkg, "share/terminfo")).length} terminfo dirs, sha256 ${sha}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`build-tmux-packages: ${e.message}`); process.exit(1); }
}
