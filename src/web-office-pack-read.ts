/**
 * #2692: a skin pack an agent hands to office_pack_check / office_pack_upload, read on the agent's side (the daemon, or
 * `agend-agent office pack-…`) — the fleet receives bytes, never a path (as set_web_theme_asset and upload_web_effect).
 *
 * A pack is a folder (`dir`: its manifest.json and the pictures the manifest names, at those paths) or a manifest with
 * each picture's path (`manifest` + `files`); `packs: [...]` carries several as one batch. Every path is resolved with
 * realpath — symlinks followed — and must then be inside the agent's working directory (and not AgEnD state the agent may
 * not read: agentFileScope, as an effect directory) or the fleet's shared folder (<AgEnD home>/shared). Only manifest.json
 * and the files the manifest names (packImages) are read, each a regular file within the pack's caps (SKIN_LIMITS);
 * nothing is written. The manifest is checked here only to know which files to read: the fleet checks everything again.
 *
 * The wire: the batch as one JSON document — { packs: [{ manifest, name?, files: { <src>: <base64> } }] } — sent in parts
 * of ASSET_PART_BYTES (each fits the fleet IPC's line and the agent endpoint's body), each answered before the next:
 *   { data_b64, part: { index, count, bytes, sha256, upload? }, drop_invalid_overrides? }   (options on part 0 only)
 * The fleet keeps one unfinished batch per instance and tool (OfficePackUploads, web-office-pack-tools.ts).
 */
import { constants as fsConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { agentFileScope, type AgentFileContext } from "./agent-file-read.js";
import { checkSkinPack, packImages } from "./ui/fleet-office-pack.js";
import { SKIN_LIMITS, skinFileNameOk } from "./web-office-skins.js";
import { ASSET_PART_BYTES } from "./web-asset-parts.js";

const MiB = 1024 * 1024;
/** One batch: at most 16 packs and 100 MiB of pictures (the hourly budget, OFFICE_PACK_TOOL_LIMITS, is 200 MiB). */
export const PACK_BATCH_LIMITS = { packs: SKIN_LIMITS.packs, bytes: 100 * MiB } as const;
/** The most a batch's wire document may be: its pictures as base64, plus each manifest and room for the envelope. */
export const PACK_BATCH_WIRE_BYTES = Math.ceil((PACK_BATCH_LIMITS.bytes * 4) / 3) + PACK_BATCH_LIMITS.packs * (SKIN_LIMITS.manifestBytes + 64 * 1024);

export interface PackSource { manifest: Record<string, unknown>; name?: string; files: Map<string, Buffer> }
export type PackRead = { ok: true; packs: PackSource[]; bytes: number } | { ok: false; reason: string };
export interface PackReadContext extends AgentFileContext { /** The fleet's shared folder; default <stateDir>/shared. */ sharedDir?: string }

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const SOURCE_KEYS = ["dir", "manifest", "files", "name"];

/** A regular file, opened without waiting (O_NONBLOCK, O_NOCTTY), read whole when it is at most `max` bytes. */
async function readBounded(path: string, max: number, label: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> {
  let handle;
  try { handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOCTTY ?? 0)); }
  catch { return { ok: false, reason: `${label}: cannot be read` }; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: `${label}: not a regular file` };
    if (info.size > max) return { ok: false, reason: `${label}: larger than ${max >= MiB ? `${max / MiB} MiB` : `${Math.floor(max / 1024)} KiB`}` };
    const buf = Buffer.alloc(info.size + 1);
    let got = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, got, buf.length - got, got);
      if (!bytesRead) break;
      got += bytesRead;
      if (got > info.size) return { ok: false, reason: `${label}: changed while it was read` };
    }
    return { ok: true, bytes: buf.subarray(0, got) };
  } catch { return { ok: false, reason: `${label}: cannot be read` }; }
  finally { await handle.close().catch(() => {}); }
}

/** The roots a pack may be read from: the working directory (minus AgEnD state it may not read) and the shared folder. */
async function rootsOf(ctx: PackReadContext): Promise<Array<{ root: string; allowed(path: string): boolean }>> {
  const roots: Array<{ root: string; allowed(path: string): boolean }> = [];
  if (ctx.workspace) {
    try {
      const scope = await agentFileScope(ctx);
      roots.push({ root: scope.workspace, allowed: p => !scope.stateBlocked(p) });
    } catch { /* no readable working directory: the shared folder only */ }
  }
  try { roots.push({ root: await realpath(ctx.sharedDir ?? join(ctx.stateDir, "shared")), allowed: () => true }); } catch { /* none */ }
  return roots;
}

