/**
 * #named-link-ttl: who `web.public_link.auto_open` reopens the link for — the admin (and the General) who last opened a
 * named-tunnel link from /web. Recorded on a confirmed private delivery; forgotten when someone closes the link on
 * purpose (Close, /web revoke), so a restart never undoes a deliberate close. It names a chat account and a General,
 * nothing more: no token, URL or code. Whether that account may still own a link is the fleet's to decide at each use.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export const PUBLIC_LINK_OWNER_FILE = "public-link-owner.json";

export interface RememberedPublicLinkOwner {
  readonly adapterId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly threadId?: string;
}

const field = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v);

export function readPublicLinkOwner(dataDir: string): RememberedPublicLinkOwner | null {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(dataDir, PUBLIC_LINK_OWNER_FILE), "utf-8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (!field(o.adapterId) || !field(o.userId) || !field(o.chatId) || (o.threadId !== undefined && !field(o.threadId))) return null;
  return { adapterId: o.adapterId, userId: o.userId, chatId: o.chatId, ...(o.threadId !== undefined ? { threadId: o.threadId as string } : {}) };
}

export function writePublicLinkOwner(dataDir: string, owner: RememberedPublicLinkOwner): void {
  const record = { adapterId: owner.adapterId, userId: owner.userId, chatId: owner.chatId, ...(owner.threadId !== undefined ? { threadId: owner.threadId } : {}) };
  if (!field(record.adapterId) || !field(record.userId) || !field(record.chatId) || (record.threadId !== undefined && !field(record.threadId))) return;
  atomicWriteFileSync(join(dataDir, PUBLIC_LINK_OWNER_FILE), JSON.stringify(record) + "\n", { mode: 0o600 });
}

export function clearPublicLinkOwner(dataDir: string): void {
  rmSync(join(dataDir, PUBLIC_LINK_OWNER_FILE), { force: true });
}
