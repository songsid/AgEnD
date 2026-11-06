// #3226 D2: files in a Hub question — the composer's Attach, the files waiting under it, and the words for both. A lazy
// Hub module with its own strings (an older tab's shared strings never lack them) and only class names the shared
// stylesheet has had since the fleet chat's own attachments (.pending-files, .file-chip, .chip-x).
// The server decides everything: a room offers Attach only while its fleet link negotiated attachments-v1 (room.features);
// each file is uploaded on choice (typed by name, images by their bytes, within the limits), and Send names the ids.
import { html } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";

register("hubfiles", {
  en: { attach: "Attach files", off: "This agent can't receive files yet.", uploading: "Uploading…", remove: "Remove {0}",
    failed: "{0} wasn't attached: {1}", tooMany: "At most {0} files per question.", tooLarge: "it is over 20 MB",
    typeNotAllowed: "this type isn't allowed (PNG, JPEG, GIF, WebP, PDF, text, Markdown, CSV, JSON, Word, Excel, PowerPoint, HTML)",
    imageMismatch: "it isn't the image its name says", empty: "it is empty", busy: "too many files are waiting; send or remove some first",
    unavailable: "the agent can't receive files right now", other: "the Hub refused it ({0})", waitUpload: "Wait until the files are uploaded." },
  "zh-TW": { attach: "附加檔案", off: "這個代理目前還不能接收檔案。", uploading: "上傳中…", remove: "移除 {0}",
    failed: "{0} 沒有附加：{1}", tooMany: "每個問題最多 {0} 個檔案。", tooLarge: "超過 20 MB",
    typeNotAllowed: "不支援這種類型（PNG、JPEG、GIF、WebP、PDF、純文字、Markdown、CSV、JSON、Word、Excel、PowerPoint、HTML）",
    imageMismatch: "內容不是檔名所說的圖片", empty: "檔案是空的", busy: "等待中的檔案太多，請先送出或移除一些",
    unavailable: "代理目前無法接收檔案", other: "Hub 拒絕了這個檔案（{0}）", waitUpload: "請等檔案上傳完成。" },
});
export const hf = (key, ...a) => t(`hubfiles.${key}`, ...a);
export const FILES_FEATURE = "attachments-v1";
export const MAX_FILES = 10;
/** Whether this room's fleet link takes files now. */
export const roomTakesFiles = (room) => Array.isArray(room && room.features) && room.features.includes(FILES_FEATURE);

/**
 * A Hub file ({ id: uuid, name, size, mime, url }) as the shared thread draws an attachment: its id as the 32 hex digits
 * the renderer accepts, its room URL (same origin, so the thread's link, image and text card read it there), and an
 * image (by its server-checked type) as a photo. Anything else is not drawn.
 */
export function hubFileAttachment(f) {
  if (!f || typeof f.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(f.id)
    || typeof f.url !== "string" || !f.url.startsWith("/hub/v1/rooms/") || f.url.startsWith("//")) return null;
  const image = /^image\/(?:png|jpeg|gif|webp)$/.test(f.mime || "");
  return { id: f.id.replace(/-/g, ""), name: String(f.name || "file"), size: Number(f.size) || 0, mime: f.mime, url: image ? `${f.url}?inline=1` : f.url, ...(image ? { kind: "photo" } : {}) };
}

/** Why the server refused an upload, in words. */
export function uploadRefusal(r) {
  const by = { "too-large": "tooLarge", "type-not-allowed": "typeNotAllowed", "image-mismatch": "imageMismatch", empty: "empty", backpressure: "busy", incompatible: "unavailable", unavailable: "unavailable" };
  if (r && r.status === 413) return hf("tooLarge");
  const key = r && by[r.code];
  return key ? hf(key) : hf("other", (r && (r.code || r.status)) || "?");
}

/**
 * Upload chosen files one at a time; `files` is the composer's list of { key, name, size, state: "uploading" | "ready",
 * id? }. Returns the refusals as one line each (the chips of refused files are removed).
 */
export async function uploadChosen(client, roomId, fileList, { current, set }) {
  const chosen = [...(fileList || [])], refusals = [];
  const room = Math.max(0, MAX_FILES - current().length);
  if (chosen.length > room) refusals.push(hf("tooMany", MAX_FILES));
  for (const file of chosen.slice(0, room)) {
    const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    set([...current(), { key, name: file.name, size: file.size, state: "uploading" }]);
    const r = await client.upload(roomId, file);
    if (r && r.ok && r.file) set(current().map((f) => (f.key === key ? { ...f, state: "ready", id: r.file.id, name: r.file.name, size: r.file.size } : f)));
    else { set(current().filter((f) => f.key !== key)); refusals.push(hf("failed", file.name, uploadRefusal(r))); }
  }
  return refusals;
}

/** The files waiting under the composer. */
export function PendingFiles({ files, onRemove, formatSize = (n) => `${n} B` }) {
  if (!files.length) return null;
  return html`<div class="pending-files hub-pending-files">${files.map((f) => html`<span key=${f.key} class="file-chip" data-state=${f.state}>
    <span class="ic"><${Icon} name="file" size=${16} /></span><span class="nm">${f.name}</span>
    <span class="sz">${f.state === "uploading" ? hf("uploading") : formatSize(f.size)}</span>
    <button type="button" class="chip-x" title=${hf("remove", f.name)} aria-label=${hf("remove", f.name)} onClick=${() => onRemove(f.key)}><${Icon} name="close" size=${14} /></button></span>`)}</div>`;
}