/**
 * Read the packs `args` names (office_pack_check / office_pack_upload's dir, manifest + files, or packs: [...]).
 * Returns them, or the first reason one cannot be read (which pack, in a batch).
 */
export async function readPackSources(args: Record<string, unknown>, ctx: PackReadContext): Promise<PackRead> {
  const batch = args.packs !== undefined;
  if (batch && (args.dir !== undefined || args.manifest !== undefined || args.files !== undefined || args.name !== undefined)) {
    return { ok: false, reason: "packs: [...] goes alone (put dir, or manifest + files, inside each)" };
  }
  const items = batch ? args.packs : [Object.fromEntries(SOURCE_KEYS.filter(k => args[k] !== undefined).map(k => [k, args[k]]))];
  if (!Array.isArray(items) || !items.length) return { ok: false, reason: "give dir, or manifest + files, or packs: [...]" };
  if (items.length > PACK_BATCH_LIMITS.packs) return { ok: false, reason: `at most ${PACK_BATCH_LIMITS.packs} packs in one batch` };
  const roots = await rootsOf(ctx);
  if (!roots.length) return { ok: false, reason: "neither your working directory nor the fleet's shared folder can be read" };
  const where = (real: string) => roots.find(r => under(real, r.root) && r.allowed(real));
  /** A path the agent named (relative: to its working directory), resolved and inside an allowed root. */
  const resolveIn = async (p: unknown, label: string): Promise<{ ok: true; real: string; root: string } | { ok: false; reason: string }> => {
    if (typeof p !== "string" || !p.trim() || p.includes("\0")) return { ok: false, reason: `${label}: a path` };
    const named = isAbsolute(p) ? p : resolve(ctx.workspace ?? roots[0]!.root, p);
    let real: string;
    try { real = await realpath(named); } catch { return { ok: false, reason: `${label}: ${p.slice(0, 200)} does not exist` }; }
    const r = where(real);
    return r ? { ok: true, real, root: r.root } : { ok: false, reason: `${label}: ${p.slice(0, 200)} is outside your working directory and the fleet's shared folder` };
  };
  const packs: PackSource[] = [];
  let total = 0;
  for (const [i, item] of items.entries()) {
    const at = batch ? `packs[${i}]` : "pack";
    if (!isObj(item)) return { ok: false, reason: `${at}: an object` };
    const extra = Object.keys(item).find(k => !SOURCE_KEYS.includes(k));
    if (extra !== undefined) return { ok: false, reason: `${at}: unknown key "${extra}"` };
    if (item.name !== undefined && typeof item.name !== "string") return { ok: false, reason: `${at}.name: a string` };
    let manifest: unknown, base: { real: string; root: string } | null = null;
    const paths = new Map<string, string>();
    if (item.dir !== undefined) {
      if (item.manifest !== undefined || item.files !== undefined) return { ok: false, reason: `${at}: dir, or manifest + files — not both` };
      const d = await resolveIn(item.dir, `${at}.dir`);
      if (!d.ok) return d;
      try { if (!(await stat(d.real)).isDirectory()) return { ok: false, reason: `${at}.dir: not a folder` }; } catch { return { ok: false, reason: `${at}.dir: cannot be read` }; }
      base = d;
      let mPath: string;
      try { mPath = await realpath(join(d.real, "manifest.json")); } catch { return { ok: false, reason: `${at}.dir: no manifest.json in it` }; }
      if (!under(mPath, d.root) || !where(mPath)) return { ok: false, reason: `${at}: manifest.json leads outside the allowed folders` };
      const m = await readBounded(mPath, SKIN_LIMITS.manifestBytes, `${at}: manifest.json`);
      if (!m.ok) return m;
      try { manifest = JSON.parse(m.bytes.toString("utf8")); } catch { return { ok: false, reason: `${at}: manifest.json is not JSON` }; }
    } else if (item.manifest !== undefined) {
      if (!isObj(item.files)) return { ok: false, reason: `${at}: with manifest, files: { "<name the manifest uses>": "<path to it>" }` };
      manifest = item.manifest;
      for (const [src, p] of Object.entries(item.files)) paths.set(src, p as string);
    } else return { ok: false, reason: `${at}: give dir, or manifest + files` };
    const checked = checkSkinPack(manifest);
    if (!checked.ok) return { ok: false, reason: `${at}: manifest — ${checked.error}` };
    const named = packImages(checked.pack);
    if (!base) {
      const unused = [...paths.keys()].find(src => !named.includes(src));
      if (unused !== undefined) return { ok: false, reason: `${at}.files: ${unused.slice(0, 200)} — the manifest does not name it` };
    }
    const files = new Map<string, Buffer>();
    let packBytes = 0;
    for (const src of named) {
      if (!skinFileNameOk(src)) return { ok: false, reason: `${at}: ${src.slice(0, 200)} — letters, digits, . _ - and /, no hidden or empty part, ending .png` };
      let real: string;
      if (base) {
        try { real = await realpath(join(base.real, src)); } catch { return { ok: false, reason: `${at}: ${src} — named by the manifest, not in the folder` }; }
        if (!under(real, base.root) || !where(real)) return { ok: false, reason: `${at}: ${src} leads outside the allowed folders` };
      } else {
        if (!paths.has(src)) return { ok: false, reason: `${at}.files: ${src} — named by the manifest, not given` };
        const r = await resolveIn(paths.get(src), `${at}.files.${src}`);
        if (!r.ok) return r;
        real = r.real;
      }
      const f = await readBounded(real, SKIN_LIMITS.fileBytes, `${at}: ${src}`);
      if (!f.ok) return f;
      packBytes += f.bytes.length; total += f.bytes.length;
      if (packBytes > SKIN_LIMITS.packBytes) return { ok: false, reason: `${at}: more than ${SKIN_LIMITS.packBytes / MiB} MiB of pictures` };
      if (total > PACK_BATCH_LIMITS.bytes) return { ok: false, reason: `the batch: more than ${PACK_BATCH_LIMITS.bytes / MiB} MiB of pictures — send fewer packs at once` };
      files.set(src, f.bytes);
    }
    packs.push({ manifest: manifest as Record<string, unknown>, ...(typeof item.name === "string" ? { name: item.name } : {}), files });
  }
  return { ok: true, packs, bytes: total };
}

