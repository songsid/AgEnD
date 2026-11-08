/** Shared private server layout. Importing this module never opens, creates or migrates state. */
import { closeSync, openSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { HubStateError, type HubStateSet } from "../db.js";
import { ensurePrivateDirectory, readPrivateFile } from "../private-files.js";

export const SERVER_SET: HubStateSet = Object.freeze({
  database: "hub/hub.sqlite",
  floors: Object.freeze(["hub/floors/transport"]),
  keys: Object.freeze(["hub/keys/content.key"]),
});

/** Create a private file with random bytes, exclusively (never overwrite). */
export function createKeyFile(home: string, rel: string): void {
  ensurePrivateDirectory(home, rel.slice(0, rel.lastIndexOf("/")));
  const fd = openSync(`${home}/${rel}`, "wx", 0o600);
  try { writeSync(fd, randomBytes(32).toString("base64")); } finally { closeSync(fd); }
}

export function readKeyFile(home: string, rel: string): Buffer {
  const key = Buffer.from(readPrivateFile(home, rel, 256).trim(), "base64");
  if (key.length !== 32) throw new HubStateError("hub-storage", `${rel} is not a 32-byte key`);
  return key;
}
