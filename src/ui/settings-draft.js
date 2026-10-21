// #2347: one save model for Settings. A section's edits are its draft from the first keystroke: the draft is kept while
// the person moves between sections, staged as soon as it differs from what is saved (the sticky bar counts it and offers
// Save), and dropped on Save or Discard. Nothing is written until Save.
import { useEffect, useMemo, useState } from "/assets/app-html.js";
import { sameValue } from "./settings-model.js";

// #2347: over the temporary public link the Fleet sections are read-only (the switch lives with the app store: the
// shell's restart banner follows it too).
export { FLEET_READ_ONLY_OVER_PUBLIC_LINK, fleetReadOnly, overPublicLink } from "/assets/app-store.js";

/**
 * A section's form, kept in the panel's drafts by `key` while it differs from what is saved: leaving the section and
 * coming back shows the same edits (they are still staged). `init` builds the form from the saved configuration.
 */
export function useDraft(ctx, key, init) {
  const saved = useMemo(init, []);
  const [form, setForm] = useState(() => (ctx.drafts && ctx.drafts.has(key) ? ctx.drafts.get(key) : saved));
  // Only a form that differs from what is saved is a draft: one equal to it (nothing edited, or a mount just before
  // the configuration is read again after a Save) is never kept to come back later.
  useEffect(() => {
    if (!ctx.drafts) return;
    if (sameValue(form, saved)) ctx.drafts.delete(key);
    else ctx.drafts.set(key, form);
  }, [form]);
  return [form, setForm];
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
