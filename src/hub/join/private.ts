/** New join journals/keys require parent fsync success before ACK, unlike best-effort legacy writes. */
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "../../atomic-write.js";
import { ensurePrivateDirectory, privatePath } from "../private-files.js";

export function syncJoinPrivate(home: string, suffix: string): void {
  const path = privatePath(home, suffix), file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(file); } finally { closeSync(file); }
  const parent = openSync(privatePath(home, dirname(suffix), true), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function createJoinPrivate(home: string, suffix: string, value: string): void {
  ensurePrivateDirectory(home, dirname(suffix));
  const fd = openSync(join(home, suffix), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  syncJoinPrivate(home, suffix);
}
export function writeJoinPrivate(home: string, suffix: string, value: string, current: () => boolean): void {
  if (!current()) throw Error("Join operation changed");
  const path = privatePath(home, suffix);
  atomicWriteFileSync(path, value, { mode: 0o600, beforeRename: () => { if (!current()) throw Error("Join operation changed"); } });
  syncJoinPrivate(home, suffix);
}
