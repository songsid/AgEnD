import { unlinkSync } from "node:fs";
import { transcribe } from "../stt.js";
import type { InboundMessage, ChannelAdapter } from "./types.js";

export interface AttachmentResult {
  text: string;
  extraMeta: Record<string, string>;
}

/**
 * Process attachments on an inbound message:
 * - Auto-download photos → extraMeta.image_path
 * - Transcribe voice/audio via Groq Whisper → prepend to text
 * - Pass other attachment types as file_id for manual download
 */
export async function processAttachments(
  msg: InboundMessage,
  adapter: ChannelAdapter,
  logger: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void },
  logPrefix?: string,
): Promise<AttachmentResult> {
  let text = msg.text;
  const extraMeta: Record<string, string> = {};

  // Auto-download photos so Claude can Read them directly
  const photoAttachments = msg.attachments?.filter(a => a.kind === "photo") ?? [];
  if (photoAttachments.length > 0) {
    const paths: string[] = [];
    for (const photo of photoAttachments) {
      try {
        const localPath = await adapter.downloadAttachment(photo.fileId);
        paths.push(localPath);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "Photo download failed");
      }
    }
    if (paths.length > 0) {
      extraMeta.image_path = paths[0];
      if (paths.length > 1) extraMeta.image_paths = paths.join(",");
      const tags = paths.map(p => `[📷 Image: ${p}]`).join("\n");
      text = `${tags}\n${text}`;
    }
  }

  // Transcribe voice/audio
  const voiceAttachment = msg.attachments?.find(a => a.kind === "voice" || a.kind === "audio");
  if (voiceAttachment) {
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      try {
        const localPath = await adapter.downloadAttachment(voiceAttachment.fileId);
        const result = await transcribe(localPath, groqKey);
        try { unlinkSync(localPath); } catch { /* ignore */ }
        text = text ? `${text}\n\n[Voice message] ${result.text}` : `[Voice message] ${result.text}`;
        logger.info({ ...(logPrefix ? { context: logPrefix } : {}), transcription: result.text.slice(0, 80) }, "Voice transcribed");
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "Voice transcription failed");
        text = text || "[Voice message — transcription failed]";
      }
    } else {
      text = text || "[Voice message — STT API key not set]";
    }
    extraMeta.attachment_file_id = voiceAttachment.fileId;
  }

  // Auto-download document attachments so agents can Read them directly
  const docAttachments = msg.attachments?.filter(a => a.kind === "document") ?? [];
  if (docAttachments.length > 0) {
    const paths: string[] = [];
    for (const doc of docAttachments) {
      try {
        const localPath = await adapter.downloadAttachment(doc.fileId);
        paths.push(localPath);
        const filename = doc.filename ?? "file";
        text = `[📎 File: ${filename} → ${localPath}]\n${text}`;
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "Document download failed");
        if (!extraMeta.attachment_file_id) extraMeta.attachment_file_id = doc.fileId;
      }
    }
    if (paths.length > 0) {
      extraMeta.attachment_path = paths[0];
      if (paths.length > 1) extraMeta.attachment_paths = paths.join(",");
    }
  }

  // Pass remaining attachment types as file_id for manual download
  const otherAttachment = msg.attachments?.find(a =>
    a.kind !== "photo" && a.kind !== "voice" && a.kind !== "audio" && a.kind !== "document",
  );
  if (otherAttachment) {
    extraMeta.attachment_file_id = otherAttachment.fileId;
  }

  return { text, extraMeta };
}
