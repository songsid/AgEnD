/** First setup has no mounted Hub DB yet. This private, fsynced journal precedes enabling and is imported at mount. */
import { randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, fsyncSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectory, privatePath, readPrivateFile } from "../private-files.js";
import { z } from "zod";
import { epoch, identifier, uuid, validated, parseStrictJson } from "../validation.js";
export const WEB_INIT_AUDIT = "hub/init/web-events.jsonl";
export const webInitEventSchema = z.strictObject({ v: z.literal(1), id: uuid, at: epoch, requestId: identifier, sessionId: identifier, authorityEpoch: epoch,
  operation: z.enum(["prepare", "test", "commit", "ca-inspect", "ca-fetch", "cancel"]), result: z.enum(["held", "completed", "denied"]),
  reason: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), operationId: z.string().regex(/^[a-f0-9]{16}$/).optional(), hubId: identifier.optional(),
  confirmationId: z.string().regex(/^[a-f0-9]{32}$/).optional() });
export type HubWebInitEvent = z.infer<typeof webInitEventSchema>;
export function appendHubWebInitEvent(home: string, input: Omit<HubWebInitEvent, "v" | "id">): void {
  const event = validated(webInitEventSchema, { v: 1, id: randomUUID(), ...input });
  ensurePrivateDirectory(home, "hub/init");
  privatePath(home, "hub/init", true);
  const fd = openSync(join(home, WEB_INIT_AUDIT), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || typeof process.getuid === "function" && st.uid !== process.getuid() || st.size > 4 * 1024 * 1024)
      throw Error("setup-audit-unavailable");
    writeSync(fd, JSON.stringify(event) + "\n");
    fsyncSync(fd);
  }
  finally {
    closeSync(fd);
  }
  const dir = openSync(join(home, "hub/init"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(dir);
  }
  finally {
    closeSync(dir);
  }
}
export function readHubWebInitEvents(home: string): HubWebInitEvent[] {
  const body = readPrivateFile(home, WEB_INIT_AUDIT, 4 * 1024 * 1024);
  if (!body.endsWith("\n"))
    throw Error("setup-audit-unavailable");
  return body.split("\n").filter(Boolean).map(line => validated(webInitEventSchema, parseStrictJson(line)));
}
