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
