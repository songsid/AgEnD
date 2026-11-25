// Files on a card: what an agent made and put on the card, under the comment it came with and, together, in the
// card's Files field. Each file is a download (GET /ui/tasks/files/<id>: an image as an image, the rest as an opaque download — never
// a page of the dashboard's own origin); what the page shows of it is read here, on a click, and drawn by the chat's own pieces:
//  - a picture: the picture;
//  - Markdown: the chat's Markdown renderer (escapes first; code blocks decorated); text, CSV, JSON, code: plain text in a block
//    (textContent — nothing in the file is ever run);
//  - an .html file: the chat's sandboxed preview frame (AgendPreview: this device must allow previews; a frame of an opaque
//    origin with scripts only, no cookies, no network of the dashboard). Not offered over the public link (as in the chat), except
//    to an admin session there. A file the page cannot show is still a download.
// No style attribute anywhere (the CSP).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import "/assets/chat-render.js";
import "/assets/chat-strings.js";
import { Icon } from "/assets/ui-icons.js";
import { loadHtmlAttachment, sizeLabel } from "/assets/html-attachment.js";
import { MdBody, commentHtml } from "./fleet-task-md.js";
import { relTime } from "./fleet-task-common.js";

register("taskfiles", {
  en: {
    title: "Files", count: "{0}", download: "Download", show: "Show", hide: "Hide", preview: "Preview", stop: "Stop preview", live: "This is a preview", loading: "Loading…",
    large: "This file is large ({0}). Preview anyway?", anyway: "Preview anyway", over: "This file is too large to show here. Download it.",
    gone: "This file is no longer available.", failed: "The file could not be read.", allow: "Allow previews on this device",
    optin: "Previews are off on this device. Allow them to run this file here, or download it.", lines: "Show all {0} lines", plain: "Shown as plain text.",
    by: "{0} · {1}", openImage: "Open the picture", fileOf: "File {0}, {1}",
  },
  "zh-TW": {
    title: "檔案", count: "{0}", download: "下載", show: "顯示", hide: "收合", preview: "預覽", stop: "停止預覽", live: "這是預覽", loading: "讀取中…",
    large: "這個檔案很大（{0}）。還是要預覽嗎？", anyway: "仍要預覽", over: "這個檔案太大，無法在這裡顯示，請下載。",
    gone: "這個檔案已經不存在。", failed: "無法讀取這個檔案。", allow: "在這台裝置允許預覽",
    optin: "這台裝置沒有開啟預覽。允許後可以直接在這裡執行這個檔案，或直接下載。", lines: "顯示全部 {0} 行", plain: "以純文字顯示。",
    by: "{0} · {1}", openImage: "開啟圖片", fileOf: "檔案 {0}，{1}",
  },
});

/** Where a card's file is read: the board's own route, by the id the fleet issued (32 hex — nothing else becomes a URL). */
export const fileUrl = (f) => `/ui/tasks/files/${f.id}`;
const att = (f) => ({ id: f.id, kind: f.kind, name: f.name, size: f.size, mime: f.mime, url: fileUrl(f) });
const validId = (f) => !!f && typeof f.id === "string" && /^[0-9a-f]{32}$/.test(f.id);

/** The most a text file is read for display (as the chat's text cards), and the lines shown before "Show all". */
export const TEXT_MAX = 1024 * 1024;
export const TEXT_LINES = 200;

/**
 * How the page shows a file (pure: tests import it): "image" | "md" | "text" | "html" | null (a download only). The chat's own
 * classification by name (`attachmentPreviewType`), so a card and a chat agree about what a file is; media is a download here.
 */
export function previewKind(f) {
  if (!validId(f)) return null;
  if (f.kind === "photo") return "image";
  const R = globalThis.AgendChatRender;
  if (R && typeof R.isHtmlAttachment === "function" && R.isHtmlAttachment(f)) return "html";
  const type = R && typeof R.attachmentPreviewType === "function" ? R.attachmentPreviewType(f) : null;
  if (!type || type === "video" || type === "audio") return null;
  return type === "md" ? "md" : "text";
}

/** HTML is run only where the chat would run it: not over the public link, unless an admin session there (data-link-media). */
function htmlOffered() {
  const d = (globalThis.document && globalThis.document.body && globalThis.document.body.dataset) || {};
  return d.publicLink !== "1" || d.linkMedia === "1";
}

