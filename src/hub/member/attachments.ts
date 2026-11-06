/**
 * Member side of Hub attachments (attachments-v1, #3226 D):
 * - a question's files are pulled chunk by chunk and written into the representative agent's inbox, then named in the
 *   question text exactly as fleet chat uploads are (`[📎 File: NAME → PATH]`, `[📷 Image: PATH]`);
 * - an answer's files are the agent's own paths, copied under the reply tool's rule (snapshotReplyFile: no symlink,
 *   nothing under the AgEnD state dir but inbox/, a regular file within the limit), then typed by name and magic bytes
 *   and pushed before the answer that names them.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { constants } from "node:fs";
import { HUB_ATTACHMENT_CHUNK, attachmentName } from "../protocol.js";
import { HubProtocolError } from "../validation.js";
import type { HubAttachmentChunk, HubAttachmentRef } from "../types.js";
import { attachmentLimits, classifyAttachment, isInlineImage } from "../attachments/limits.js";
import { snapshotReplyFile } from "../../web-reply-files.js";

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
export interface HubMemberFilesOptions {
  /** The AgEnD state dir (the reply tool's rule) and an agent's inbox / scratch folder under it. */
  stateDir: string;
  inboxDir(agent: string): string | null;
  scratchDir(agent: string): string | null;
}
export type HubFileFetch = (id: string, offset: number) => Promise<HubAttachmentChunk>;
export type HubFilePut = (chunk: HubAttachmentChunk) => Promise<void>;

export class HubMemberFiles {
  private readonly limits = attachmentLimits();
  constructor(private readonly options: HubMemberFilesOptions) {}

  /** Pull each file whole, check its size and SHA-256, write it into the agent's inbox; returns the lines for the text. */
  async receive(agent: string, messageId: string, files: readonly HubAttachmentRef[], fetch: HubFileFetch): Promise<string[]> {
    const inbox = this.options.inboxDir(agent);
    if (!inbox || files.length > this.limits.files || files.reduce((n, f) => n + f.size, 0) > this.limits.messageBytes) throw new HubProtocolError("invalid");
    await mkdir(inbox, { recursive: true, mode: 0o700 });
    const lines: string[] = [];
    for (const [i, f] of files.entries()) {
      if (f.size > this.limits.fileBytes || !attachmentName.safeParse(f.name).success) throw new HubProtocolError("invalid");
      const parts: Buffer[] = []; let got = 0;
      while (got < f.size) {
        const c = await fetch(f.id, got);
        const data = Buffer.from(c.data, "base64");
        if (c.id !== f.id || c.offset !== got || c.total !== f.size || c.sha256 !== f.sha256 || data.length === 0 || data.length > HUB_ATTACHMENT_CHUNK || got + data.length > f.size) throw new HubProtocolError("invalid");
        parts.push(data); got += data.length;
      }
      const bytes = Buffer.concat(parts);
      if (sha(bytes) !== f.sha256) throw new HubProtocolError("invalid");
      const kind = classifyAttachment(f.name, bytes.subarray(0, 64));
      if ("refused" in kind || kind.mime !== f.mime) throw new HubProtocolError("invalid");
      // One file per message and position: a retried hand-off rewrites the same name, never piles up copies.
      const path = join(inbox, `hub-${messageId.slice(0, 8)}-${i + 1}-${f.name}`);
      const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await fh.writeFile(bytes); } finally { await fh.close(); }
      lines.push(isInlineImage(f.mime) ? `[📷 Image: ${path}]` : `[📎 File: ${f.name} → ${path}]`);
    }
    return lines;
  }

  /** The agent's files for its answer, copied and typed; refused as a whole with a reason the agent can act on. */
  async prepare(agent: string, paths: readonly string[]): Promise<{ ref: HubAttachmentRef; bytes: Buffer }[]> {
    if (paths.length > this.limits.files) throw new HubFileRefusal(`at most ${this.limits.files} files`);
    const scratch = this.options.scratchDir(agent);
    if (!scratch) throw new HubFileRefusal("this agent cannot send files");
    const out: { ref: HubAttachmentRef; bytes: Buffer }[] = [];
    for (const path of paths) {
      const id = randomBytes(16).toString("hex");
      const copy = await snapshotReplyFile(path, scratch, id, { stateDir: this.options.stateDir, maxFileBytes: this.limits.fileBytes, maxDirBytes: this.limits.messageBytes * 2 });
      if (!copy.ok) throw new HubFileRefusal(`${basename(path)}: ${copy.reason}`);
      let bytes: Buffer;
      try { bytes = await readFile(copy.path); } finally { await rm(copy.path, { force: true }); }
      const name = basename(path);
      if (!attachmentName.safeParse(name).success) throw new HubFileRefusal(`${name}: not a plain file name`);
      const kind = classifyAttachment(name, bytes.subarray(0, 64));
      if ("refused" in kind) throw new HubFileRefusal(`${name}: ${kind.refused === "type-not-allowed" ? "this type is not allowed (PNG, JPEG, GIF, WebP, PDF, txt, md, csv, json, docx, xlsx, pptx, html)" : kind.refused === "image-mismatch" ? "not the image its name says" : "empty"}`);
      out.push({ ref: { id: randomUUID(), name, size: bytes.length, mime: kind.mime, sha256: sha(bytes) }, bytes });
    }
    if (out.reduce((n, f) => n + f.bytes.length, 0) > this.limits.messageBytes) throw new HubFileRefusal(`more than ${this.limits.messageBytes / 1024 / 1024} MB together`);
    return out;
  }

  /** Push one prepared file in order, one chunk in flight. */
  async send(file: { ref: HubAttachmentRef; bytes: Buffer }, put: HubFilePut): Promise<void> {
    for (let offset = 0; offset < file.bytes.length; offset += HUB_ATTACHMENT_CHUNK) {
      await put({ id: file.ref.id, offset, total: file.ref.size, sha256: file.ref.sha256, data: file.bytes.subarray(offset, offset + HUB_ATTACHMENT_CHUNK).toString("base64") });
    }
  }
}
/** A refusal the agent sees as its report_result error (a fixable request, not a link failure). */
export class HubFileRefusal extends Error {}
