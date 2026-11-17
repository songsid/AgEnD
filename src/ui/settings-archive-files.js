// M-3281: Settings → Web dashboard — the archived chat files' size limit (web.chat_archive.files_max_gb), an admin's (over
// the public link too, as the other Web settings since #4100). Raising it saves at once; lowering it below what is kept
// asks first, naming how much of the oldest goes ("This removes about 1.2 GB of the oldest archived files."), and the
// files are removed only after that confirmation — the server refuses a lowering that would remove any without it
// (`confirm_remove`, settings-api.ts) and answers with the amount, which this card then asks about.
// Its words live here (a file of its own: an open tab may hold an older settings-strings.js; this URL is new).
import { html, useEffect, useState } from "/assets/app-html.js";
import { Skeleton } from "/assets/ui-states.js";
import { Dialog } from "/assets/ui-dialog.js";
import { register, t } from "/assets/app-i18n.js";
import { api, confirmedWrite } from "./settings-confirm.js";

register("archiveFiles", {
  en: {
    title: "Archived chat files",
    field: "Size limit for all agents (GB)",
    hint: "Files and pictures of messages that have left an agent's last 500 are kept with them, every agent's together within this limit. Past it the oldest are removed first, down to 90% of the limit so the next ones fit, and their messages show the file as no longer kept. 0 keeps no files.",
    used: "Kept now: {0} in {1} files.",
    range: "Must be a number of GB from 0 to 100000",
    save: "Save limit", saving: "Saving…", saved: "Saved.", savedRemoved: "Saved. {0} of the oldest files were removed.",
    failed: "The limit could not be saved. Reload and try again.", unavailable: "The chat archive is not running.",
    confirmTitle: "Remove older archived files?",
    confirmBody: "This removes about {0} of the oldest archived files ({1} files). Their messages stay, showing the file as no longer kept. This cannot be undone.",
    confirm: "Remove and save", cancel: "Cancel",
  },
  "zh-TW": {
    title: "封存的聊天檔案",
    field: "所有 agent 合計的大小上限（GB）",
    hint: "超出 agent 最近 500 則的訊息，其檔案與圖片會一起保留，所有 agent 合計不超過這個上限。超過時從最舊的開始移除，降到上限的 90% 以便容納之後的檔案，對應的訊息會顯示檔案已不再保留。設為 0 則不保留檔案。",
    used: "目前保留：{0}，共 {1} 個檔案。",
    range: "必須是 0 到 100000 之間的 GB 數",
    save: "儲存上限", saving: "儲存中…", saved: "已儲存。", savedRemoved: "已儲存。已移除 {0} 個最舊的檔案。",
    failed: "無法儲存上限。請重新整理後再試。", unavailable: "聊天封存沒有在執行。",
    confirmTitle: "要移除較舊的封存檔案嗎？",
    confirmBody: "這會移除約 {0} 最舊的封存檔案（{1} 個檔案）。訊息會保留，並顯示檔案已不再保留。此動作無法復原。",
    confirm: "移除並儲存", cancel: "取消",
  },
});
// The in-effect line of `web.chat_archive` (Settings → Advanced's read-only list, panel-settings.js) — here for the same reason.
register("settings", {
  en: { chatArchiveInEffect: "messages kept {0}; their files up to {1} GB for all agents together, the oldest removed first (the limit: Web dashboard → Archived chat files)",
    chatArchiveForever: "with no age limit", chatArchiveDays: "{0} days" },
  "zh-TW": { chatArchiveInEffect: "訊息保存{0}；檔案所有 agent 合計最多 {1} GB，超過時先移除最舊的（上限：網頁儀表板 → 封存的聊天檔案）",
    chatArchiveForever: "不限天數", chatArchiveDays: "{0} 天" },
});
const copy = (key, ...v) => t(`archiveFiles.${key}`, ...v);

