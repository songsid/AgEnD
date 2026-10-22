// Fleet → Org chart → Office: the offices people keep on the host, edited (#2399 carry: the write surface's minimal
// editor). An admin session adds an office, renames it, chooses its style (Desks / Studio), picks who is in it (whole
// teams, or one instance at a time; none: everyone) and deletes one — then saves the whole list with the rev it read
// (PUT /ui/offices; a change made meanwhile is a 409: read again, nothing overwritten). A stored office's layout (seats,
// paths) is kept as it is; drawing one is for a later editor. Never offered to a guest, the public link or a read-only
// session (the host refuses them too).
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
    changed: "Someone changed the offices meanwhile. Your edit was not saved: the current list is shown again.", rateLimited: "Too many saves. Try again in a minute.",
    failed: "The offices were not saved ({0}).", layoutKept: "Its seats and paths are kept.",
  },
  "zh-TW": {
    edit: "編輯辦公室", title: "辦公室", lead: "這個 fleet 的每個人在辦公室檢視中都會看到這些辦公室。沒有選任何成員的辦公室會顯示全部。",
    add: "新增辦公室", newName: "新辦公室", name: "名稱", styleLabel: "風格", members: "成員", membersN: "已選 {0} 個", everyone: "全部",
    teams: "Team", instances: "Instance", remove: "刪除", save: "儲存", cancel: "取消", saved: "辦公室已儲存。",
    none: "還沒有辦公室：辦公室檢視會顯示整個 fleet。", nameNeeded: "每個辦公室都需要名稱。", tooMany: "最多 {0} 個辦公室。",
    changed: "有人在這期間修改了辦公室。你的編輯沒有儲存，已重新顯示目前的清單。", rateLimited: "儲存太頻繁，請一分鐘後再試。",
    failed: "辦公室沒有儲存（{0}）。", layoutKept: "它的座位與路徑會保留。",
  },
});
const te = (k, ...v) => t(`orge.${k}`, ...v);
export const MAX_OFFICES = 20;
const STYLES = ["pixel", "studio"];

/** A new office's id: unique among `taken`, the store's pattern ([A-Za-z0-9_-], never "auto"). */
export function newOfficeId(taken, rand = Math.random) {
  for (;;) {
    const id = `office-${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "0")}`;
    if (!taken.has(id)) return id;
  }
}
/** What is sent: the office as the host stores it (no empty layout key). */
export function officeForSave(o) {
  return { id: o.id, name: o.name.trim(), skin: o.skin, members: [...o.members], ...(o.layout ? { layout: o.layout } : {}) };
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
 * the snapshot in force (the page keeps a newer one it already shows: #2431 review); `onClose`.
 */
export function OfficeEditor({ offices, rev, view, store, ask = () => 0, onSaved, onClose }) {
  // The draft and the rev it was read at go together (#2424 review): a list the stream re-reads meanwhile never moves
  // the rev under an older draft (a save would then overwrite what it never showed). Only a 409's re-read replaces both.
  const [base, setBase] = useState(() => ({ rev, draft: offices.map((o) => ({ ...o, members: [...o.members] })) }));
  const draft = base.draft;
  const setDraft = (next) => setBase((b) => ({ ...b, draft: typeof next === "function" ? next(b.draft) : next }));
  const [open, setOpen] = useState(null);                              // the office whose members are shown
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
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
    if (busy) return;
    if (draft.some((o) => !o.name.trim())) { setMsg(te("nameNeeded")); return; }
    setBusy(true); setMsg("");
    try {
      const sent = ask();
      const r = await store.saveOffices(draft.map(officeForSave), base.rev);
      if (r.ok) { toast(te("saved")); onSaved({ rev: r.rev, offices: r.offices }, sent); onClose(); return; }
      if (r.status === 409) {
        const reread = ask();
        const fresh = await store.offices();
        // The draft and its rev from the snapshot in force: this re-read, or a newer one the page read meanwhile.
        const kept = fresh ? onSaved(fresh, reread) || fresh : null;
        if (kept) setBase({ rev: kept.rev, draft: kept.offices.map((o) => ({ ...o, members: [...o.members] })) });
        setMsg(te("changed"));
        return;
      }
      setMsg(r.status === 429 ? te("rateLimited") : te("failed", r.error || r.status));
    } finally { setBusy(false); }
  };
  const actions = html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${te("cancel")}</button>
    <button type="button" class="btn btn-primary" id="oeSave" onClick=${save} disabled=${busy}>${te("save")}</button>`;
  return html`<${Dialog} title=${te("title")} onClose=${onClose} actions=${actions} busy=${busy} wide=${true}>
    <p class="note">${te("lead")}</p>
    <fieldset class="oe-form" disabled=${busy}>
    ${draft.length ? null : html`<p class="note" id="oeNone">${te("none")}</p>`}
    <ul class="oe-list">${draft.map((o) => html`<li key=${o.id} class="oe-row" data-office=${o.id}>
      <div class="oe-head">
        <label class="oe-field"><span class="oe-label">${te("name")}</span>
          <input type="text" class="oe-name" maxlength="60" value=${o.name} onInput=${(e) => set(o.id, { name: e.target.value })} /></label>
        <label class="oe-field"><span class="oe-label">${te("styleLabel")}</span>
          <select class="tb-select oe-style" value=${STYLES.includes(o.skin) ? o.skin : "pixel"} onChange=${(e) => set(o.id, { skin: e.target.value })}>
            ${STYLES.map((s) => html`<option key=${s} value=${s}>${t(`orgo.style_${s}`)}</option>`)}</select></label>
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
  </${Dialog}>`;
}
