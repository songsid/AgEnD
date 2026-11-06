/** Human-facing source identity only. Package SemVer, update checks and native runtime receipts stay independent. */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildProvenance {
  format: 1; commit: string | null; ref: string | null; channel: "alpha" | "source" | "release" | "unknown";
  modified: boolean | null; from: "git" | "archive" | "unknown";
}
export interface InstalledBuild { version: string; source: BuildProvenance | null; label: string }
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function fixedJson(path: string, limit: number): unknown {
  const fd = openSync(path, "r");
  try {
    const s = fstatSync(fd); if (!s.isFile() || s.size > limit) throw Error("build_info_unavailable");
    const bytes = Buffer.alloc(limit + 1); let length = 0, n: number;
    while (length < bytes.length && (n = readSync(fd, bytes, length, bytes.length - length, null))) length += n;
    if (length > limit) throw Error("build_info_unavailable");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally { closeSync(fd); }
}
export function parseBuildProvenance(v: unknown): BuildProvenance | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  if (Object.keys(p).sort().join() !== "channel,commit,format,from,modified,ref" || p.format !== 1
    || !(p.commit === null || typeof p.commit === "string" && SHA.test(p.commit))
    || !(p.ref === null || typeof p.ref === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(p.ref))
    || typeof p.channel !== "string" || !["alpha", "source", "release", "unknown"].includes(p.channel)
    || typeof p.from !== "string" || !["git", "archive", "unknown"].includes(p.from)
    || !(p.modified === null || typeof p.modified === "boolean")) return null;
  if (p.channel === "alpha" && (typeof p.ref !== "string" || !/^release\/\d+\.\d+\.\d+-alpha$/.test(p.ref))) return null;
  if (p.channel === "release" && (typeof p.ref !== "string" || !/^v\d+\.\d+\.\d+(?:-(?:alpha|beta)\.[0-9]+)?$/.test(p.ref))) return null;
  if (p.from === "unknown" ? p.channel !== "unknown" || p.commit !== null || p.ref !== null || p.modified !== null : p.commit === null) return null;
  if (p.from !== "unknown" && p.channel === "unknown" || p.from === "archive" && p.modified !== null) return null;
  return p as unknown as BuildProvenance;
}
export function installedBuildLabel(version: string, source: BuildProvenance | null,
  copy = { source: "source", modified: "modified", unknown: "changes unknown" }): string {
  const release = source?.channel === "release" && source.ref === `v${version}`;
  if (!source?.commit || release && source.modified !== true) return version;
  const base = release ? version : source.channel === "alpha" ? source.ref!.slice("release/".length) : copy.source;
  return `${base} · ${source.commit.slice(0, 12)}${source.modified === true ? ` (${copy.modified})` : source.modified === null ? ` (${copy.unknown})` : ""}`;
}
export function readInstalledBuild(directory = dirname(fileURLToPath(import.meta.url))): InstalledBuild {
  let version = "unknown", source: BuildProvenance | null = null;
  try { const pkg = fixedJson(join(directory, "..", "package.json"), 64 * 1024) as any;
    if (pkg?.name === "@songsid/agend" && typeof pkg.version === "string" && pkg.version.length <= 128
      && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(pkg.version)) version = pkg.version;
  } catch { /* legacy package metadata remains unknown */ }
  try { source = parseBuildProvenance(fixedJson(join(directory, "build-provenance.json"), 4096)); } catch { /* older packages have no stamp */ }
  return { version, source, label: installedBuildLabel(version, source) };
}