/** A file's size as the chat words it ("812 B", "12 KB", "1.4 MB"); the preview questions' own "MB" wording when that renderer is not there. */
const sizeText = (n) => {
  if (typeof n !== "number") return "";
  const R = globalThis.AgendChatRender;
  return R && typeof R.formatSize === "function" ? R.formatSize(n) : sizeLabel(n);
};

/** A text file's body: Markdown through the chat's renderer, anything else as plain text in a block; long ones folded. */
function TextBody({ text, kind }) {
  const [all, setAll] = useState(false);
  const lines = text.split(/\r?\n/);
  const cut = !all && lines.length > TEXT_LINES;
  const shown = cut ? lines.slice(0, TEXT_LINES).join("\n") : text;
  const md = kind === "md" ? commentHtml(shown) : null;
  return html`<div class="tf-body">
    ${md ? html`<${MdBody} body=${md} cls="tf-md tl-body md" />` : html`<pre class="tf-pre"><code>${shown}</code></pre>`}
    ${cut ? html`<button type="button" class="btn btn-sm tf-more" onClick=${() => setAll(true)}>${t("taskfiles.lines", lines.length)}</button>` : null}
  </div>`;
}

/** An .html file in the chat's sandbox frame (AgendPreview), started by a click, stopped when the card leaves the page. */
function HtmlPreview({ f }) {
  const P = globalThis.AgendPreview;
  const holder = useRef(null);
  const [state, setState] = useState("idle");
  const [note, setNote] = useState("");
  const [large, setLarge] = useState(null);
  const [, redraw] = useState(0);
  const key = `taskfile:${f.id}`;
  useEffect(() => () => { try { if (P) P.stop(key, "stopped", ""); } catch { /* not running */ } }, [key]);
  // "I understand" is kept by the preview module (per sign-in), not by this component, so a press changes nothing this component holds:
  // it draws again on the press itself (below) and whenever the module says the acknowledgement changed (the chat's, another card's or
  // another tab's press — the chat's own panel listens the same way).
  useEffect(() => (P && typeof P.onChange === "function" ? P.onChange(() => redraw((n) => n + 1)) : undefined), [P]);
  if (!P || !htmlOffered()) return null;
  const going = state === "starting" || state === "running";
  // A reason no click can change (the server offers no preview at this address, the page is behind a proxy that rewrites its Host, this
  // session switched previews off) is said up front, with no button to press; only "this device has not allowed previews" is asked on the click.
  const here = P.availability();
  const blocked = !here.ok && here.why !== "optin" && !going;
  const ui = { state: (name, reason) => { setState(name === "starting" || name === "running" ? name : "idle"); if (name === "large") { setLarge(true); } setNote(reason || ""); } };
  async function run(anyway) {
    let a = P.availability();
    if (!a.ok && a.why === "optin") {
      // The chat's own question (what a preview means for this device), asked once; no answer, no preview.
      try { const m = await import("./panel-chat.js"); await m.setPreviewOptIn(true); } catch { /* the note below says it is off */ }
      a = P.availability();
    }
    if (!a.ok) { setNote(a.reason); return; }
    setLarge(null); setNote(t("taskfiles.loading"));
    const r = await loadHtmlAttachment(att(f), undefined, { anyway });
    if (!r.ok) {
      if (r.reason === "large") { setLarge(true); setNote(t("taskfiles.large", sizeText(r.size))); return; }
      setNote(t(r.reason === "over" ? "taskfiles.over" : r.reason === "gone" ? "taskfiles.gone" : "taskfiles.failed"));
      return;
    }
    setNote("");
    // `fill`: the frame fills the holder's box (fleet-task-files in task-board.css gives it a fixed height), not the strip a page that lays itself out by the window's height reports.
    P.start(key, holder.current, r.code, ui, { fill: true, ...(anyway ? { anyway: true } : {}) });
  }
  return html`<div class="tf-html">
    <div class=${`tf-actions${going ? " tf-live" : ""}`}>
      ${going ? html`<button type="button" class="btn btn-sm tf-stop" onClick=${() => P.stop(key, "stopped", "")}>${t("taskfiles.stop")}</button>
        <span class="tf-live-mark">${t("taskfiles.live")}</span>`
        : large ? html`<button type="button" class="btn btn-sm" onClick=${() => void run(true)}>${t("taskfiles.anyway")}</button>`
        : blocked ? null
        : html`<button type="button" class="btn btn-sm btn-primary" onClick=${() => void run(false)}><${Icon} name="play" size=${14} />${t("taskfiles.preview")}</button>`}
    </div>
    <div class="pv-note tf-note" role="status">${note || (blocked ? here.reason : "")}</div>
    ${going && !P.bannerAcked() ? html`<div class="pv-banner" role="note"><span class="pv-banner-text">${P.banner()}</span>
      <button type="button" class="btn btn-sm btn-ghost pv-ack" title=${P.bannerAckTitle()} onClick=${() => { P.ackBanner(); redraw((n) => n + 1); }}>${P.bannerAckLabel()}</button></div>` : null}
    <div class="pv-holder tf-holder" ref=${holder}></div>
  </div>`;
}

