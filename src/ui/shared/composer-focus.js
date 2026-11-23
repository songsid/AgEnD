// Padding is part of the input surface, not a selectable document text node.
// Leave controls and the textarea itself to the browser (selection, IME, menus).
export function focusComposerPadding(event, field) {
  if (!field || field.disabled || event.defaultPrevented || event.isPrimary === false || event.button > 0) return;
  // A touch drag must keep scrolling. Only its eventual click focuses; a pan has none.
  if (event.type === "pointerdown" && event.pointerType && event.pointerType !== "mouse") return;
  const control = event.target?.closest?.("textarea, input, button, select, a, label, summary, [contenteditable], [role='button'], [role='link'], [tabindex], .cmd-card, .pending-files, .reply-bar");
  // The shell's focusable main ancestor is outside this strip, not a control in it.
  if (control && (!event.currentTarget || event.currentTarget.contains(control))) return;
  event.preventDefault();
  field.ownerDocument?.getSelection?.()?.removeAllRanges();
  field.focus();
}

// This listener belongs to the reserved dock strip, never the message list.
export function focusComposerStrip(event) {
  focusComposerPadding(event, event.currentTarget?.querySelector(".composer-box .composer textarea"));
}
