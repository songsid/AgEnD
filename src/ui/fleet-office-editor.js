// Fleet → Org chart → Office: the offices people keep on the host, edited (#2399 carry: the write surface's minimal
// editor). An admin session adds an office, renames it, chooses its style (Desks / Studio), picks who is in it (whole
// teams, or one instance at a time; none: everyone) and deletes one — then saves the whole list with the rev it read
// (PUT /ui/offices; a change made meanwhile is a 409: read again, nothing overwritten). A stored office's layout (seats,
// paths) and its layout overrides (Edit layout, fleet-office-layout.js) are kept as they are. Skin packs (#2513): the
// packs the host keeps are styles to choose; an admin uploads one here (its manifest.json and its PNGs, picked together
// or as a folder — sent at once, checked by the host, which keeps it whole) or deletes one. Never offered to a guest,
// the public link or a read-only session (the host refuses them too).
import { html, useMemo, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { toast } from "/assets/ui-toast.js";
import { nodeText } from "./fleet-org.js";

register("orge", {
  en: {
    edit: "Edit offices", title: "Offices", lead: "Offices everyone on this fleet sees in the Office view. An office with no one picked shows everyone.",
    add: "Add office", newName: "New office", name: "Name", styleLabel: "Style", members: "Who is in it", membersN: "{0} picked", everyone: "Everyone",
    teams: "Teams", instances: "Instances", remove: "Delete", save: "Save", cancel: "Cancel", saved: "Offices saved.",
    none: "No offices yet: the Office view shows the whole fleet.", nameNeeded: "Each office needs a name.", tooMany: "At most {0} offices.",
    changed: "Someone changed the offices meanwhile; your edits were not saved. Keep your edits (Save then replaces their change) or load theirs.",
    changedUnread: "Someone changed the offices meanwhile; your edits were not saved, and the current list could not be read. Try again.",
    keepMine: "Keep my edits", loadTheirs: "Load theirs", keptMine: "Your edits are kept. Save replaces what was saved meanwhile.",
    rateLimited: "Too many saves. Try again in a minute.",
    failed: "The offices were not saved ({0}).", layoutKept: "Its seats and paths are kept.",
    styleUnknown: "{0} (not available here: drawn as Desks)",
    packs: "Skin packs", packsLead: "Styles drawn from an artist's pictures. Pick a pack's manifest.json and all its PNG files together (or its folder).",
    packsNone: "No skin packs yet.", upload: "Upload a skin pack", uploadFolder: "Upload a folder", uploading: "Uploading…", uploaded: "Skin pack “{0}” uploaded.",
    uploadFailed: "The skin pack was not uploaded: {0}", noManifest: "no manifest.json among the files", badManifest: "manifest.json is not JSON",
    removePack: "Delete {0}", removedPack: "Skin pack “{0}” deleted.", removeFailed: "The skin pack was not deleted ({0}).",
  },
  "zh-TW": {
    edit: "編輯辦公室", title: "辦公室", lead: "這個 fleet 的每個人在辦公室檢視中都會看到這些辦公室。沒有選任何成員的辦公室會顯示全部。",
    add: "新增辦公室", newName: "新辦公室", name: "名稱", styleLabel: "風格", members: "成員", membersN: "已選 {0} 個", everyone: "全部",
    teams: "Team", instances: "Instance", remove: "刪除", save: "儲存", cancel: "取消", saved: "辦公室已儲存。",
    none: "還沒有辦公室：辦公室檢視會顯示整個 fleet。", nameNeeded: "每個辦公室都需要名稱。", tooMany: "最多 {0} 個辦公室。",
    changed: "有人在這期間修改了辦公室，你的編輯沒有儲存。你可以保留你的編輯（儲存時會取代對方的修改），或載入對方的版本。",
    changedUnread: "有人在這期間修改了辦公室，你的編輯沒有儲存，也無法讀取目前的清單。請再試一次。",
    keepMine: "保留我的編輯", loadTheirs: "載入對方的版本", keptMine: "已保留你的編輯。儲存時會取代對方在這期間的修改。",
    rateLimited: "儲存太頻繁，請一分鐘後再試。",
    failed: "辦公室沒有儲存（{0}）。", layoutKept: "它的座位與路徑會保留。",
    styleUnknown: "{0}（這裡沒有：以辦公桌顯示）",
    packs: "外觀包", packsLead: "用畫師的圖片畫出的風格。請把外觀包的 manifest.json 和所有 PNG 檔一起選取（或選整個資料夾）。",
    packsNone: "還沒有外觀包。", upload: "上傳外觀包", uploadFolder: "上傳資料夾", uploading: "上傳中…", uploaded: "已上傳外觀包「{0}」。",
    uploadFailed: "外觀包沒有上傳：{0}", noManifest: "檔案中沒有 manifest.json", badManifest: "manifest.json 不是 JSON",
    removePack: "刪除 {0}", removedPack: "已刪除外觀包「{0}」。", removeFailed: "外觀包沒有刪除（{0}）。",
  },
});
const te = (k, ...v) => t(`orge.${k}`, ...v);
export const MAX_OFFICES = 20;
const STYLES = ["pixel", "studio"];

/** A file's bytes as base64 (in slices: a large picture never goes through one huge string call). */
export function base64Of(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
/**
 * What an upload sends, from the files a person picked: { body } or { error }. A folder's files keep their path inside
 * it (its first part, the folder's own name, dropped), so a manifest naming "sprites/idle.png" finds it.
 */
export async function packUpload(files) {
  const named = [];
  for (const f of files) {
    const rel = typeof f.webkitRelativePath === "string" && f.webkitRelativePath ? f.webkitRelativePath.split("/").slice(1).join("/") : f.name;
    named.push({ name: rel || f.name, file: f });
  }
  const man = named.find((x) => x.name === "manifest.json") || named.find((x) => x.name.endsWith("/manifest.json") || x.file.name === "manifest.json");
  if (!man) return { error: te("noManifest") };
  let manifest;
  try { manifest = JSON.parse(await man.file.text()); } catch { return { error: te("badManifest") }; }
  const out = {};
  for (const x of named) {
    if (x === man || !/\.png$/i.test(x.name)) continue;
    out[x.name] = base64Of(new Uint8Array(await x.file.arrayBuffer()));
  }
  return { body: { manifest, files: out } };
}

function Packs({ packs, store }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const send = async (e) => {
    const input = e.target, files = [...(input.files || [])];
    if (!files.length) return;
    setBusy(true); setMsg(te("uploading"));
    try {
      const up = await packUpload(files);
      if (up.error) { setMsg(te("uploadFailed", up.error)); return; }
      const r = await store.uploadSkin(up.body);
      if (r.ok) { setMsg(""); toast(te("uploaded", (r.pack && r.pack.name) || up.body.manifest.id)); }
      else setMsg(te("uploadFailed", r.detail ? `${r.error} — ${r.detail}` : r.error));
    } finally { setBusy(false); try { input.value = ""; } catch { /* a read-only value */ } }
  };
  const remove = async (pk) => {
    setBusy(true); setMsg("");
    try {
      const r = await store.deleteSkin(pk.id);
      if (r.ok) toast(te("removedPack", pk.name)); else setMsg(te("removeFailed", r.error || r.status));
    } finally { setBusy(false); }
  };
  return html`<fieldset class="oe-packs oe-form" disabled=${busy}>
    <legend class="oe-label">${te("packs")}</legend>
    <p class="note">${te("packsLead")}</p>
    ${packs.length ? html`<ul class="oe-pack-list">${packs.map((pk) => html`<li key=${pk.id} class="oe-pack" data-pack=${pk.id}>
      <span>${pk.name}</span>${pk.name !== pk.id ? html` <span class="muted mono">${pk.id}</span>` : null}
      <button type="button" class="btn btn-sm btn-danger oe-pack-remove" onClick=${() => remove(pk)} aria-label=${te("removePack", pk.name)}>${te("remove")}</button></li>`)}</ul>`
      : html`<p class="note" id="oePacksNone">${te("packsNone")}</p>`}
    <label class="btn btn-sm oe-upload">${te("upload")}<input type="file" class="sr-only oe-upload-files" multiple accept=".json,.png,application/json,image/png" onChange=${send} /></label>
    <label class="btn btn-sm oe-upload">${te("uploadFolder")}<input type="file" class="sr-only oe-upload-dir" webkitdirectory="" multiple onChange=${send} /></label>
    ${msg ? html`<p class="note oe-pack-msg" role="status">${msg}</p>` : null}
  </fieldset>`;
}

/** A new office's id: unique among `taken`, the store's pattern ([A-Za-z0-9_-], never "auto"). */
export function newOfficeId(taken, rand = Math.random) {
  for (;;) {
    const id = `office-${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "0")}`;
    if (!taken.has(id)) return id;
  }
}
/** What is sent: the office as the host stores it (no empty layout key). */
export function officeForSave(o) {
  return { id: o.id, name: o.name.trim(), skin: o.skin, members: [...o.members], ...(o.layout ? { layout: o.layout } : {}), ...(o.overrides ? { overrides: o.overrides } : {}) };
}

function Members({ office, view, everyone, onChange }) {
  const picked = new Set(office.members);
  const toggle = (m) => onChange(picked.has(m) ? office.members.filter((x) => x !== m) : [...office.members, m]);
  return html`<div class="oe-members">
    ${view.teams.length ? html`<fieldset class="oe-group"><legend>${te("teams")}</legend>${view.teams.map((tm) => html`<label key=${`t:${tm.name}`} class="check">
      <input type="checkbox" checked=${picked.has(`team:${tm.name}`)} onChange=${() => toggle(`team:${tm.name}`)} /><span>${tm.name}</span></label>`)}</fieldset>` : null}
    <fieldset class="oe-group"><legend>${te("instances")}</legend>${everyone.map((n) => html`<label key=${n.name} class="check">
      <input type="checkbox" checked=${picked.has(n.name)} onChange=${() => toggle(n.name)} /><span>${nodeText(n).primary}</span></label>`)}</fieldset>
  </div>`;
}

/**
 * The editor: `offices`/`rev` as read; `view` the org chart (teams, instances); `store` createOfficeStore's;
 * `ask()` a stamp taken as a request is sent; `onSaved({ rev, offices }, stamp)` after a save or a re-read, returning
 * the snapshot in force (the page keeps a newer one it already shows: #2431 review); `current()` that snapshot now (null:
 * not known), read when the person chooses after a 409 (#2449 review); `onClose`.
 */
export function OfficeEditor({ offices, rev, view, store, packs = [], ask = () => 0, current = () => null, onSaved, onClose }) {
  // The draft and the rev it was read at go together (#2424 review): a list the stream re-reads meanwhile never moves
  // the rev under an older draft (a save would then overwrite what it never showed). After a 409 the person chooses
  // (#2431): keep their edits (on the newer rev: Save then replaces what was saved meanwhile, knowingly) or load the
  // newer list — never their draft thrown away unasked.
  const [base, setBase] = useState(() => ({ rev, draft: offices.map((o) => ({ ...o, members: [...o.members] })) }));
  const draft = base.draft;
  const setDraft = (next) => setBase((b) => ({ ...b, draft: typeof next === "function" ? next(b.draft) : next }));
  const [open, setOpen] = useState(null);                              // the office whose members are shown
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [conflict, setConflict] = useState(null);                      // after a 409: the newer list, until they choose
  const copy = (list) => list.map((o) => ({ ...o, members: [...o.members] }));
  // The choice takes the snapshot in force when it is made: the stream may have read a newer one since the 409 (#2449).
  const inForce = () => current() || conflict;
  const keepMine = () => { const now = inForce(); setBase((b) => ({ rev: now.rev, draft: b.draft })); setConflict(null); setMsg(te("keptMine")); };
  const loadTheirs = () => { const now = inForce(); setBase({ rev: now.rev, draft: copy(now.offices) }); setOpen(null); setConflict(null); setMsg(""); };
  const everyone = useMemo(() => { const m = new Map(); for (const n of [...view.top, ...view.teams.flatMap((tm) => tm.nodes), ...view.rest.nodes]) if (!m.has(n.name)) m.set(n.name, n); return [...m.values()]; }, [view]);
  const set = (id, patch) => setDraft((d) => d.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  const add = () => {
    if (draft.length >= MAX_OFFICES) return;
    const id = newOfficeId(new Set(draft.map((o) => o.id)));
    setDraft((d) => [...d, { id, name: te("newName"), skin: "pixel", members: [], layout: null }]);
    setOpen(id);
  };
  // Everything is frozen from Save until its answer (and a 409's re-read) is in (#2424 review): no edit made meanwhile
  // is lost when the dialog closes, and no second save starts on a draft about to be replaced.
  const save = async () => {
    if (busy || conflict) return;
    if (draft.some((o) => !o.name.trim())) { setMsg(te("nameNeeded")); return; }
    setBusy(true); setMsg("");
    try {
      const sent = ask();
      const r = await store.saveOffices(draft.map(officeForSave), base.rev);
      if (r.ok) { toast(te("saved")); onSaved({ rev: r.rev, offices: r.offices }, sent); onClose(); return; }
      if (r.status === 409) {
        const reread = ask();
        const fresh = await store.offices();
        // The snapshot in force: this re-read, or a newer one the page read meanwhile. The draft stays as it is.
        const kept = fresh ? onSaved(fresh, reread) || fresh : null;
        if (kept) setConflict({ rev: kept.rev, offices: kept.offices });
        setMsg(kept ? te("changed") : te("changedUnread"));
        return;
      }
      setMsg(r.status === 429 ? te("rateLimited") : te("failed", r.error || r.status));
    } finally { setBusy(false); }
  };
  const actions = html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${te("cancel")}</button>
    <button type="button" class="btn btn-primary" id="oeSave" onClick=${save} disabled=${busy || !!conflict}>${te("save")}</button>`;
  return html`<${Dialog} title=${te("title")} onClose=${onClose} actions=${actions} busy=${busy} wide=${true}>
    <p class="note">${te("lead")}</p>
    <fieldset class="oe-form" disabled=${busy}>
    ${draft.length ? null : html`<p class="note" id="oeNone">${te("none")}</p>`}
    <ul class="oe-list">${draft.map((o) => html`<li key=${o.id} class="oe-row" data-office=${o.id}>
      <div class="oe-head">
        <label class="oe-field"><span class="oe-label">${te("name")}</span>
          <input type="text" class="oe-name" maxlength="60" value=${o.name} onInput=${(e) => set(o.id, { name: e.target.value })} /></label>
        <label class="oe-field"><span class="oe-label">${te("styleLabel")}</span>
          <select class="tb-select oe-style" value=${o.skin} onChange=${(e) => set(o.id, { skin: e.target.value })}>
            ${STYLES.map((s) => html`<option key=${s} value=${s}>${t(`orgo.style_${s}`)}</option>`)}
            ${packs.map((pk) => html`<option key=${`pack:${pk.id}`} value=${pk.id}>${pk.name}</option>`)}
            ${STYLES.includes(o.skin) || packs.some((pk) => pk.id === o.skin) ? null : html`<option key=${o.skin} value=${o.skin}>${te("styleUnknown", o.skin)}</option>`}</select></label>
        <button type="button" class="btn btn-sm oe-members-btn" aria-expanded=${open === o.id ? "true" : "false"} onClick=${() => setOpen(open === o.id ? null : o.id)}>
          ${te("members")}: ${o.members.length ? te("membersN", o.members.length) : te("everyone")}</button>
        <button type="button" class="btn btn-sm btn-danger oe-remove" onClick=${() => { setDraft((d) => d.filter((x) => x.id !== o.id)); if (open === o.id) setOpen(null); }}>${te("remove")}</button>
      </div>
      ${o.layout ? html`<p class="note">${te("layoutKept")}</p>` : null}
      ${open === o.id ? html`<${Members} office=${o} view=${view} everyone=${everyone} onChange=${(members) => set(o.id, { members })} />` : null}
    </li>`)}</ul>
    <button type="button" class="btn btn-sm" id="oeAdd" onClick=${add} disabled=${draft.length >= MAX_OFFICES}>${te("add")}</button>
    ${draft.length >= MAX_OFFICES ? html`<span class="note">${te("tooMany", MAX_OFFICES)}</span>` : null}
    </fieldset>
    ${msg ? html`<p class="note oe-msg" role="status">${msg}</p>` : null}
    ${store.uploadSkin ? html`<${Packs} packs=${packs} store=${store} />` : null}
    ${conflict ? html`<div class="oe-conflict">
      <button type="button" class="btn btn-sm" id="oeKeepMine" onClick=${keepMine} disabled=${busy}>${te("keepMine")}</button>
      <button type="button" class="btn btn-sm" id="oeLoadTheirs" onClick=${loadTheirs} disabled=${busy}>${te("loadTheirs")}</button>
    </div>` : null}
  </${Dialog}>`;
}