/** A text file's "Show": read once (capped), then drawn; "Hide" folds it again. */
function TextPreview({ f, kind }) {
  const [text, setText] = useState(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  async function toggle() {
    if (text !== null) { setOpen(!open); return; }
    setNote(t("taskfiles.loading"));
    const r = await loadHtmlAttachment(att(f), undefined, { ask: TEXT_MAX, max: TEXT_MAX });
    if (!r.ok) { setNote(t(r.reason === "over" || r.reason === "large" ? "taskfiles.over" : r.reason === "gone" ? "taskfiles.gone" : "taskfiles.failed")); return; }
    let body = r.code;
    if (/\.json$/i.test(f.name)) { try { body = JSON.stringify(JSON.parse(body), null, 2); } catch { /* shown as written */ } }
    setNote(""); setText(body); setOpen(true);
  }
  return html`<div class="tf-text">
    <div class="tf-actions"><button type="button" class="btn btn-sm" aria-expanded=${open ? "true" : "false"} onClick=${() => void toggle()}>${t(open ? "taskfiles.hide" : "taskfiles.show")}</button></div>
    <div class="pv-note tf-note" role="status">${note}</div>
    ${open && text !== null ? html`<${TextBody} text=${text} kind=${kind} />` : null}
  </div>`;
}

/** One file: its name (the download), its size, who and when, and what the page can show of it. */
export function FileRow({ f, showWho = false }) {
  if (!validId(f)) return null;
  const kind = previewKind(f);
  const url = fileUrl(f);
  return html`<li class=${`tf-row tf-k-${kind || "other"}`} data-file=${f.id}>
    <div class="tf-head">
      <span class="tf-icon" aria-hidden="true"><${Icon} name="attach" size=${14} /></span>
      <a class="tf-name" href=${url} download=${f.name} title=${t("taskfiles.download")}>${f.name}</a>
      <span class="tf-meta">${sizeText(f.size)}${showWho && f.author ? ` · ${t("taskfiles.by", f.author, relTime(f.at))}` : ""}</span>
      <span class="tf-grow"></span>
      <a class="btn btn-sm btn-ghost tf-dl" href=${url} download=${f.name} aria-label=${`${t("taskfiles.download")}: ${f.name}`}><${Icon} name="download" size=${14} />${t("taskfiles.download")}</a>
    </div>
    ${kind === "image" ? html`<a class="tf-img" href=${url} target="_blank" rel="noopener noreferrer" title=${t("taskfiles.openImage")}><img src=${url} alt=${f.name} loading="lazy" /></a>` : null}
    ${kind === "md" || kind === "text" ? html`<${TextPreview} f=${f} kind=${kind} />` : null}
    ${kind === "html" ? html`<${HtmlPreview} f=${f} />` : null}
  </li>`;
}

/** The files under a comment. */
export function FileList({ files, cls = "", showWho = false }) {
  const list = (files || []).filter(validId);
  if (!list.length) return null;
  return html`<ul class=${`tf-list${cls ? ` ${cls}` : ""}`}>${list.map((f) => html`<${FileRow} key=${f.id} f=${f} showWho=${showWho} />`)}</ul>`;
}

/** The card's Files field: every file on the card, newest last, with who put it there. Nothing when there are none. */
export function FilesField({ files }) {
  const list = (files || []).filter(validId);
  if (!list.length) return null;
  return html`<section class="tc-field tp-files" aria-label=${t("taskfiles.title")} data-files=${list.length}>
    <h3>${t("taskfiles.title")} <span class="tf-count">${t("taskfiles.count", list.length)}</span></h3>
    <div class="tc-field-body"><${FileList} files=${list} showWho /></div>
  </section>`;
}
