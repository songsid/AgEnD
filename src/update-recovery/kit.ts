/**
 * M-3770 slice 2.1c (design update-transaction §6.1): the recovery kit, written by the updater before the install
 * (still in `snapshotted`) at `<home>/.update-journal/recovery/<attemptId>/`:
 * - `node`: a copy of the Node binary the old version runs on (its realpath), proven to run alone (`node -e 1` from the
 *   kit's own path). A kit that can't run alone abandons the attempt before the install.
 * - `recover.cjs`: the one-file bundle (dist/recover.cjs), node built-ins only, never the package being replaced.
 * - `kit.json`: both files' sha256, the bundle's version, the attempt id and the home.
 * Each file is written to a fresh tmp name, fsynced, and renamed into place; the directory is fsynced after each.
 */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { defaultJournalIo, journalDir, mkdirDurable, type JournalIo } from "../update-journal.js";
import { kitDir } from "./pre-start.js";

export const KIT_FILE = "kit.json";
export interface KitManifest {
  schema: 1;
  attemptId: string;
  home: string;
  node: { source: string; sha256: string };
  recover: { sha256: string };
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function writeDurable(io: JournalIo, path: string, data: Buffer, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const fd = openSync(tmp, "wx", mode);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  io.fsyncDir(join(path, ".."));
}

export interface KitSources {
  /** The Node the old version runs on (followed to its realpath). */
  nodePath: string;
  /** The bundle to copy (dist/recover.cjs of the RUNNING, old install). */
  bundlePath: string;
  /** Does `<kit>/node` run alone? Default: `node -e 1` with an empty environment, 10 s. */
  runsAlone?(kitNode: string): boolean;
}

export type KitResult = { ok: true; dir: string; manifest: KitManifest } | { ok: false; reason: string };

const runsAloneDefault = (kitNode: string): boolean => {
  const r = spawnSync(kitNode, ["-e", "1"], { env: {}, stdio: "ignore", timeout: 10_000 });
  return r.status === 0 && r.signal === null;
};

/** §6.1: build the kit for an attempt. Its directory must be new; a failure leaves no manifest (the kit isn't valid). */
export function buildRecoveryKit(home: string, attemptId: string, src: KitSources, io: JournalIo = defaultJournalIo): KitResult {
  let nodeReal: string, nodeBytes: Buffer, bundle: Buffer;
  try { nodeReal = realpathSync(src.nodePath); nodeBytes = readFileSync(nodeReal); }
  catch (err) { return { ok: false, reason: `the Node ${src.nodePath} can't be read (${(err as Error).message})` }; }
  try { bundle = readFileSync(src.bundlePath); }
  catch (err) { return { ok: false, reason: `the recovery bundle ${src.bundlePath} can't be read (${(err as Error).message})` }; }
  const dir = kitDir(home, attemptId);
  try {
    mkdirDurable(io, home, dir, true);
    writeDurable(io, join(dir, "node"), nodeBytes, 0o700);
    writeDurable(io, join(dir, "recover.cjs"), bundle, 0o600);
  } catch (err) { return { ok: false, reason: `the recovery kit ${dir} can't be written (${(err as Error).message})` }; }
  if (!(src.runsAlone ?? runsAloneDefault)(join(dir, "node"))) return { ok: false, reason: `the kit's Node (a copy of ${nodeReal}) doesn't run alone; it needs files outside itself` };
  const manifest: KitManifest = { schema: 1, attemptId, home, node: { source: nodeReal, sha256: sha256(nodeBytes) }, recover: { sha256: sha256(bundle) } };
  try { writeDurable(io, join(dir, KIT_FILE), Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), 0o600); }
  catch (err) { return { ok: false, reason: `the kit's manifest can't be written (${(err as Error).message})` }; }
  return { ok: true, dir, manifest };
}

/** The kit as written: its manifest names this attempt and home, and both files hash to it. */
export function verifyRecoveryKit(home: string, attemptId: string): KitResult {
  const dir = kitDir(home, attemptId);
  let manifest: KitManifest;
  try { manifest = JSON.parse(readFileSync(join(dir, KIT_FILE), "utf8")) as KitManifest; }
  catch (err) { return { ok: false, reason: `the kit's manifest can't be read (${(err as Error).message})` }; }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return { ok: false, reason: "the kit's manifest isn't an object" };
  if (manifest.schema !== 1 || manifest.attemptId !== attemptId || manifest.home !== home) return { ok: false, reason: "the kit's manifest names another attempt or home" };
  for (const [file, want] of [["node", manifest.node?.sha256], ["recover.cjs", manifest.recover?.sha256]] as const) {
    let got: string;
    try { got = sha256(readFileSync(join(dir, file))); } catch (err) { return { ok: false, reason: `the kit's ${file} can't be read (${(err as Error).message})` }; }
    if (got !== want) return { ok: false, reason: `the kit's ${file} doesn't match its manifest` };
  }
  return { ok: true, dir, manifest };
}

export const recoveryRoot = (home: string) => join(journalDir(home), "recovery");
