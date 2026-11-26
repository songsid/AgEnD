/**
 * M-3770 slice 2.3 (design update-transaction §5.3): the snapshot's manifest — its types, its reader, and the exact-set
 * verification of a snapshot tree against it. Node built-ins only (no SQLite), so the recovery kit's bundle can restore
 * from a snapshot (§6.1).
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export const SNAPSHOT_DIR = "snapshot";
export const SNAPSHOT_MANIFEST = "snapshot.json";

export type EntryType = "file" | "dir" | "link";
export interface ManifestEntry { rel: string; type: EntryType; mode: number; size?: number; sha256?: string; target?: string; mtimeMs?: number }
export interface DatabaseRecord { rel: string; userVersion: number; schemaSha256: string }
export interface SnapshotManifest { schema: 1; home: string; entries: ManifestEntry[]; databases: DatabaseRecord[] }

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The manifest as written, or null when it can't be read or isn't one. */
export function readManifest(attemptDir: string): SnapshotManifest | null {
  try {
    const m = JSON.parse(readFileSync(join(attemptDir, SNAPSHOT_MANIFEST), "utf8")) as SnapshotManifest;
    return m && m.schema === 1 && Array.isArray(m.entries) && Array.isArray(m.databases) ? m : null;
  } catch { return null; }
}

/** §5.3: the snapshot tree against its manifest, as an exact set — no extra entry, none missing, same types, hashes and targets. */
export function verifySnapshot(attemptDir: string, manifest: SnapshotManifest): { ok: true } | { ok: false; reason: string } {
  const out = join(attemptDir, SNAPSHOT_DIR);
  const seen = new Map<string, ManifestEntry>();
  const visit = (rel: string) => {
    for (const name of readdirSync(rel ? join(out, rel) : out).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(out, r));
      if (st.isSymbolicLink()) seen.set(r, { rel: r, type: "link", mode: 0, target: readlinkSync(join(out, r)) });
      else if (st.isDirectory()) { seen.set(r, { rel: r, type: "dir", mode: st.mode & 0o7777 }); visit(r); }
      else if (st.isFile()) seen.set(r, { rel: r, type: "file", mode: st.mode & 0o7777, size: st.size, sha256: sha256File(join(out, r)) });
      else seen.set(r, { rel: r, type: "file", mode: -1 });
    }
  };
  try { visit(""); } catch (err) { return { ok: false, reason: `the snapshot can't be read (${(err as Error).message})` }; }
  if (seen.size !== manifest.entries.length) return { ok: false, reason: `the snapshot holds ${seen.size} entries, its manifest ${manifest.entries.length}` };
  for (const e of manifest.entries) {
    const s = seen.get(e.rel);
    if (!s) return { ok: false, reason: `${e.rel} is missing from the snapshot` };
    if (s.type !== e.type) return { ok: false, reason: `${e.rel} is a ${s.type}, not a ${e.type}` };
    if (e.type === "link" && s.target !== e.target) return { ok: false, reason: `${e.rel} points elsewhere` };
    if (e.type === "file" && (s.sha256 !== e.sha256 || s.size !== e.size || s.mode !== e.mode)) return { ok: false, reason: `${e.rel} differs from its manifest` };
    if (e.type === "dir" && s.mode !== e.mode) return { ok: false, reason: `${e.rel}'s mode differs from its manifest` };
  }
  return { ok: true };
}
