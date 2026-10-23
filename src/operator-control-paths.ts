import { ensureAgendHome } from "./agend-home.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

/** Shared filesystem boundary for independent, same-user operator sockets. */
export function operatorUid(label: string): number {
  if (!process.getuid) throw new Error(`Local ${label} control requires Unix user permissions.`);
  return process.getuid();
}
export async function assertOperatorRoot(dataDir: string, label: string): Promise<void> {
  operatorUid(label);
  ensureAgendHome(dataDir, { create: false, label });
}
export async function assertOperatorClientPath(dataDir: string, socketPath: string, label: string): Promise<void> {
  await assertOperatorRoot(dataDir, label);
  const directory = await lstat(join(dataDir, "operator"));
  const socket = await lstat(socketPath);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== operatorUid(label) || (directory.mode & 0o077)
    || !socket.isSocket() || socket.uid !== operatorUid(label) || (socket.mode & 0o077)) {
    throw new Error(`${label} is not a private socket owned by this user.`);
  }
}
