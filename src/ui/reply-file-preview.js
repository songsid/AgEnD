// Fleet-only file previews. Inert references: no file is fetched until an admin clicks.
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { Skeleton } from "/assets/ui-states.js";
import { WorkspaceFileViewer, linkWorkspaceCss } from "./workspace-panel.js";
import { openReplyPreviewImage } from "/assets/image-lightbox.js";
import { openReplyFile, openMarkdown, panelStore, closePanel } from "/assets/preview-panel.js";
register("replyPreview", {
  en: { button: "Preview {0}", title: "File preview", loading: "Loading file", unoffered: "File previews are not available for this agent.", missing: "This file is no longer in the agent's working folder.", denied: "This preview needs an administrator session and a file inside this agent's working folder.", changed: "The session or working folder changed. Open the preview again.", failed: "The file could not be loaded. Try opening the preview again.", remote: "Previews of files on a paired Windows computer aren't available yet.", lines: "Requested lines: {0}–{1}", readonly: "Read only · current file in this agent's working folder", pdf: "PDF preview" },
  "zh-TW": { button: "預覽 {0}", title: "檔案預覽", loading: "正在載入檔案", unoffered: "這個 Agent 無法提供檔案預覽。", missing: "這個檔案已不在 Agent 的工作資料夾裡。", denied: "需要管理員登入，且檔案必須在這個 Agent 的工作資料夾裡，才能預覽。", changed: "登入或工作資料夾已變更，請重新開啟預覽。", failed: "無法載入檔案，請重新開啟預覽再試一次。", remote: "目前還無法預覽已配對 Windows 電腦上的檔案。", lines: "指定行數：{0}–{1}", readonly: "唯讀 · 這個 Agent 工作資料夾裡的目前檔案", pdf: "PDF 預覽" },
});
function linkReplyCss() {
  if (typeof document === "undefined" || document.querySelector('link[data-reply-preview-css]')) return;
  const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/assets/reply-previews.css"; link.dataset.replyPreviewCss = "1"; document.head.append(link);
}
linkReplyCss();
export const replyPreviewLabel = p => t("replyPreview.button", p.path + (p.line ? `:${p.line}${p.endLine && p.endLine !== p.line ? `–${p.endLine}` : ""}` : ""));
export const replyPreviewUrl = (instance, path, op = "meta") => `/ui/reply-preview?${new URLSearchParams({ instance, path, op })}`;
export function previewReplyFile(instance, spec, opener, msgKey) {
  openReplyFile({ key: `reply-file:${instance}:${Date.now()}:${Math.random()}`, instance, spec, opener, msgKey });
}
const reason = code => t("replyPreview." + (code === "workspace_not_offered" ? "unoffered" : code === "not_found" ? "missing" : code === "preview_remote_unavailable" ? "remote" : code === "preview_changed" ? "changed" : ["outside", "hidden", "symlink", "preview_needs_admin"].includes(code) ? "denied" : "failed"));
export function ReplyFilePanel({ open, panel, fs, enterFs, leaveFs, onKey, close }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    linkWorkspaceCss();
    linkReplyCss();
    let live = true; const abort = new AbortController();
    setState({ loading: true });
    const current = () => live && panelStore.get().open?.key === open.key;
    (async () => {
      try {
        const response = await fetch(replyPreviewUrl(open.instance, open.spec.path), { credentials: "same-origin", cache: "no-store", signal: abort.signal });
        const body = await response.json(); if (!current()) return;
        if (!response.ok) { setState({ error: reason(body.error) }); return; }
        if (body.kind === "image") {
          // The click is still current. The regular image viewer owns Escape, zoom and focus return.
          closePanel(); openReplyPreviewImage(replyPreviewUrl(open.instance, open.spec.path, "raw"), open.spec.path, open.opener); return;
        }
        if (body.kind === "text" && /\.(md|markdown)$/i.test(open.spec.path) && !open.spec.line) {
          openMarkdown({ key: open.key + ":md", instance: open.instance, msgKey: open.msgKey, text: body.text, att: { name: open.spec.path }, sender: open.instance }); return;
        }
        setState({ body });
      } catch { if (current()) setState({ error: reason("failed") }); }
    })();
    return () => { live = false; abort.abort(); };
  }, [open.key]);
  const spec = open.spec;
  return html`<aside data-trust="preview" class=${`pv-panel ws-panel reply-file-panel${fs ? ` pv-fs pv-fs-${fs}` : ""}`} ref=${panel} aria-label=${t("replyPreview.title")} onKeyDown=${onKey}>
    <div class="pv-panel-head">
      <div class="pv-panel-title"><strong>${t("replyPreview.title")}</strong><span class="pv-source">${open.instance}</span></div>
      <button type="button" class="icon-btn only-wide" aria-label=${t(fs ? "chat.pvFsExit" : "chat.pvFs")} onClick=${() => fs ? leaveFs() : enterFs()}><${Icon} name=${fs ? "fullscreenexit" : "fullscreen"} size=${16} /></button>
      <button type="button" class="icon-btn pv-panel-close" aria-label=${t("chat.pvClose")} onClick=${close}><${Icon} name="close" size=${18} /></button>
    </div>
    <div class="pv-note ws-readonly">${t("replyPreview.readonly")}</div>
    <div class="pv-panel-body show-code ws-body">
      ${state.loading ? html`<${Skeleton} lines=${10} label=${t("replyPreview.loading")} />` : state.error ? html`<div class="pv-note" role="alert">${state.error}</div>`
        : state.body?.kind === "pdf" ? html`<code class="ws-path">${spec.path}</code><iframe data-reply-pdf title=${t("replyPreview.pdf")} src=${replyPreviewUrl(open.instance, spec.path, "raw")}></iframe>`
        : state.body ? html`<${WorkspaceFileViewer} file=${{ path: spec.path, state: "ready", body: state.body, ...(spec.line ? { hl: { kind: "read", from: spec.line, to: spec.endLine || spec.line } } : {}) }}
            highlightLabel=${t("replyPreview.lines", spec.line, spec.endLine || spec.line)} scroll=${el => el.scrollIntoView({ block: "center" })} />` : null}
    </div>
  </aside>`;
}
