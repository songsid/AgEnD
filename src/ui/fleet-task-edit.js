// Editing a card in place (Fleet › Tasks › a card's page), as issue trackers do: text edits where it is read — a click
// opens it, leaving the box or Ctrl+Enter saves, Esc drops the edit — and a property is a chip that opens a menu, the
// choice saving at once. No "Cancel / Save" pair per field. Every save still carries the version the edit started from,
// so an agent's newer write is caught (409): the edit then stays open with a line saying so, and only Ctrl+Enter or
// "Overwrite" sends it over the newer card on purpose — leaving the box never overwrites silently.
// No style attribute anywhere (the CSP).
import { html, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { Menu } from "/assets/ui-menu.js";
import { MdBody, commentHtml } from "./fleet-task-md.js";

/**
 * Which version an edit started from: a save sends it, so an agent's newer write is caught (409). After a conflict
 * the next save of the same draft overwrites on purpose (null: no check). After a save went through while more was
 * typed, the text kept in the box is pinned to the version that save itself produced (`pin`): the next save sends
 * that exact version, whatever the page reads in between, so a write by someone else after it is still a conflict.
 */
export function useEditBase(version) {
  const [base, setBase] = useState(version);
  const pinned = useRef(undefined);
  return {
    start: () => { pinned.current = undefined; setBase(version); },
    current: () => (pinned.current !== undefined ? pinned.current : base === undefined ? version : base),
    afterSave: (outcome) => { if (outcome === "conflict") { pinned.current = undefined; setBase(null); } },
    pin: (savedVersion) => { pinned.current = savedVersion; },
  };
}

/** Focus moves into an edit box as it opens (before the next key: Esc must reach the box, not the page). */
export function useAutoFocus(open) {
  const ref = useRef(null);
  useLayoutEffect(() => { if (open && ref.current) ref.current.focus(); }, [open]);
  return ref;
}

/** The whole window lost the focus (the person switched away): the edit stays open, nothing is saved by that. */
const windowAway = () => typeof document !== "undefined" && typeof document.hasFocus === "function" && !document.hasFocus();

/**
 * One text edited in place. `onSave(next, base)` resolves "ok", "conflict" or "error" (the page toasts the refusal), or
 * `{ outcome, version }`, where `version` is the one the card has because of that save (what the answer to the write said).
 * `phase`: "idle", "saving", "conflict" (the card changed meanwhile: Ctrl+Enter / overwrite() sends it anyway) or
 * "failed" (not saved: leaving the box or Ctrl+Enter tries again).
 */
export function useInlineEdit({ value, version, onSave, valid = () => true, prepare = (d) => d.trim(), same = (d, v) => d === v, emptyDrops = false, open = false, onClose }) {
  // `open`: the edit is already open as it first draws (a field a person asked for with its "+ Add" button). `onClose`: the
  // edit has ended — saved, dropped or nothing changed — so a field that opened empty can fold back into its button.
  const [draft, setDraft] = useState(open ? value : null);
  const [phase, setPhase] = useState("idle");
  const base = useEditBase(version);
  const ref = useAutoFocus(draft !== null);
  const dropped = useRef(false);   // Esc: the blur that follows must not save
  const busy = useRef(false);
  // What the box holds now, whatever render a pending save was started in; the box left while a save was pending.
  const draftNow = useRef(draft);
  draftNow.current = draft;
  const leftWhileSaving = useRef(false);
  const again = useRef(null);      // the latest `commit`, for the save that follows a save
  const start = (text = value) => { dropped.current = false; leftWhileSaving.current = false; setPhase("idle"); setDraft(text); base.start(); };
  const close = () => { setDraft(null); setPhase("idle"); if (onClose) onClose(); };
  const cancel = () => { dropped.current = true; close(); };
  async function commit() {
    if (draft === null || busy.current) return;
    const next = prepare(draft);
    if (same(next, value) || (emptyDrops && next === "")) { close(); return; }   // nothing changed, or nothing left: as it was
    if (!valid(next)) return;
    busy.current = true;
    leftWhileSaving.current = false;
    setPhase("saving");
    let outcome = "error", savedVersion;
    try {
      const answer = await onSave(next, base.current());
      if (answer && typeof answer === "object") { outcome = answer.outcome; savedVersion = answer.version; } else outcome = answer;
    } finally { busy.current = false; }
    if (outcome === "ok") {
      const now = draftNow.current;
      if (now === null) return;                          // dropped (Esc) while it saved: the edit is over
      if (prepare(now) === next) { close(); return; }    // what was sent is what the box holds: done
      // More was typed while it saved: that text is newer than what went through, so it stays — the box stays open on it.
      // Its save is on the version THIS save produced, not on whatever the page reads later: a write by someone else after
      // this one is then a conflict, not something it silently overwrites. (An answer that did not say its version leaves the
      // base the edit started from, which the card has left behind: the kept text then meets a conflict, never a silent overwrite.)
      if (savedVersion !== undefined && savedVersion !== null) base.pin(savedVersion);
      // Had the box been left meanwhile, leaving it saves it now.
      setPhase("idle");
      if (leftWhileSaving.current && again.current) { leftWhileSaving.current = false; void again.current(); }
      return;
    }
    base.afterSave(outcome);
    setPhase(outcome === "conflict" ? "conflict" : "failed");
  }
  again.current = commit;
  /** Leaving the box saves — but not after Esc, not while a conflict waits for an explicit answer, not on a window switch. */
  const blur = () => {
    if (dropped.current) { dropped.current = false; return; }
    if (phase === "saving") { if (!windowAway()) leftWhileSaving.current = true; return; }   // what is typed on meanwhile is saved when this save is over
    if (phase === "conflict" || windowAway()) return;
    void commit();
  };
  return { draft, setDraft, phase, ref, start, cancel, commit, blur };
}

/** The keys of an edit box: Esc drops it (and stays the box's: it never reaches the page), Ctrl/⌘+Enter saves, Enter too when single-line. */
export function editKeys(e, edit, singleLine = false) {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); edit.cancel(); return; }
  if (e.key === "Enter" && (singleLine ? !e.shiftKey && !e.isComposing : e.ctrlKey || e.metaKey)) { e.preventDefault(); void edit.commit(); }
}

