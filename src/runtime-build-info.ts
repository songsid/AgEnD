/** Read only fixed program assets; no CLI discovery, profile files, shell or network. */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_PANE_MODULES } from "./runtime-pane-assets.js";
import { RUNTIME_PROTOCOL_VERSION, validRuntimeVersion, type RuntimeInfo } from "./runtime-protocol.js";
import { RUNTIME_CREDENTIAL_CAPABILITY } from "./runtime-credential-profiles.js";

export const RUNTIME_BUNDLE_MODULES = Object.freeze([
  "runtime-cli.js", "runtime-client.js", "runtime-client-store.js", "runtime-protocol.js", "runtime-build-info.js", "runtime-connection.js", "windows-cli.js", "windows-cli-worker.js",
  "windows-cli-providers.js", "child-process.js", "windows-native-mcp.js", "model-catalog-defaults.js", "atomic-write.js", "runtime-switches.js", "runtime-credential-profiles.js", "claude-auth-status.js", ...RUNTIME_PANE_MODULES,
]);
function boundedFile(path: string, limit: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw Error("Runtime program asset is unavailable");
    const bytes = Buffer.alloc(stat.size + 1); let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > stat.size || length > limit) throw Error("Runtime program asset changed or is too large");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
export function runtimeCodeBuildId(version: string, modules: ReadonlyArray<readonly [string, Uint8Array]>): string {
  return createHash("sha256").update(JSON.stringify({ format: "agend-runtime-code-v1", version,
    modules: modules.map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]) })).digest("hex");
}
/** Missing package metadata stays unknown; the coordinator's version is never substituted. */
export function readRuntimeInfo(options: { moduleDirectory?: string; packagePath?: string; panes?: boolean } = {}): RuntimeInfo {
  const directory = options.moduleDirectory ?? dirname(fileURLToPath(import.meta.url));
  const result: RuntimeInfo = { protocolVersions: [RUNTIME_PROTOCOL_VERSION], capabilities: ["exec", "mcp", ...((options.panes ?? process.platform === "win32") ? ["panes"] : []), RUNTIME_CREDENTIAL_CAPABILITY] };
  try {
    const pkg: unknown = JSON.parse(boundedFile(options.packagePath ?? join(directory, "..", "package.json"), 64 * 1024).toString("utf8"));
    if (!pkg || typeof pkg !== "object" || !("name" in pkg) || !["@songsid/agend", "@songsid/agend-runtime"].includes(String(pkg.name)) || !("version" in pkg) || !validRuntimeVersion(pkg.version)) return result;
    result.version = pkg.version;
    try {
      let total = 0;
      const modules = RUNTIME_BUNDLE_MODULES.map(name => {
        const bytes = boundedFile(join(directory, name), Math.min(1024 * 1024, 8 * 1024 * 1024 - total)); total += bytes.length;
        return [name, bytes] as const;
      });
      result.buildId = runtimeCodeBuildId(result.version, modules);
    } catch { /* The version is readable, but an incomplete build has no fingerprint. */ }
  } catch { /* Unreadable or invalid metadata must not prevent a legacy-compatible connection. */ }
  return result;
}
