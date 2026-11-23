// Padding is part of the input surface, not a selectable document text node.
// Leave controls and the textarea itself to the browser (selection, IME, menus).
export function focusComposerPadding(event, field) {
  if (!field || field.disabled || event.defaultPrevented || event.isPrimary === false || event.button > 0) return;
  if (event.target?.closest?.("textarea, input, button, select, a, [contenteditable='true'], [role='button']")) return;
  event.preventDefault();
  field.ownerDocument?.getSelection?.()?.removeAllRanges();
  field.focus();
}