/** The batch as the wire carries it: { packs: [{ manifest, name?, files: { <src>: <base64> } }] }, or null when too large. */
export function encodePackBatch(packs: readonly PackSource[]): Buffer | null {
  const doc = { packs: packs.map(p => ({ manifest: p.manifest, ...(p.name !== undefined ? { name: p.name } : {}), files: Object.fromEntries([...p.files].map(([k, v]) => [k, v.toString("base64")])) })) };
  const bytes = Buffer.from(JSON.stringify(doc));
  return bytes.length <= PACK_BATCH_WIRE_BYTES ? bytes : null;
}

/** Send an encoded batch in parts (each answered before the next); `options` ride on part 0. Returns the last answer. */
export async function sendPackBatchInParts(bytes: Buffer, options: Record<string, unknown>, send: (args: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const sha256 = createHash("sha256").update(bytes).digest("hex"), count = Math.max(1, Math.ceil(bytes.length / ASSET_PART_BYTES));
  let upload: string | undefined, answer: Record<string, unknown> = {};
  for (let index = 0; index < count; index++) {
    answer = await send({ ...(index === 0 ? options : {}), data_b64: bytes.subarray(index * ASSET_PART_BYTES, (index + 1) * ASSET_PART_BYTES).toString("base64"),
      part: { index, count, bytes: bytes.length, sha256, ...(upload ? { upload } : {}) } });
    if (typeof answer.error === "string") return answer;
    if (index < count - 1) { if (typeof answer.upload !== "string") return { error: "upload", message: "The fleet did not accept the part." }; upload = answer.upload; }
  }
  return answer;
}

/** Read, encode and send: what the daemon and the CLI both do for office_pack_check / office_pack_upload. */
export async function sendPackSources(args: Record<string, unknown>, ctx: PackReadContext, send: (args: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const read = await readPackSources(args, ctx);
  if (!read.ok) return { error: "pack_read", message: read.reason };
  const bytes = encodePackBatch(read.packs);
  if (!bytes) return { error: "pack_read", message: "the batch is too large for one call: send fewer packs at once" };
  return sendPackBatchInParts(bytes, args.drop_invalid_overrides === undefined ? {} : { drop_invalid_overrides: args.drop_invalid_overrides }, send);
}
