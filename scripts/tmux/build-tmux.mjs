#!/usr/bin/env node
// Build AgEnD's bundled tmux for THIS host's platform from the pinned sources (M-2457, docs/design/bundled-tmux.md §3).
//
//   node scripts/tmux/build-tmux.mjs --target linux-x64 --out <dir> [--work <dir>] [--cache <dir>]
//
// - Every source comes from scripts/release/tmux-sources.json and must match its sha256 (a mismatch stops the build).
// - Linux (run on Alpine/musl): fully static — libevent, ncurses, utf8proc and musl linked in, so one binary runs on any
//   glibc or musl distro. macOS: libevent, ncurses, utf8proc and jemalloc linked statically, libSystem dynamic (Apple
//   has no static libc), MACOSX_DEPLOYMENT_TARGET=11.0.
// - No sixel/images (CVE-2026-11623's area), no utempter.
// - The toolchain is locked too (scripts/tmux/toolchain.mjs): the build refuses to run on any other, and records it.
// - Reproducible: SOURCE_DATE_EPOCH from the pin file, fixed flags, build paths mapped out of the binary
//   (-ffile-prefix-map), and the compiled-in terminfo directory is the system one, never the build directory. The
//   workflow builds twice in different directories and compares the binary's sha256.
// Output: <out>/tmux-<target>/{bin/tmux, share/terminfo/<subset>, LICENSES/*, build-info.json}.
// Built-ins only (fetch, crypto, fs) plus the system's tar, make and C toolchain.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toolchainEnv, toolchainIdentity } from "./toolchain.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SOURCES_FILE = join(ROOT, "scripts/release/tmux-sources.json");
export const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const PARTS = ["tmux", "libevent", "ncurses", "utf8proc", "jemalloc", "musl"];

/** The pin file, checked: every part has a version, an https url and a 64-hex sha256. */
export function readSources(file = SOURCES_FILE) {
  const s = JSON.parse(readFileSync(file, "utf8"));
  if (!Number.isInteger(s.sourceDateEpoch) || s.sourceDateEpoch <= 0) throw new Error("sourceDateEpoch must be a positive integer");
  for (const k of PARTS) {
    const p = s[k];
    if (!p || typeof p.version !== "string" || !/^https:\/\/\S+$/.test(p.url ?? "") || !/^[0-9a-f]{64}$/.test(p.sha256 ?? "") || typeof p.licenseFile !== "string") {
      throw new Error(`tmux-sources.json: ${k} needs version, an https url, a sha256 and a licenseFile`);
    }
  }
  if (!/^\d+\.\d+[a-z]?$/.test(s.tmux.version)) throw new Error(`not a tmux release version: ${s.tmux.version}`);
  if (!Array.isArray(s.terminfo) || !s.terminfo.length || !s.terminfo.every((n) => /^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(n))) throw new Error("terminfo must list entry names");
  for (const [alias, of] of Object.entries(s.terminfoAliases ?? {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(alias) || !s.terminfo.includes(of)) throw new Error(`terminfo alias ${alias} → ${of} must name a listed entry`);
  }
  return s;
}

/** The parts a target links: jemalloc only where its `platforms` say (darwin, as upstream does since 3.7c). */
export function partsFor(sources, target) {
  const os = target.split("-")[0];
  return PARTS.filter((k) => !sources[k].platforms || sources[k].platforms.includes(os));
}

/** The archive's top directory: <name>-<version> for every pinned source (utf8proc's tag archive included). */
export function srcDirName(part, version) {
  return `${part}-${version}`;
}

export function hostTarget(platform = process.platform, arch = process.arch) {
  const t = `${platform}-${arch}`;
  return TARGETS.includes(t) ? t : null;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function fetchVerified(part, src, cache) {
  const file = join(cache, src.url.split("/").pop().replace(/^v(?=\d)/, `${part}-`));
  if (existsSync(file) && sha256(readFileSync(file)) === src.sha256) return file;
  const res = await fetch(src.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${part}: GET ${src.url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== src.sha256) throw new Error(`${part}: sha256 ${got} is not the pinned ${src.sha256} — refusing ${src.url}`);
  writeFileSync(file, buf);
  return file;
}

function sh(cmd, args, opts) {
  execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], ...opts });
}

