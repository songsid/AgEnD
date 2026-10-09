#!/usr/bin/env node
// Build the @songsid/agend-node-<os>-<cpu> packages from an OFFICIAL Node release (#1450, option A).
//
//   node scripts/runtime/build-runtime-packages.mjs --node 22.23.3 --out <dir>
//        [--dist-url https://nodejs.org/dist] [--keyring <pubring.kbx>] [--release-keys-commit <sha>] [--repack N]
//
// Nothing is compiled and nothing is trusted from the network unverified:
//   1. SHASUMS256.txt and its detached signature SHASUMS256.txt.sig are fetched, and the signature is checked with
//      gpgv against the Node release keyring — nodejs/release-keys `gpg-only-active-keys/pubring.kbx` at a PINNED
//      commit (or --keyring);
//   2. each platform tarball is fetched and its sha256 must equal the signed SHASUMS entry;
//   3. only `bin/node` and `LICENSE` are taken out of it, into a package whose version is the Node version
//      (`-agend.N` for a repack of the same Node) and whose os/cpu/libc fields let npm install it only where it runs.
// The packages have NO `bin` field: npm must never link this `node` into a global bin directory.
// Built-ins only (fetch, crypto, fs) plus `tar` and `gpgv` from the system.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** nodejs/release-keys at a reviewed commit: the keyring that verifies SHASUMS256.txt.sig. */
export const RELEASE_KEYS_COMMIT = "481637f813e912c4aa3622d7964ab426c97b8e8d";
export const DEFAULT_DIST_URL = "https://nodejs.org/dist";

/** The platforms AgEnD ships a runtime for (official glibc builds only; musl is not shipped, #1450). */
export const PLATFORMS = [
  { id: "linux-x64", os: "linux", cpu: "x64", libc: ["glibc"] },
  { id: "linux-arm64", os: "linux", cpu: "arm64", libc: ["glibc"] },
  { id: "darwin-x64", os: "darwin", cpu: "x64" },
  { id: "darwin-arm64", os: "darwin", cpu: "arm64" },
];

/** `SHASUMS256.txt` → { filename: sha256 }. Lines that are not "<64 hex>  <name>" are rejected, not skipped. */
export function parseShasums(text) {
  const sums = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (!m) throw new Error(`malformed SHASUMS256 line: ${JSON.stringify(line)}`);
    sums[m[2]] = m[1];
  }
  return sums;
}

/** The manifest of one runtime package. */
export function runtimeManifest(platform, nodeVersion, repack) {
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error(`not a Node release version: ${nodeVersion}`);
  if (repack !== undefined && !/^[1-9]\d*$/.test(String(repack))) throw new Error(`repack must be a positive integer: ${repack}`);
  return {
    name: `@songsid/agend-node-${platform.id}`,
    version: repack ? `${nodeVersion}-agend.${repack}` : nodeVersion,
    description: `Official Node.js ${nodeVersion} for ${platform.id}, as AgEnD's private runtime (#1450). Not a general-purpose Node install.`,
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/songsid/AgEnD.git" },
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc ? { libc: platform.libc } : {}),
    files: ["bin/node", "LICENSE"],
    agendRuntime: { node: nodeVersion, tarball: tarballName(platform, nodeVersion) },
  };
}

