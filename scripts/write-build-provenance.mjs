/** Build-time only; runtime reads the fixed emitted JSON and never runs Git or reads environment overrides. */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta)\.[0-9]+)?$/;
const alpha = /^(?:origin\/)?release\/(\d+\.\d+\.\d+-alpha)$/;
function chooseRef(refs) {
  const parts = refs.split(",").map(s => s.trim().replace(/^HEAD -> /, ""));
  const tags = parts.filter(p => p.startsWith("tag: ")).map(p => p.slice(5)).filter(p => TAG.test(p));
  if (tags.length === 1) return { ref: tags[0], channel: "release" };
  const a = parts.find(p => alpha.test(p));
  if (a) return { ref: a.replace(/^origin\//, ""), channel: "alpha" };
  const ref = parts.find(p => p !== "HEAD" && REF.test(p));
  return { ref: ref ?? null, channel: "source" };
}
/**
 * #3484 (M-2723): the release stamps its own version (publish.yml `npm pkg set version=<tag>`) and `npm publish` then rebuilds
 * (prepublishOnly), so the packed provenance was written on a tree whose only change was that stamp — and every published
 * package read "modified". A package.json that differs from HEAD in nothing but `version` is that stamp, not a source
 * change. Anything else — another field, another file, an untracked file — still makes the build modified.
 */
function onlyVersionStamped(root, git) {
  try {
    // npm pkg set rewrites the whole file: it also sorts the dependency maps by name (and unescapes \u2014). Their order
    // means nothing, so they compare sorted; every other field compares exactly (order can matter, e.g. in exports).
    const DEPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
    const strip = text => {
      const v = JSON.parse(text); if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      delete v.version;
      for (const k of DEPS) if (v[k] && typeof v[k] === "object" && !Array.isArray(v[k])) v[k] = Object.fromEntries(Object.entries(v[k]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      return JSON.stringify(v);
    };
    const before = strip(git(["show", "HEAD:package.json"])), after = strip(readFileSync(join(root, "package.json"), "utf8"));
    return before !== null && before === after;
  } catch { return false; }
}
export function buildProvenance(root, run = execFileSync) {
  root = realpathSync(root);
  const unknown = { format: 1, commit: null, ref: null, channel: "unknown", modified: null, from: "unknown" };
  const git = args => String(run("git", ["-C", root, ...args], { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] })).trim();
  // An extracted archive must not accidentally inherit a containing checkout's identity.
  if (existsSync(join(root, ".git"))) try {
    if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== root) return unknown;
    const commit = git(["rev-parse", "--verify", "HEAD"]);
    if (!SHA.test(commit)) return unknown;
    const refs = git(["show", "-s", "--format=%D", "HEAD"]);
    const selected = chooseRef(refs);
    let modified = null;
    try {
      // Untrimmed: a porcelain line's leading space is its status (" M package.json").
      const status = String(run("git", ["-C", root, "status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
      const lines = status.split("\n").filter(line => line !== "");
      modified = lines.some(line => !(/^(?: M|M |MM) package\.json$/.test(line) && onlyVersionStamped(root, git)));
    } catch { /* unknown is not clean */ }
    return { format: 1, commit, ...selected, modified, from: "git" };
  } catch { /* a build without Git can still use an export-substituted archive */ }
  try {
    const fd = openSync(join(root, "scripts/source-build.txt"), "r");
    let bytes;
    try {
      const info = fstatSync(fd); if (!info.isFile() || info.size > 4096) return unknown;
      const buffer = Buffer.alloc(4097); let size = 0, n;
      while (size < buffer.length && (n = readSync(fd, buffer, size, buffer.length - size, null))) size += n;
      if (size > 4096) return unknown;
      bytes = buffer.subarray(0, size);
    } finally { closeSync(fd); }
    const match = /^format=1\ncommit=([0-9a-f]{40}|[0-9a-f]{64})\nrefs=([^\r\n]{0,2048})\n?$/.exec(bytes.toString("utf8"));
    if (!match) return unknown;
    return { format: 1, commit: match[1], ...chooseRef(match[2]), modified: null, from: "archive" };
  } catch { return unknown; }
}
export function writeBuildProvenance(root, output = join(root, "dist/build-provenance.json")) {
  const value = buildProvenance(root);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(value) + "\n");
  return value;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  writeBuildProvenance(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
