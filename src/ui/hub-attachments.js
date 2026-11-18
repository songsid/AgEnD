// #3226 D2: files in a Hub question — the composer's Attach, the files waiting under it, and the words for both. A lazy
// Hub module with its own strings (an older tab's shared strings never lack them) and only class names the shared
// stylesheet has had since the fleet chat's own attachments (.pending-files, .file-chip, .chip-x).
// The server decides everything: a room offers Attach only while its fleet link negotiated attachments-v1 (room.features);
// each file is uploaded on choice (typed by name, images by their bytes, within the limits), and Send names the ids.
import { html, useEffect, useRef } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";

register("hubfiles", {
  en: { attach: "Attach files", off: "This agent can't receive files yet.", uploading: "Uploading…", remove: "Remove {0}",
    failed: "{0} wasn't attached: {1}", tooMany: "At most {0} files per question.", tooLarge: "it is over 20 MB",
    typeNotAllowed: "this type isn't allowed (PNG, JPEG, GIF, WebP, PDF, text, Markdown, CSV, JSON, Word, Excel, PowerPoint, HTML)",
    imageMismatch: "it isn't the image its name says", empty: "it is empty", busy: "too many files are waiting; send or remove some first",
    unavailable: "the agent can't receive files right now", other: "the Hub refused it ({0})", waitUpload: "Wait until the files are uploaded.",
    held: "This agent can't receive files right now. Send again when it can, or remove the files to send only the text.",
    reload: "Reload the page to attach files." },
  "zh-TW": { attach: "附加檔案", off: "這個 Agent 目前還不能接收檔案。", uploading: "上傳中…", remove: "移除 {0}",
    failed: "{0} 沒有附加：{1}", tooMany: "每個問題最多 {0} 個檔案。", tooLarge: "超過 20 MB",
    typeNotAllowed: "不支援這種類型（PNG、JPEG、GIF、WebP、PDF、純文字、Markdown、CSV、JSON、Word、Excel、PowerPoint、HTML）",
    imageMismatch: "內容不是檔名所說的圖片", empty: "檔案是空的", busy: "等待中的檔案太多，請先送出或移除一些",
    unavailable: "Agent 目前無法接收檔案", other: "Hub 拒絕了這個檔案（{0}）", waitUpload: "請等檔案上傳完成。",
    held: "這個 Agent 目前無法接收檔案。等它可以接收時再送出，或移除檔案只送出文字。",
    reload: "重新載入頁面後才能附加檔案。" },
});
export const hf = (key, ...a) => t(`hubfiles.${key}`, ...a);
export const FILES_FEATURE = "attachments-v1";
export const MAX_FILES = 10;
/** Whether this room's fleet link takes files now. */
export const roomTakesFiles = (room) => Array.isArray(room && room.features) && room.features.includes(FILES_FEATURE);
/**
 * Whether this page's Hub client and room store carry files (D2 marks both). A tab that loaded an older hub-client.js or
 * hub-chat-store.js before this module keeps those: its client has no upload and its ask drops the ids, so a question
 * with files would go as text. Without both marks the page offers no Attach and asks for a reload instead.
 */
export const pageCarriesFiles = (client, store) => !!(client && client.filesV1 === true && typeof client.upload === "function" && store && store.filesV1 === true);

/**
 * A Hub file ({ id: uuid, name, size, mime, url }) as the shared thread draws an attachment: its id as the 32 hex digits
 * the renderer accepts, its room URL (same origin, so the thread's link, image and text card read it there), and an
 * image (by its server-checked type) as a photo. Anything else is not drawn.
 */
export function hubFileAttachment(f) {
  if (!f || typeof f.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(f.id)
    || typeof f.url !== "string" || !f.url.startsWith("/hub/v1/rooms/") || f.url.startsWith("//")) return null;
  const image = /^image\/(?:png|jpeg|gif|webp)$/.test(f.mime || "");
  return { id: f.id.replace(/-/g, ""), name: String(f.name || "file"), size: Number(f.size) || 0, mime: f.mime, url: image ? `${f.url}/inline` : f.url, ...(image ? { kind: "photo" } : {}) };
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
 * id? }. Every admitted file takes its place in the list at once, before the first upload, so choices that overlap
 * never hold more than MAX_FILES between them (queued ones count). A file whose chip was removed before its turn is not
 * sent, and nothing more starts once `alive()` is false (the room was left). Returns the refusals, one line each (the
 * chips of refused files are removed).
 */
export async function uploadChosen(client, roomId, fileList, { current, set, alive = () => true }) {
  const chosen = [...(fileList || [])], refusals = [];
  const room = Math.max(0, MAX_FILES - current().length);
  if (chosen.length > room) refusals.push(hf("tooMany", MAX_FILES));
  const admitted = chosen.slice(0, room).map((file) => ({ file, key: `${Date.now()}-${Math.random().toString(36).slice(2)}` }));
  if (admitted.length) set([...current(), ...admitted.map(({ file, key }) => ({ key, name: file.name, size: file.size, state: "uploading" }))]);
  for (const { file, key } of admitted) {
    if (!alive()) break;
    if (!current().some((f) => f.key === key)) continue;
    let r;
    try { r = await client.upload(roomId, file); } catch { r = { ok: false, status: 0, code: "unreachable" }; }
    if (!alive()) break;
    if (r && r.ok && r.file) set(current().map((f) => (f.key === key ? { ...f, state: "ready", id: r.file.id, name: r.file.name, size: r.file.size } : f)));
    else { set(current().filter((f) => f.key !== key)); refusals.push(hf("failed", file.name, uploadRefusal(r))); }
  }
  return refusals;
}

