import { z } from "zod";

/** Portable paths: no absolute, parent, drive/ADS, backslash or control-character interpretation. */
export function isReplyPreviewPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !/[\\:\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every(p => p !== "" && p !== "." && p !== "..");
}
export const ReplyPreviewSpecSchema = z.object({
  path: z.string().refine(isReplyPreviewPath, "Use a relative path inside this agent's working folder, with no .. or symlinks."),
  line: z.number().int().min(1).max(10_000_000).optional(),
  endLine: z.number().int().min(1).max(10_000_000).optional(),
}).strict().refine(p => p.endLine === undefined || (p.line !== undefined && p.endLine >= p.line), "endLine requires line and must not precede it.");
export const ReplyPreviewsSchema = z.array(ReplyPreviewSpecSchema).max(10);
export type ReplyPreviewSpec = z.infer<typeof ReplyPreviewSpecSchema>;
export const REMOTE_PREVIEW_REFUSAL = "previews of files on a paired Windows computer aren't available yet";
export function replyPreviews(value: unknown): ReplyPreviewSpec[] | null {
  if (value === undefined) return [];
  const p = ReplyPreviewsSchema.safeParse(value); return p.success ? p.data : null;
}
export function replyPreviewRefs(previews: readonly ReplyPreviewSpec[]): string {
  return previews.map(p => p.path + (p.line ? `:${p.line}${p.endLine && p.endLine !== p.line ? `-${p.endLine}` : ""}` : "")).join("\n");
}
export function replyPreviewText(text: string, previews: readonly ReplyPreviewSpec[]): string {
  const refs = replyPreviewRefs(previews); return refs ? `${text}${text ? "\n\n" : ""}${refs}` : text;
}
