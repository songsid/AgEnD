import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelOption } from "./types.js";

const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_ID_LENGTH = 160;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1000;
const GROK_MODEL_ID = /^grok[A-Za-z0-9._:/-]*$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit: number): string | undefined => typeof value === "string" ? value.trim().slice(0, limit) || undefined : undefined;

/**
 * Grok owns this cache's freshness. It also stores credentials in it: return only
 * the model-map key and explicitly selected display metadata, never whole entries.
 * No CLI, network request or file write is needed to read these choices.
 */
export function readGrokModelCache(home = process.env.GROK_HOME?.trim() || join(homedir(), ".grok")): ModelOption[] {
  let fd: number | undefined;
  try {
    // Nonblocking avoids waiting on a FIFO before fstat can reject it. Do not follow
    // a symlink on platforms offering O_NOFOLLOW; the opened file must be regular.
    fd = openSync(join(home, "models_cache.json"), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CACHE_BYTES) return [];

    // The file can grow after fstat. One extra byte distinguishes an exact-cap file
    // from an oversized one without allocating or reading an unbounded snapshot.
    const bytes = Buffer.alloc(MAX_CACHE_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used > MAX_CACHE_BYTES) return [];
    const cache: unknown = JSON.parse(bytes.subarray(0, used).toString("utf8"));
    if (!record(cache) || !record(cache.models)) return [];

    const models: ModelOption[] = [];
    for (const [id, entry] of Object.entries(cache.models)) {
      if (id.length > MAX_ID_LENGTH || !GROK_MODEL_ID.test(id)) continue;
      const info = record(entry) && record(entry.info) ? entry.info : null;
      if (info?.hidden === true) continue;
      const description = text(info?.description, MAX_DESCRIPTION_LENGTH);
      models.push({ id, label: text(info?.name, MAX_NAME_LENGTH) ?? id, ...(description ? { description } : {}) });
    }
    return models;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* A cache read never escapes as an error. */ }
    }
  }
}
