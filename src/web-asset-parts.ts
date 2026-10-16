/**
 * #1629 r4 §1: a picture larger than one message carries (the fleet IPC's 1 MiB line, the agent endpoint's 512 KiB
 * body) goes up in parts — a card portrait may be 1.5 MiB by default and up to 4 MiB by configuration. Both doors use
 * this: the daemon (set_web_theme_asset, after reading the file on the agent's side) and `agend-agent theme asset`.
 *
 * Protocol (args of set_web_theme_asset, in order, each answered before the next is sent):
 *   part 0:   { slot, data_b64, part: { index: 0, count, bytes, sha256 } }   → { upload: <id> }   (or { id } when count is 1)
 *   part k:   { slot, data_b64, part: { index: k, count, bytes, sha256, upload } }
 *   last:     → { id }  (the asset), or an error
 * The fleet keeps one upload per instance and drops it after a minute without a part (web-appearance.ts).
 */
import { createHash } from "node:crypto";
import { writeAgentFile } from "./agent-file-read.js";

/** Every picture slot an agent uploads for (the theme's two and the card's two). Here so agend-agent stays small. */
export const THEME_ASSET_SLOTS = ["background", "avatar", "portrait", "banner"] as const;
export type ThemeAssetSlot = typeof THEME_ASSET_SLOTS[number];

/** Raw bytes per part: base64 of this (480 KiB) plus the envelope fits both the IPC line and the endpoint body. */
export const ASSET_PART_BYTES = 360 * 1024;
/** The most an upload may declare: the largest card slot's ceiling (web-appearance-limits.ts). */
export const ASSET_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

export interface AssetPart { index: number; count: number; bytes: number; sha256: string; upload?: string }

/**
 * Send `bytes` for `slot` through `send` (one tool call each), in parts when it does not fit one. Returns the last
 * answer: { id } on success, or the first error any part got.
 */
export async function sendAssetInParts(
  slot: unknown,
  bytes: Uint8Array,
  send: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  if (bytes.length <= ASSET_PART_BYTES) return send({ slot, data_b64: Buffer.from(bytes).toString("base64") });
  const count = Math.ceil(bytes.length / ASSET_PART_BYTES);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let upload: string | undefined;
  let answer: Record<string, unknown> = {};
  for (let index = 0; index < count; index++) {
    const chunk = bytes.subarray(index * ASSET_PART_BYTES, (index + 1) * ASSET_PART_BYTES);
    const part: AssetPart = { index, count, bytes: bytes.length, sha256, ...(upload ? { upload } : {}) };
    answer = await send({ slot, data_b64: Buffer.from(chunk).toString("base64"), part });
    if (typeof answer.error === "string" || Array.isArray(answer.errors)) return answer;
    if (index === 0) {
      if (typeof answer.upload !== "string") return { error: "upload", message: "The fleet did not start the upload." };
      upload = answer.upload;
    }
  }
  return answer;
}

/** Every file a preview may carry: an SVG per mode, and the pictures it names (web-appearance-view.ts PREVIEW_FILE). */
export const PREVIEW_FILE = /^(?:(?:light|dark)\.svg|(?:avatar|portrait|banner|background)\.(?:png|jpg|webp|gif))$/;
/** The most parts one preview file may come in (its largest picture, a 4 MiB portrait, is 12). */
export const PREVIEW_MAX_PARTS = 64;
/**
 * #1629 r4 §1: preview_web_appearance's answer on the agent's side (the daemon, agend-agent): its files — an SVG per
 * mode and the pictures they name — whole, or (larger than one message) fetched part by part with
 * `send({ part: { preview, name, index } })`, each checked against the declared bytes and sha256. Returns the files,
 * or the first error. Only the names above are taken.
 */