/** Under an edit box: what is happening to it, in words (saving, not saved, changed meanwhile with its two answers). */
function EditStatus({ edit, counter = null, hint }) {
  return html`<div class="tc-edit-bar" aria-live="polite">
    ${counter}
    ${edit.phase === "saving" ? html`<span class="muted">${t("taskcard.saving")}</span>`
      : edit.phase === "failed" ? html`<span class="err">${t("taskcard.notSaved")}</span>`
      : edit.phase === "conflict" ? html`<span class="err">${t("taskcard.conflictInline")}</span>
        <button type="button" class="btn btn-primary btn-sm" onClick=${() => void edit.commit()}>${t("taskcard.overwrite")}</button>
        <button type="button" class="btn btn-sm" onClick=${edit.cancel}>${t("taskcard.discard")}</button>`
      : html`<span class="muted">${hint}</span>`}
  </div>`;
}

/** The title: a heading that is an input when clicked; Enter or leaving saves, Esc drops. */
export function InlineTitle({ value, version, limit, onSave }) {
  const edit = useInlineEdit({ value, version, onSave, emptyDrops: true });
  if (edit.draft === null) {
    return html`<button type="button" class="tc-title" title=${t("taskcard.clickToEdit")} onClick=${() => edit.start()}>${value}</button>`;
  }
  return html`<div class="tc-title-edit">
    <input class="tc-title-input" value=${edit.draft} maxlength=${limit} ref=${edit.ref} aria-label=${t("tasks.title")}
      onInput=${(e) => edit.setDraft(e.target.value)} onBlur=${edit.blur} onKeyDown=${(e) => editKeys(e, edit, true)} />
    ${edit.phase === "idle" ? null : html`<${EditStatus} edit=${edit} hint="" />`}
  </div>`;
}

/** A longer text: a block that opens as a box on a click. Its own limit counts as you type. */
export function EditableText({ value, limit, placeholder, version, readOnly = false, onSave, open = false, onClose }) {
  const edit = useInlineEdit({ value, version, onSave, valid: (v) => [...v].length <= limit, open: open && !readOnly, onClose });
  // a text that is there is read as Markdown (the chat's renderer: lines, lists, headings, code blocks, links; escaped first).
  // The stored text is the same; the box that edits it is still plain text.
  const md = value ? commentHtml(value) : null;
  if (readOnly) return md ? html`<${MdBody} body=${md} cls="tc-text tc-md tl-body md" />` : html`<p class=${`tc-text${value ? "" : " empty"}`}>${value || "—"}</p>`;
  if (edit.draft === null) {
    // A click on the text (not on a link or a code block's buttons) opens the box, as it always did; the button is the keyboard's way in.
    if (md) return html`<div class="tc-md-wrap"><${MdBody} body=${md} cls="tc-text tc-md tl-body md" title=${t("taskcard.clickToEdit")} onActivate=${() => edit.start()} />
      <button type="button" class="btn btn-ghost btn-sm tc-md-edit" onClick=${() => edit.start()}>${t("taskcard.edit")}</button></div>`;
    return html`<button type="button" class=${`tc-text${value ? "" : " empty"}`} title=${t("taskcard.clickToEdit")} onClick=${() => edit.start()}>${value || placeholder || t("taskcard.empty")}</button>`;
  }
  const length = [...edit.draft].length;
  return html`<div class="tc-edit">
    <textarea rows=${Math.min(12, Math.max(3, edit.draft.split("\n").length + 1))} value=${edit.draft} ref=${edit.ref} placeholder=${placeholder}
      onInput=${(e) => edit.setDraft(e.target.value)} onBlur=${edit.blur} onKeyDown=${(e) => editKeys(e, edit)}></textarea>
    <${EditStatus} edit=${edit} hint=${t("taskcard.editHint")}
      counter=${html`<span class=${`tc-counter${length > limit ? " over" : ""}`}>${length}/${limit}</span>`} />
  </div>`;
}