/** Bytes as people read a disk amount: GB with one decimal from 0.1 GB, else MB, else KB. */
export function archiveSize(bytes) {
  const GB = 1024 ** 3, MB = 1024 ** 2;
  if (bytes >= GB / 10) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
const validGb = (v) => String(v).trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100000;

export function ArchiveFilesSetting() {
  const [info, setInfo] = useState(null), [value, setValue] = useState(""), [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(""), [ask, setAsk] = useState(null);
  const load = async () => {
    const r = await api("/api/settings/chat-archive").catch(() => null);
    if (r && r.ok && r.body) { setInfo(r.body); setValue(String(r.body.files_max_gb)); } else setMsg(copy("unavailable"));
  };
  useEffect(() => { void load(); }, []);
  const write = async (gb, confirmRemove) => {
    setBusy(true); setMsg("");
    try {
      const r = await confirmedWrite("/api/settings/fleet/web", { method: "PUT", label: copy("title"),
        body: { chat_archive: { files_max_gb: gb, ...(confirmRemove ? { confirm_remove: true } : {}) } } });
      if (r.ok) {
        const removed = r.body && r.body.chat_archive_removed_files;
        setMsg(removed ? copy("savedRemoved", String(removed)) : copy("saved"));
        await load();
      } else if (r.status === 409 && r.body && r.body.error === "confirm_remove") {
        // More was kept meanwhile (or the page skipped its own question): the server's amount, asked about now.
        setAsk({ gb, removeBytes: r.body.remove_bytes, removeFiles: r.body.remove_files });
      } else setMsg(copy("failed"));
    } catch { setMsg(copy("failed")); } finally { setBusy(false); }
  };
  const save = async (e) => {
    e.preventDefault();
    if (!info || busy || !validGb(value)) return;
    const gb = Number(value);
    if (gb < info.files_max_gb) {
      // Lower: what it would remove, asked before anything is saved.
      const r = await api(`/api/settings/chat-archive?gb=${encodeURIComponent(String(gb))}`).catch(() => null);
      if (!r || !r.ok) { setMsg(copy("failed")); return; }
      if (r.body.remove_bytes > 0) { setAsk({ gb, removeBytes: r.body.remove_bytes, removeFiles: r.body.remove_files }); return; }
    }
    await write(gb, false);
  };
  return html`<section class="card s-archive-files" id="webArchiveFiles"><h3>${copy("title")}</h3>
    <p class="note">${copy("hint")}</p>
    ${!info && !msg ? html`<${Skeleton} variant="form" lines=${2} />` : null}
    ${info ? html`<form class="form" onSubmit=${save}>
      <div class="field"><label for="webArchiveFilesGb">${copy("field")}</label><input id="webArchiveFilesGb" type="number" inputmode="decimal" min="0" max="100000" step="0.1" value=${value} disabled=${busy}
        aria-invalid=${validGb(value) ? "false" : "true"} onInput=${(e) => setValue(e.target.value)} /></div>
      ${validGb(value) ? null : html`<p class="field-error" role="alert">${copy("range")}</p>`}
      <p class="note">${copy("used", archiveSize(info.used_bytes), String(info.files))}</p>
      <button class="btn" type="submit" disabled=${busy || !validGb(value) || Number(value) === info.files_max_gb}>${busy ? copy("saving") : copy("save")}</button>
    </form>` : null}
    ${msg ? html`<p role="status">${msg}</p>` : null}
    ${ask ? html`<${Dialog} title=${copy("confirmTitle")} busy=${busy} onClose=${() => setAsk(null)}
      actions=${html`<button class="btn" type="button" disabled=${busy} onClick=${() => setAsk(null)}>${copy("cancel")}</button>
        <button class="btn danger" type="button" disabled=${busy} onClick=${async () => { const a = ask; setAsk(null); await write(a.gb, true); }}>${copy("confirm")}</button>`}>
      <p>${copy("confirmBody", archiveSize(ask.removeBytes), String(ask.removeFiles))}</p>
    </${Dialog}>` : null}
  </section>`;
}