export const tarballName = (platform, nodeVersion) => `node-v${nodeVersion}-${platform.id}.tar.gz`;

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function download(url, path) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** gpgv exits non-zero unless the signature is good AND made by a key in the keyring. */
export function verifySignature(keyring, sigPath, dataPath) {
  try {
    execFileSync("gpgv", ["--keyring", resolve(keyring), sigPath, dataPath], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw new Error(`SHASUMS256.txt signature check failed: ${String(err.stderr ?? err.message).trim()}`);
  }
}

export async function buildRuntimePackages({ node, out, distUrl = DEFAULT_DIST_URL, keyring, releaseKeysCommit = RELEASE_KEYS_COMMIT, repack, platforms = PLATFORMS, log = console.log }) {
  const work = mkdtempSync(join(tmpdir(), "agend-runtime-"));
  try {
    const base = `${distUrl.replace(/\/$/, "")}/v${node}`;
    let ring = keyring;
    if (!ring) {
      ring = join(work, "pubring.kbx");
      await download(`https://raw.githubusercontent.com/nodejs/release-keys/${releaseKeysCommit}/gpg-only-active-keys/pubring.kbx`, ring);
    }
    await download(`${base}/SHASUMS256.txt`, join(work, "SHASUMS256.txt"));
    await download(`${base}/SHASUMS256.txt.sig`, join(work, "SHASUMS256.txt.sig"));
    verifySignature(ring, join(work, "SHASUMS256.txt.sig"), join(work, "SHASUMS256.txt"));
    const sums = parseShasums(readFileSync(join(work, "SHASUMS256.txt"), "utf8"));
    log(`  ✓ SHASUMS256.txt for v${node}: signature verified`);
    const built = [];
    for (const platform of platforms) {
      const file = tarballName(platform, node);
      const expected = sums[file];
      if (!expected) throw new Error(`${file} is not in the signed SHASUMS256.txt`);
      const tarball = join(work, file);
      await download(`${base}/${file}`, tarball);
      const actual = sha256File(tarball);
      if (actual !== expected) throw new Error(`${file}: sha256 ${actual} does not match the signed ${expected}`);
      const dir = join(out, `agend-node-${platform.id}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, "bin"), { recursive: true });
      const top = `node-v${node}-${platform.id}`;
      // Only the two members we ship; tar refuses names outside them, so nothing else can land in the package.
      execFileSync("tar", ["-xzf", tarball, "-C", dir, "--strip-components=1", "--no-same-owner", `${top}/bin/node`, `${top}/LICENSE`], { stdio: "pipe" });
      // A signed archive is still only trusted for what it is: both outputs must be REGULAR FILES, checked without
      // following links, before anything is changed or recorded (#1457 review: a symlink member would make chmod act on
      // its target, a directory member would carry its descendants into the package).
      for (const member of ["bin/node", "LICENSE"]) {
        let kind = "missing";
        try { const st = lstatSync(join(dir, member)); kind = st.isFile() ? "file" : st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : "special"; } catch { /* missing */ }
        if (kind !== "file") {
          rmSync(dir, { recursive: true, force: true });
          throw new Error(`${file}: ${member} is a ${kind}, not a regular file`);
        }
      }
      const extra = (path) => lstatSync(path).isDirectory() ? readdirSync(path).map(name => `${path}/${name}`).flatMap(extra) : [path];
      const shipped = extra(dir).map(path => path.slice(dir.length + 1)).sort();
      if (shipped.join(",") !== "LICENSE,bin/node") {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`${file}: unexpected content extracted: ${shipped.join(", ")}`);
      }
      chmodSync(join(dir, "bin", "node"), 0o755);
      const manifest = runtimeManifest(platform, node, repack);
      manifest.agendRuntime.sha256 = expected;
      writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
      built.push({ dir, name: manifest.name, version: manifest.version, size: statSync(join(dir, "bin", "node")).size });
      log(`  ✓ ${manifest.name}@${manifest.version} (${file} sha256 verified)`);
    }
    return built;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!key || argv[i + 1] === undefined) throw new Error(`usage: --node <x.y.z> --out <dir> [--dist-url u] [--keyring f] [--release-keys-commit sha] [--repack N]`);
    out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = args(process.argv.slice(2));
  if (!opts.node || !opts.out) { console.error("--node and --out are required"); process.exit(2); }
  buildRuntimePackages({ ...opts, out: resolve(opts.out) }).then(
    built => { for (const b of built) console.log(`${b.name}@${b.version} ${b.dir} (${b.size} bytes)`); },
    err => { console.error(`✗ ${err.message}`); process.exit(1); },
  );
}