// ── M-3308 / M-3311: the Fleet chat's paste and drop (panel-chat.js onPaste, its drag-and-drop), for a Hub conversation — a
// room and a 1:1 question alike, through their own Attach (`attach`: { onFiles(list) → refusals, left?() → files that still
// fit, notice?(text) }) and so the Hub's file rules (uploadChosen above). Words: the Fleet chat's own (chat.*).

/** Past this many characters a text paste goes as a text file (the Fleet chat's LONG_PASTE_CHARS, chat-render.js). */
export const LONG_PASTE_CHARS = 4000;
const isLongPaste = (text) => (globalThis.AgendChatRender?.isLongPaste ? globalThis.AgendChatRender.isLongPaste(text) : typeof text === "string" && text.length > LONG_PASTE_CHARS);
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
/**
 * A pasted file as the Hub uploads it. A clipboard picture (a screen capture) may come with no name — the Hub refuses an
 * upload without one — so it is named `screenshot-<time>.<png|jpg|…>` by its type; a named one (Chrome's "image.png", a
 * copied file) keeps its own.
 */
export function pastedFile(file) {
  if (!file || (file.name && file.name.trim())) return file;
  const ext = IMAGE_EXT[file.type] || (String(file.type).startsWith("text/") ? "txt" : "bin");
  return new File([file], `${String(file.type).startsWith("image/") ? "screenshot" : "pasted"}-${stamp()}.${ext}`, { type: file.type, lastModified: file.lastModified });
}
/**
 * A paste into a Hub composer: its files are attached (the paste stops there unless text came with them); a text past
 * LONG_PASTE_CHARS goes as `pasted-<time>.txt` — only when there is room for it (#4151 review: as the Fleet chat keeps it in the
 * box when nothing more fits), and once attached it says so (the Fleet chat's notice). No `attach`: the box takes it, as ever.
 */
export function pasteToAttach(e, attach) {
  if (!attach) return;
  const list = e.clipboardData && e.clipboardData.files ? [...e.clipboardData.files] : [];
  const text = e.clipboardData ? e.clipboardData.getData("text") : "";
  if (list.length) { void attach.onFiles(list.map(pastedFile)); if (!text) e.preventDefault(); return; }
  if (!isLongPaste(text)) return;
  if (typeof attach.left === "function" && attach.left() < 1) { attach.notice?.(t("chat.pasteKeptAsText")); return; }
  e.preventDefault();
  const file = new File([text], `pasted-${stamp()}.txt`, { type: "text/plain" });
  Promise.resolve(attach.onFiles([file])).then((refused) => { if (!refused || !refused.length) attach.notice?.(t("chat.pasteAttached", text.length.toLocaleString())); });
}
/**
 * M-3311 (1): files dragged over a Hub conversation (the `.hub-chat-main` at `ref`) show where they go; a drop attaches them —
 * the Fleet chat's own (counted, so moving over messages does not flicker). Nothing while the conversation takes no files.
 */
export function useFileDrop(ref, attach) {
  const on = !!attach, latest = useRef(attach);
  latest.current = attach;                       // the latest Attach (it closes over the conversation's current list), read at the drop
  useEffect(() => {
    const el = ref.current; if (!el || !on) return undefined;
    let depth = 0;
    const hasFiles = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files"));
    const enter = (e) => { if (hasFiles(e)) { depth++; el.classList.add("dragging"); } };
    const over = (e) => { if (hasFiles(e)) e.preventDefault(); };
    const leave = (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; el.classList.remove("dragging"); } };
    const drop = (e) => {
      depth = 0; el.classList.remove("dragging");
      const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
      if (!files.length) return;
      e.preventDefault(); void latest.current?.onFiles(files.map(pastedFile));
    };
    el.addEventListener("dragenter", enter); el.addEventListener("dragover", over); el.addEventListener("dragleave", leave); el.addEventListener("drop", drop);
    return () => { el.classList.remove("dragging"); el.removeEventListener("dragenter", enter); el.removeEventListener("dragover", over); el.removeEventListener("dragleave", leave); el.removeEventListener("drop", drop); };
  }, [ref.current, on]);
}
/** Where a dragged file goes: the Fleet chat's drop card (shown by `.dragging` on the conversation). */
export const DropOverlay = () => html`<div data-trust="drop" class="drop-overlay" aria-hidden="true"><div class="drop-card"><${Icon} name="attach" size=${32} /><span>${t("chat.dropHere")}</span></div></div>`;

/** The files waiting under the composer. */
export function PendingFiles({ files, onRemove, formatSize = (n) => `${n} B` }) {
  if (!files.length) return null;
  return html`<div class="pending-files hub-pending-files">${files.map((f) => html`<span key=${f.key} class="file-chip" data-state=${f.state}>
    <span class="ic"><${Icon} name="file" size=${16} /></span><span class="nm">${f.name}</span>
    <span class="sz">${f.state === "uploading" ? hf("uploading") : formatSize(f.size)}</span>
    <button type="button" class="chip-x" title=${hf("remove", f.name)} aria-label=${hf("remove", f.name)} onClick=${() => onRemove(f.key)}><${Icon} name="close" size=${14} /></button></span>`)}</div>`;
}