async function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const target = arg("--target") ?? hostTarget();
  const out = resolve(arg("--out") ?? "tmux-build");
  if (!TARGETS.includes(target ?? "")) throw new Error(`--target must be one of ${TARGETS.join(", ")}`);
  if (target !== hostTarget()) throw new Error(`this host builds ${hostTarget()}, not ${target} (no cross builds: each target builds and smoke-runs on its own runner)`);
  const sources = readSources();
  const toolchain = toolchainIdentity(target, sources);
  const work = resolve(arg("--work") ?? join(tmpdir(), `agend-tmux-${process.pid}`));
  const cache = resolve(arg("--cache") ?? join(work, "src"));
  const darwin = target.startsWith("darwin");
  rmSync(join(work, "b"), { recursive: true, force: true });
  for (const d of [work, cache, join(work, "b")]) mkdirSync(d, { recursive: true });
  const deps = join(work, "b", "deps");
  const stage = join(work, "b", "stage");
  const jobs = String(Math.max(1, cpus().length));
  const env = {
    ...process.env,
    SOURCE_DATE_EPOCH: String(sources.sourceDateEpoch),
    LC_ALL: "C", TZ: "UTC",
    // Paths of this build never reach the binary: the second build, in another directory, must be byte-identical.
    CFLAGS: `-O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2 -ffile-prefix-map=${work}=. -I${deps}/include -I${deps}/include/ncursesw`,
    CPPFLAGS: `-I${deps}/include -I${deps}/include/ncursesw`,
    LDFLAGS: `-L${deps}/lib`,
    PKG_CONFIG_PATH: join(deps, "lib/pkgconfig"),
    ...(darwin ? { MACOSX_DEPLOYMENT_TARGET: "11.0" } : {}),
    ...toolchainEnv(target, sources),
  };
  const parts = partsFor(sources, target);
  if (parts.includes("musl")) {
    // The libc linked in is the build image's: it must be the musl whose licence ships with the package.
    const r = spawnSync("ldd", ["--version"], { encoding: "utf8" });
    const seen = /Version ([0-9.]+)/.exec(`${r.stdout}${r.stderr}`)?.[1];
    if (seen !== sources.musl.version) throw new Error(`this build image's musl is ${seen ?? "unknown"}, not the pinned ${sources.musl.version}`);
  }
  const dirs = {};
  for (const part of parts) {
    const file = await fetchVerified(part, sources[part], cache);
    sh("tar", ["-xf", file, "-C", join(work, "b")]);
    dirs[part] = join(work, "b", srcDirName(part, sources[part].version));
    if (!existsSync(dirs[part])) throw new Error(`${part}: the archive has no ${srcDirName(part, sources[part].version)}/`);
  }
  const cfg = (part, args) => { sh("./configure", args, { cwd: dirs[part], env }); sh("make", ["-j", jobs], { cwd: dirs[part], env }); };

  cfg("libevent", [`--prefix=${deps}`, "--disable-shared", "--enable-static", "--disable-openssl", "--disable-samples", "--disable-libevent-regress", "--disable-debug-mode"]);
  sh("make", ["install"], { cwd: dirs.libevent, env });

  // The compiled-in terminfo location is the SYSTEM one: AgEnD points TERMINFO_DIRS at the bundled subset (§4), and no
  // build path is baked in. The database itself is installed into a DESTDIR and only the subset is kept.
  cfg("ncurses", [`--prefix=${deps}`, "--without-shared", "--with-normal", "--without-debug", "--without-ada", "--without-cxx",
    "--without-manpages", "--without-tests", "--enable-widec", "--disable-db-install",
    "--with-default-terminfo-dir=/usr/share/terminfo", "--with-terminfo-dirs=/etc/terminfo:/lib/terminfo:/usr/share/terminfo:/usr/lib/terminfo"]);
  sh("make", ["install"], { cwd: dirs.ncurses, env });
  // tmux's configure looks for -lncurses (or -ltinfo) before -lncursesw on some hosts: the wide library under both names.
  copyFileSync(join(deps, "lib/libncursesw.a"), join(deps, "lib/libncurses.a"));
  // The terminfo database for the subset, compiled by a host tic from the pinned ncurses' own source (misc/terminfo.src).
  const tdb = join(work, "b", "terminfo-all");
  mkdirSync(tdb, { recursive: true });
  sh(join(dirs.ncurses, "progs", "tic"), ["-x", "-o", tdb, join(dirs.ncurses, "misc", "terminfo.src")], { cwd: dirs.ncurses, env: { ...env, TERMINFO: tdb } });

  // utf8proc: its Makefile builds the static library; headers and the archive go into deps.
  sh("make", ["-j", jobs, "libutf8proc.a"], { cwd: dirs.utf8proc, env });
  mkdirSync(join(deps, "include"), { recursive: true });
  copyFileSync(join(dirs.utf8proc, "utf8proc.h"), join(deps, "include/utf8proc.h"));
  copyFileSync(join(dirs.utf8proc, "libutf8proc.a"), join(deps, "lib/libutf8proc.a"));

  if (parts.includes("jemalloc")) {
    cfg("jemalloc", [`--prefix=${deps}`, "--disable-shared", "--enable-static", "--disable-cxx", "--disable-stats", "--disable-doc"]);
    sh("make", ["install_lib_static", "install_include"], { cwd: dirs.jemalloc, env });
  }

  const tmuxArgs = [`--prefix=/opt/agend-tmux`, "--enable-utf8proc", "--disable-utempter"];
  if (darwin) tmuxArgs.push("--enable-jemalloc");
  else tmuxArgs.push("--enable-static");
  // musl has forkpty in libc; without this seed tmux's configure picks its own compat forkpty and the link collides.
  sh("./configure", tmuxArgs, { cwd: dirs.tmux, env: { ...env, ...(darwin ? {} : { ac_cv_search_forkpty: "none required" }) } });
  sh("make", ["-j", jobs], { cwd: dirs.tmux, env });

  // Stage.
  const dest = join(out, `tmux-${target}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, "bin"), { recursive: true });
  const bin = join(dest, "bin/tmux");
  copyFileSync(join(dirs.tmux, "tmux"), bin);
  sh("strip", darwin ? ["-x", bin] : [bin]);
  chmodSync(bin, 0o755);
  for (const name of sources.terminfo) {
    const from = findTerminfo(tdb, name);
    if (!from) throw new Error(`terminfo ${name} is not in ncurses ${sources.ncurses.version}`);
    placeTerminfo(dest, from.sub, name, from.file);
  }
  for (const [alias, of] of Object.entries(sources.terminfoAliases ?? {})) placeTerminfo(dest, null, alias, findTerminfo(tdb, of).file);
  mkdirSync(join(dest, "LICENSES"), { recursive: true });
  for (const part of parts) copyFileSync(join(dirs[part], sources[part].licenseFile), join(dest, "LICENSES", `${part}-${sources[part].licenseFile.replace(/\.md$/, "")}.txt`));
  const binSha = sha256(readFileSync(bin));
  const info = {
    target, tmux: sources.tmux.version, sha256: binSha, size: statSync(bin).size,
    sources: Object.fromEntries(parts.map((k) => [k, { version: sources[k].version, sha256: sources[k].sha256 }])),
    toolchain,
  };
  writeFileSync(join(dest, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
  console.log(`built ${dest}: tmux ${sources.tmux.version} ${target}, ${info.size} bytes, sha256 ${binSha}`);
}

/** A compiled entry under <db>/<x>/<name>: macOS's ncurses uses hex directories (78/), everyone else the letter. */
function findTerminfo(db, name) {
  for (const sub of [name[0], name.charCodeAt(0).toString(16)]) {
    const file = join(db, sub, name);
    if (existsSync(file)) return { sub, file };
  }
  return null;
}

/** Both directory spellings, so the subset resolves whichever ncurses reads it (the static one is letter-keyed). */
function placeTerminfo(dest, _sub, name, file) {
  for (const sub of [name[0], name.charCodeAt(0).toString(16)]) {
    mkdirSync(join(dest, "share/terminfo", sub), { recursive: true });
    copyFileSync(file, join(dest, "share/terminfo", sub, name));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(`build-tmux: ${e.message}`); process.exit(1); });
}
