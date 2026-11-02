// Product identity for CLI selectors. Callers own availability filtering and display labels.
import { html } from "/assets/app-html.js";
import { Icon } from "/assets/ui-icons.js";
import { Menu } from "/assets/ui-menu.js";
import { ProviderMark } from "./provider-marks.js";

const PRODUCTS = {
  "claude-code": { label: "Claude Code", mark: "claude" },
  claude: { label: "Claude Code", mark: "claude" },
  codex: { label: "Codex", mark: "openai" },
  antigravity: { label: "Antigravity", mark: "antigravity" },
  grok: { label: "Grok", mark: "grok" },
  "kiro-cli": { label: "Kiro", mark: "kiro" },
  kiro: { label: "Kiro", mark: "kiro" },
  opencode: { label: "OpenCode" },
  muse: { label: "Muse" },
};

export function cliLabel(id) { return PRODUCTS[id]?.label || id || ""; }

export function CliProductMark({ id, size = 20 }) {
  const mark = PRODUCTS[id]?.mark;
  return html`<span class="cli-product-mark" data-cli=${id || "default"} aria-hidden="true">${mark
    ? html`<${ProviderMark} provider=${mark} size=${size} />`
    : html`<${Icon} name="code" size=${size} />`}</span>`;
}

/** choices: [{ value, label, disabled?, description? }]; value is a controlled CLI id or the empty fleet default. */
export function CliPicker({ value = "", onChange, choices = [], label, disabled = false }) {
  const selected = choices.find(choice => choice.value === value);
  const selectedLabel = selected?.label ?? cliLabel(value);
  const accessibleLabel = label ? `${label}: ${selectedLabel}` : selectedLabel;
  const trigger = html`<${CliProductMark} id=${value} /><span class="cli-picker-value">${selectedLabel}</span><span class="cli-picker-chevron"><${Icon} name="chevron" size=${16} /></span>`;
  const items = choices.map(choice => ({
    key: choice.value,
    checked: choice.value === value,
    disabled: !!choice.disabled,
    label: html`<span class="cli-picker-option"><${CliProductMark} id=${choice.value} /><span class="cli-picker-copy"><span class="cli-picker-name">${choice.label}</span>${choice.description ? html`<small class="cli-picker-description">${choice.description}</small>` : null}</span></span>`,
    onSelect: () => onChange?.(choice.value),
  }));
  return html`<${Menu} items=${items} label=${accessibleLabel} trigger=${trigger} triggerClass="cli-picker-trigger" cls="cli-picker" disabled=${disabled} fit=${true} />`;
}
