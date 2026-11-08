/** Flush the file and every private ancestor through home before trust, remote push or ACK. Retry repeats required flushes. */
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "../../atomic-write.js";
import { ensurePrivateDirectory, privatePath } from "../private-files.js";

export function syncJoinPrivate(home: string, suffix: string): void {
  const path = privatePath(home, suffix), file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(file); } finally { closeSync(file); }
  for (let directory = dirname(suffix); ; directory = dirname(directory)) {
    const parent = openSync(privatePath(home, directory, true), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    if (directory === ".") break;
  }
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