/** The definition of done: ticks save at once; "Edit the list" opens one item per line, saved like any text. */
export function Checklist({ card, readOnly = false, limit, onToggle, onReplace, open = false, onClose }) {
  const items = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);
  const current = card.acceptance.map((a) => a.text);
  const edit = useInlineEdit({
    value: current.join("\n"), version: card.version, prepare: (d) => items(d).join("\n"), open: open && !readOnly, onClose,
    valid: (v) => (v === "" ? true : items(v).length <= limit),
    onSave: (v, base) => onReplace(items(v), base),
  });
  // One tick at a time: each sends the version it saw, so a second tick before the first is saved would be refused.
  // The tick being saved shows as asked meanwhile (the box does not flick back until the card is read again).
  const [ticking, setTicking] = useState(null);
  const tick = async (n, done) => { setTicking({ n, done }); try { await onToggle(n, done); } finally { setTicking(null); } };
  if (edit.draft !== null) {
    const n = items(edit.draft).length;
    return html`<div class="tc-edit">
      <textarea rows=${Math.max(3, n + 1)} value=${edit.draft} ref=${edit.ref} aria-label=${t("taskcard.editList")}
        onInput=${(e) => edit.setDraft(e.target.value)} onBlur=${edit.blur} onKeyDown=${(e) => editKeys(e, edit)}></textarea>
      <${EditStatus} edit=${edit} hint=${t("taskcard.onePerLine")}
        counter=${html`<span class=${`tc-counter${n > limit ? " over" : ""}`}>${t("taskcard.items", n, limit)}</span>`} />
    </div>`;
  }
  if (!card.acceptance.length) return readOnly ? html`<p class="tc-text empty">—</p>` : html`<button type="button" class="tc-text empty" onClick=${() => edit.start("")}>${t("taskcard.checklistEmpty")}</button>`;
  return html`<ul class="tc-checklist">${card.acceptance.map((a, i) => html`<li key=${`${i}-${a.text}`}><label class="tb-check">
      <input type="checkbox" checked=${ticking && ticking.n === i + 1 ? ticking.done : a.done} disabled=${readOnly || !!ticking} onChange=${() => void tick(i + 1, !a.done)} /><span class=${a.done ? "done" : ""}>${a.text}</span></label></li>`)}</ul>
    ${readOnly ? null : html`<button type="button" class="btn btn-ghost btn-sm tc-editlist" onClick=${() => edit.start(current.join("\n"))}>${t("taskcard.editList")}</button>`}`;
}

/** A line to add to a list, by its title and Enter (a sub task). */
export function QuickAdd({ placeholder, limit, onAdd }) {
  const [title, setTitle] = useState("");
  const busy = useRef(false);
  return html`<input class="tc-quick-add" value=${title} placeholder=${placeholder} aria-label=${placeholder} maxlength=${limit}
    onInput=${(e) => setTitle(e.target.value)}
    onKeyDown=${async (e) => {
      if (e.key !== "Enter" || e.isComposing || !title.trim() || busy.current) return;
      e.preventDefault();
      busy.current = true;
      try { if ((await onAdd(title.trim())) === "ok") setTitle(""); } finally { busy.current = false; }
    }} />`;
}

// ── Properties: a chip that opens a menu ──────────────────────────

/**
 * A property as a chip: its current value on a button that opens a menu of the choices; a choice saves at once (the
 * page's `save`). `items` are Menu items — { key, label, checked, onSelect, disabled?, title? }, a heading line
 * ({ heading: true }) or a plain action. Without `items` (read only, or no choice to make) it is the value as text.
 */
export function PropChip({ label, value, items = null, tone = "", cls = "" }) {
  if (!items || !items.length) return html`<span class=${`tc-value tp-static${tone ? ` tone-${tone}` : ""}`}>${value}</span>`;
  return html`<${Menu} cls=${`tp-chip-menu ${cls}`.trim()} label=${label} fit trigger=${html`<span class="tp-chip-value">${value}</span><${Icon} name="chevron" size=${14} />`}
    triggerClass=${`tp-chip${tone ? ` tone-${tone}` : ""}`} items=${items} />`;
}