export async function receivePreview(
  first: Record<string, unknown>,
  send: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<{ files: Array<{ name: string; data: Buffer }> } | { error: string; message?: string }> {
  return receiveFiles(first, send, { name: PREVIEW_FILE, idKey: "preview", what: "preview" });
}

/**
 * Files the fleet built for the agent's side (a preview, an exported mod): sent whole, or — when larger than one
 * message — fetched here part by part with `{ part: { <idKey>: id, name, index } }`, each file checked against its
 * declared bytes and sha256. `name`: the only file names accepted (nothing else is ever written).
 */
export async function receiveFiles(
  first: Record<string, unknown>,
  send: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  opts: { name: RegExp; idKey: string; what: string; maxParts?: number },
): Promise<{ files: Array<{ name: string; data: Buffer }> } | { error: string; message?: string }> {
  const { what } = opts;
  const maxParts = opts.maxParts ?? PREVIEW_MAX_PARTS;
  if (typeof first.error === "string") return first as { error: string };
  const files = Array.isArray(first.files) ? first.files as Array<Record<string, unknown>> : [];
  if (!files.length || !files.every(f => typeof f.name === "string" && opts.name.test(f.name)) || new Set(files.map(f => f.name)).size !== files.length) {
    return { error: what, message: `The fleet sent no ${what}.` };
  }
  const id = first[opts.idKey];
  if (typeof id !== "string") {
    if (!files.every(f => typeof f.data_b64 === "string")) return { error: what, message: `The fleet sent no ${what}.` };
    return { files: files.map(f => ({ name: f.name as string, data: Buffer.from(f.data_b64 as string, "base64") })) };
  }
  const out: Array<{ name: string; data: Buffer }> = [];
  for (const f of files) {
    const bytes = f.bytes, count = f.parts;
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > maxParts || typeof f.sha256 !== "string") return { error: what, message: `The fleet sent an unreadable ${what}.` };
    const chunks: Buffer[] = [];
    for (let index = 0; index < (count as number); index++) {
      const a = await send({ part: { [opts.idKey]: id, name: f.name, index } });
      if (typeof a.error === "string") return a as { error: string };
      if (typeof a.data_b64 !== "string") return { error: what, message: `A part of the ${what} is missing.` };
      chunks.push(Buffer.from(a.data_b64, "base64"));
    }
    const data = Buffer.concat(chunks);
    if (data.length !== bytes || createHash("sha256").update(data).digest("hex") !== f.sha256) return { error: what, message: `The ${what}'s parts do not add up.` };
    out.push({ name: f.name as string, data });
  }
  return { files: out };
}

/** #1629 r4-5b: the one file name an exported mod is written under (in `.agend/mods/`). */
export const MOD_FILE = /^[a-z0-9][a-z0-9-]{0,63}-(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.agendmod\.json$/;
/** An exported mod is at most 8 MiB: 24 parts of 360 KiB. */
export const MOD_MAX_PARTS = 24;
/** The largest mod the agent's side reads to propose (the fleet checks it again): 8 MiB. */
export const MOD_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

/** Write a received mod into `.agend/mods/` of the working directory (on the agent's side), and say where. */
export async function writeModFile(files: Array<{ name: string; data: Buffer }>, opts: { workspace: string | undefined; stateDir: string }): Promise<{ path: string; bytes: number } | { error: string }> {
  const f = files.length === 1 ? files[0]! : null;
  if (!f || !MOD_FILE.test(f.name)) return { error: ".agend/mods — not one mod file" };
  const w = await writeAgentFile(".agend/mods", f.name, f.data, opts);
  return w.ok ? { path: w.path, bytes: f.data.length } : { error: `.agend/mods/${f.name} — ${w.reason}` };
}

/**
 * Write a received preview into `.agend/appearance/` of the working directory (on the agent's side), and say where:
 * the SVG per mode, and the pictures they name (Read those as images).
 */
export async function writePreview(files: Array<{ name: string; data: Buffer }>, opts: { workspace: string | undefined; stateDir: string }):
  Promise<{ files: Array<{ mode: string; path: string }>; pictures: Array<{ role: string; path: string }> } | { error: string }> {
  const out = { files: [] as Array<{ mode: string; path: string }>, pictures: [] as Array<{ role: string; path: string }> };
  for (const f of files) {
    if (!PREVIEW_FILE.test(f.name)) return { error: `.agend/appearance/${f.name.slice(0, 40)} — not a preview file` };
    const w = await writeAgentFile(".agend/appearance", f.name, f.data, opts);
    if (!w.ok) return { error: `.agend/appearance/${f.name} — ${w.reason}` };
    const [base] = f.name.split(".");
    if (f.name.endsWith(".svg")) out.files.push({ mode: base!, path: w.path }); else out.pictures.push({ role: base!, path: w.path });
  }
  return out;
}
