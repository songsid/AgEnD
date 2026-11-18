/** Disk-only CLI version metadata. No Fleet lifecycle, subprocess or account probes. */
import { dirname, join } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";

/** "2.30.1" from "kiro-cli 2.30.1 (abc)"; null when there is no version in it. */
export function parseVersion(text: string | null | undefined): string | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? "");
  return m ? `${m[1]}.${m[2]}.${m[3] ?? "0"}` : null;
}

/**
 * AGEND-144: the full release a launcher's own version file names — x.y.z WITH the build a CLI ships after it (Muse's `1.4.14-R7309.1`), so the page can tell an installed
 * `1.4.14-R7012.1` from the audited `1.4.14-R7309.1` (cli-audited.ts `versionOf`). Without a build it is `parseVersion`.
 */
export function parseRelease(text: string | null | undefined): string | null {
  const v = parseVersion(text);
  if (!v) return null;
  const build = /\d+\.\d+(?:\.\d+)?-R(\d{1,9}(?:\.\d{1,6})*)(?!\d)/.exec(text ?? "")?.[1];
  return build ? `${v}-R${build}` : v;
}

/** A backend whose version is read from a file next to its launcher: starting it at all can update it (#2078 review). */
export const STATIC_VERSION_FILES: Readonly<Record<string, (path: string) => string>> = {
  muse: (path) => join(dirname(path), ".muse-version"),
};

/**
 * Grok's installer drops one file, `<grok home>/downloads/grok-<target>` (no version in its name), and the launcher `~/.grok/bin/grok` links to it. The CLI keeps the version that last
 * set up its home in `<grok home>/.metadata_version` (`1.0.77`; observed with grok 1.0.77, written on its first run). That records the installed version only while no newer binary
 * has been put there since: a file older than the binary it sits beside says nothing about it, so it is read only when it is at least as new as the binary (AGEND-223). Reading it starts
 * nothing. Null (unknown) when the binary is not in a grok home's `downloads/`, the file is missing, older than the binary, or not a plain x.y.z.
 */
async function grokInstalledVersion(real: string): Promise<string | null> {
  const downloads = dirname(real);
  if (!downloads.endsWith("/downloads")) return null;
  try {
    const marker = join(dirname(downloads), ".metadata_version");
    const [bin, meta] = await Promise.all([stat(real), stat(marker)]);
    if (meta.mtimeMs < bin.mtimeMs) return null;
    const text = (await readFile(marker, "utf8")).trim();
    return /^\d+\.\d+\.\d+$/.test(text) ? text : null;
  } catch { return null; }
}

/**
 * The version from what is on disk, starting nothing: a launcher's own version file (muse), else a version segment
 * the package.json of the npm package that owns the binary (under node_modules), else a version segment of the real
 * path in a layout we know (claude's `…/versions/2.1.302`, codex's `…/releases/0.162.1-<target>/`), else grok's `.metadata_version` beside its download. Null when none says.
 */
export async function staticBackendVersion(backend: string, path: string): Promise<string | null> {
  const file = STATIC_VERSION_FILES[backend];
  if (file) { try { return parseRelease(await readFile(file(path), "utf8")); } catch { return null; } }
  let real: string;
  try { real = await realpath(path); } catch { return null; }
  const parts = real.split("/");
  if (backend === "grok") { const v = await grokInstalledVersion(real); if (v) return v; }
  // An npm-installed CLI: the package that owns the binary (…/node_modules/<pkg> or …/node_modules/@scope/<pkg>). Read
  // first: an nvm prefix puts Node's own version in the path (…/nvm/versions/node/v22.22.2/…, #2078 review).
  const nm = parts.lastIndexOf("node_modules");
  if (nm >= 0 && parts[nm + 1]) {
    const pkgDir = parts.slice(0, nm + (parts[nm + 1]!.startsWith("@") ? 3 : 2)).join("/");
    try {
      const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as { version?: unknown };
      if (typeof pkg.version === "string") return parseVersion(pkg.version);
    } catch { /* no package.json there */ }
    return null;
  }
  // The versioned layouts we know: claude's …/versions/<v>, codex's …/releases/<v>-<target>/…. Only a segment whose
  // parent is one of those names — never any version-looking directory on the way.
  for (let i = parts.length - 1; i > 0; i--) {
    if ((parts[i - 1] === "versions" || parts[i - 1] === "releases") && /^v?\d+\.\d+\.\d+(?:[-+.][\w.-]*)?$/.test(parts[i]!)) return parseVersion(parts[i]);
  }
  return null;
}

