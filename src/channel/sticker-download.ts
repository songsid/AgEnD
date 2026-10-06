/**
 * A bounded download of one sticker picture (#1226), shared by the adapters' `fetchStickerPreview`.
 *
 * The URL is built by the adapter from a sticker the platform listed — never from caller text — and on Telegram it
 * holds the bot token, so it appears in no error message: callers see "HTTP 404", "not an image", "too large".
 */
import type { StickerPreview } from "./types.js";

export const STICKER_PREVIEW_MAX_BYTES = 512 * 1024;

const EXT_BY_TYPE: Record<string, StickerPreview["ext"]> = {
  "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/jpeg": "jpg",
};

export async function downloadStickerImage(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch; fallbackExt?: StickerPreview["ext"] } = {},
): Promise<StickerPreview> {
  const maxBytes = opts.maxBytes ?? STICKER_PREVIEW_MAX_BYTES;
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000), redirect: "error" });
  } catch (err) {
    // The error of a failed fetch can quote the URL; say what happened, not where.
    throw new Error(`download failed (${(err as Error)?.name ?? "error"})`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  // Telegram's file server answers application/octet-stream; the adapter then says what the file is.
  const ext = EXT_BY_TYPE[type] ?? (type === "application/octet-stream" ? opts.fallbackExt : undefined);
  if (!ext) throw new Error("not an image");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new Error("image too large"); }
    chunks.push(value);
  }
  if (size === 0) throw new Error("empty response");
  return { bytes: Buffer.concat(chunks), ext };
}
