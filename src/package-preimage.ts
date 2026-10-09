/**
 * #1450 C6: what a failed transition restores. npm rolls a global install back only while its own lifecycle runs; a
 * failure AFTER npm succeeded — the target does not verify, its service cannot be proven or loaded — needs the
 * previous package back. "Reinstall the previous version" is not a rollback: an older package has no install hook to
 * re-provision anything, and a service written for the new one names a Node inside the new package.
 *
 * So before npm runs the updater copies the installed package (with its node_modules, so its bundled runtime) to
 * `<prefix>/.agend-rollback/<version>-<ts>/agend` — the same filesystem, so a restore is a rename — and records where
 * its bin links point. Restoring renames the new tree aside, renames the preimage in, and puts the bin links back.
 * After a successful transition only the newest preimage is kept (for a later repair); older ones are removed.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const ROLLBACK_DIR = ".agend-rollback";
const BINS = ["agend", "agend-agent"];

export interface PackagePreimage {
  /** `<prefix>/.agend-rollback/<version>-<ts>` */
  dir: string;
  version: string;
  /** Where each of `<prefix>/bin/{agend,agend-agent}` pointed (null: it did not exist). */
  links: Record<string, string | null>;
}

export type Taken = { ok: true; preimage: PackagePreimage | null } | { ok: false; reason: string };

/** The installed package under `root` (npm's global node_modules), copied aside — or null when none is installed. */
export function takePackagePreimage(root: string, prefix: string, now: Date): Taken {
  const pkg = join(root, "@songsid", "agend");
  if (!existsSync(join(pkg, "package.json"))) return { ok: true, preimage: null };
  let version: string;
  try { version = String(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version); } catch { return { ok: false, reason: `the installed ${pkg}/package.json cannot be read` }; }
  const dir = join(prefix, ROLLBACK_DIR, `${version}-${now.toISOString().replace(/[:.]/g, "-")}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    cpSync(pkg, join(dir, "agend"), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, reason: `the installed package could not be copied aside for a rollback (${(err as Error).message})` };
  }
  const links: Record<string, string | null> = {};
  for (const bin of BINS) {
    try { links[bin] = lstatSync(join(prefix, "bin", bin)).isSymbolicLink() ? readlinkSync(join(prefix, "bin", bin)) : null; } catch { links[bin] = null; }
  }
  return { ok: true, preimage: { dir, version, links } };
}

/** Put the preimage back in place of whatever npm installed; the replaced tree is removed once the swap is done. */
export function restorePackagePreimage(root: string, prefix: string, p: PackagePreimage): { ok: true } | { ok: false; reason: string } {
  const pkg = join(root, "@songsid", "agend");
  const aside = join(p.dir, "replaced");
  try {
    if (existsSync(pkg)) renameSync(pkg, aside);
    renameSync(join(p.dir, "agend"), pkg);
  } catch (err) {
    return { ok: false, reason: `the previous package could not be put back from ${p.dir} (${(err as Error).message})` };
  }
  for (const bin of BINS) {
    const link = join(prefix, "bin", bin);
    try { unlinkSync(link); } catch { /* absent */ }
    const target = p.links[bin];
    if (target) {
      try { symlinkSync(target, link); } catch (err) { return { ok: false, reason: `${link} could not be restored (${(err as Error).message})` }; }
    }
  }
  rmSync(aside, { recursive: true, force: true });
  rmSync(p.dir, { recursive: true, force: true });
  return { ok: true };
}

/** After a successful transition: keep only `keep` (the newest preimage), remove every other one. */
export function prunePreimages(prefix: string, keep: PackagePreimage | null): void {
  const base = join(prefix, ROLLBACK_DIR);
  let entries: string[] = [];
  try { entries = readdirSync(base); } catch { return; }
  for (const name of entries) {
    if (keep && join(base, name) === keep.dir) continue;
    rmSync(join(base, name), { recursive: true, force: true });
  }
}
