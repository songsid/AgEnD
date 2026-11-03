import { randomBytes } from "node:crypto";

/**
 * #2959: the local name of a downloaded attachment in the shared inbox — `<ms>-<random>-<id tail>-<name>`.
 *
 * The inbox is shared by every bot on the host. Two bots downloading the same attachment in the same millisecond used
 * to get the same `<ms>-<id tail>-<name>`: one write replaced the other, and a ClassicBot's copy-then-unlink
 * (saveClassicAttachment) took the file from under the second, which logged "Attachment copy failed — skipping" and
 * dropped the picture. Eight random hex characters make every download its own file.
 */
export function inboxTempName(fileId: string, name: string, random: (n: number) => Buffer = randomBytes): string {
  return `${Date.now()}-${random(4).toString("hex")}-${fileId.slice(-8)}-${name}`;
}
