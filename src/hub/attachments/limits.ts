/** Hub attachments (attachments-v1): limits, the type allowlist, image magic bytes and the digests that bind files to
 * a question or an answer. Pure: no I/O, no state. */
import { HUB_ATTACHMENT_FILE_MAX, HUB_ATTACHMENTS_PER_MESSAGE } from "../protocol.js";
export { attachmentsDigest, messageContentDigest } from "../identity.js";

export interface HubAttachmentLimits { fileBytes: number; files: number; messageBytes: number }
/** The defaults are also the ceiling: a Hub config may only lower them. */
export const HUB_ATTACHMENT_LIMITS: Readonly<HubAttachmentLimits> = Object.freeze({ fileBytes: HUB_ATTACHMENT_FILE_MAX, files: HUB_ATTACHMENTS_PER_MESSAGE, messageBytes: 50 * 1024 * 1024 });
export function attachmentLimits(config?: Partial<HubAttachmentLimits> | null): HubAttachmentLimits {
  const pick = (key: keyof HubAttachmentLimits): number => {
    const value = config?.[key], ceiling = HUB_ATTACHMENT_LIMITS[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= ceiling ? value : ceiling;
  };
  return { fileBytes: pick("fileBytes"), files: pick("files"), messageBytes: pick("messageBytes") };
}

/** Extension → stored type. Everything else is refused with a reason. SVG is not here: it is never a supported type. */
const ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", htm: "text/html",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
});
const IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type AttachmentTypeRefusal = "type-not-allowed" | "image-mismatch" | "empty";
/** The type a file is stored and served as, decided by its name; an image must also carry its format's magic bytes. */
export function classifyAttachment(name: string, head: Buffer): { mime: string; image: boolean } | { refused: AttachmentTypeRefusal } {
  if (head.length === 0) return { refused: "empty" };
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
  const mime = ext !== undefined && Object.hasOwn(ALLOWED, ext) ? ALLOWED[ext]! : undefined;
  if (!mime) return { refused: "type-not-allowed" };
  if (!IMAGE.has(mime)) return { mime, image: false };
  return sniffImage(head) === mime ? { mime, image: true } : { refused: "image-mismatch" };
}
/** PNG, JPEG, GIF and WebP by their leading bytes; anything else (SVG included) is not an image. */
export function sniffImage(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
export const isInlineImage = (mime: string): boolean => IMAGE.has(mime);
