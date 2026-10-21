// #2347: one save model for Settings. A section's edits are its draft from the first keystroke: the draft is kept while
// the person moves between sections, staged as soon as it differs from what is saved (the sticky bar counts it and offers
// Save), and dropped on Save or Discard. Nothing is written until Save.
import { useEffect, useMemo, useState } from "/assets/app-html.js";
import { sameValue } from "./settings-model.js";

// #2347: over the temporary public link the Fleet sections are read-only (the switch lives with the app store: the
// shell's restart banner follows it too).
export { FLEET_READ_ONLY_OVER_PUBLIC_LINK, fleetReadOnly, overPublicLink } from "/assets/app-store.js";

/** The fields of `form` that differ from `saved` (a draft is only what was edited). */
export function editsOf(form, saved) {
  const out = {};
  for (const k of Object.keys(form)) if (!sameValue(form[k], saved[k])) out[k] = form[k];
  return out;
}

/**
 * A section's form, kept in the panel's drafts by `key` while it differs from what is saved: leaving the section and
 * coming back shows the same edits (they are still staged). `saved` builds the form from the saved configuration;
 * `init` (default: `saved`) is the form a section starts from when no draft is kept.
 *
 * #2367 review: the draft is the edited fields only, put back over what is saved when the section is shown again — a
 * field never touched follows the configuration as it is now (another admin's change since), never a stale copy of it.
 */
export function useDraft(ctx, key, saved, init = saved) {
  const base = useMemo(saved, []);
  const [form, setForm] = useState(() => (ctx.drafts && ctx.drafts.has(key) ? { ...base, ...ctx.drafts.get(key) } : init()));
  useEffect(() => { keepDraft(ctx, key, editsOf(form, base), form); }, [form]);
  return [form, setForm];
}

/**
 * Keep `edits` as the draft `key` (none: no draft). #2367 review: while a Save runs, a field that Save is writing and
 * the form has since put back to what was saved before is an edit too — once the Save lands, what is saved is the new
 * value, and the person's last word was the old one.
 */
export function keepDraft(ctx, key, edits, form) {
  if (!ctx.drafts) return;
  const writing = typeof ctx.savingDrafts === "function" ? ctx.savingDrafts() : null;
  const sent = writing && writing.get(key);
  if (sent) for (const k of Object.keys(sent)) if (!(k in edits)) edits[k] = form[k];
  if (Object.keys(edits).length) ctx.drafts.set(key, edits);
  else ctx.drafts.delete(key);
}

/**
 * Bring the staged change `key` in line with a section's draft: staged (quietly — the bar says it) when there is one,
 * unstaged when the draft equals what is saved. An invalid draft is staged as `{ label, invalid }` with no request: it
 * counts as unsaved, and Save waits until it is fixed (its message is shown at the field).
 */
export function syncStage(ctx, key, change) {
  if (change) ctx.stage(key, change, true);
  else ctx.unstage(key);
}
