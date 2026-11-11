// The "Agent instructions" field of an agent's Basic info — the agent's `systemPrompt` (what Settings used to call "System
// prompt"; same key, same place in what the AI is told), edited as Markdown with an Edit / Preview switch. The preview is
// the chat's own Markdown renderer (chat-thread.js drawMarkdown → chat-render.js: it escapes the text first, so nothing
// typed here becomes markup); nothing is rendered by this file. A `file:` reference stays one: the preview lists the
// file instead of reading it (the daemon reads it when the agent starts).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import "/assets/chat-render.js";
import { drawMarkdown } from "/assets/chat-thread.js";
import { pt } from "./agent-page-strings.js";

/** The most the editor lets Save write, in characters. */
export const INSTRUCTIONS_MAX_CHARS = 24000;
/**
 * Codex reads at most 32 KiB of AGENTS.md in total (backend/codex.ts) and AgEnD's own guidance already takes about 12 KiB
 * of it, so past this many bytes of instructions the end — they come last — may be cut.
 */
export const CODEX_AGENTS_MD_BYTES = 32 * 1024;
export const CODEX_NOTE_BYTES = 16 * 1024;

const utf8Bytes = (text) => (typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length);
/** What the counter shows: characters (what the limit counts) and bytes (what Codex counts). */
export const instructionsSize = (text) => ({ chars: text.length, bytes: utf8Bytes(text) });
const fmt = (n) => Number(n).toLocaleString("en-US");

/**
 * The parts of a systemPrompt, as prompt-file-ref.ts systemPromptParts reads them: comma-separated only when at least one
 * part is a `file:` reference ("file:role.md, file:rules.md", inline text allowed between them); otherwise the whole value
 * is one inline text, commas and all. (tests/agent-instructions-ui.test.ts keeps the two equal.)
 */
export function promptParts(value) {
  const parts = value.split(",").map((part) => part.trim());
  return parts.some((part) => part.startsWith("file:")) ? parts : [value];
}
const hasFileRef = (value) => promptParts(value).some((part) => part.startsWith("file:"));

function Markdown({ text }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) drawMarkdown(ref.current, text); }, [text]);
  return html`<div ref=${ref} class="pv-code pv-md" data-instructions-preview />`;
}

/** The preview: inline text through the chat's Markdown renderer; a `file:` part as the file it names. */
function InstructionsPreview({ text }) {
  if (!text.trim()) return html`<p class="note">${pt("instrPreviewEmpty")}</p>`;
  if (!hasFileRef(text)) return html`<${Markdown} text=${text} />`;
  return html`<div class="instructions-parts">${promptParts(text).filter(Boolean).map((part, i) => part.startsWith("file:")
    ? html`<p key=${i} class="note" data-instructions-file><code>${part.slice(5).trim()}</code> — ${pt("instrFileRead")}</p>`
    : html`<${Markdown} key=${i} text=${part} />`)}</div>`;
}

/** `id`: the textarea's id (the field's label points at it). `value`/`onChange`: the draft. `saved`: the value on disk (an over-long one already there is not an error until it is edited). */
export function InstructionsField({ id, value, onChange, saved }) {
  const [mode, setMode] = useState("edit");
  const { chars, bytes } = instructionsSize(value);
  const over = chars > INSTRUCTIONS_MAX_CHARS && value !== saved;
  const files = hasFileRef(value);
  const codexNear = !files && bytes > CODEX_NOTE_BYTES;
  const modeBtn = (m, label) => html`<button type="button" class=${`btn btn-sm${mode === m ? " btn-primary" : ""}`} aria-pressed=${mode === m ? "true" : "false"} data-instructions-mode=${m}
    onClick=${() => setMode(m)}>${label}</button>`;
  return html`<div class="instructions-field">
    <div class="seg-inline" role="group" aria-label=${pt("lbl_instructions")}>${modeBtn("edit", pt("instrEdit"))}${modeBtn("preview", pt("instrPreview"))}</div>
    ${mode === "edit"
      ? html`<textarea id=${id} rows="12" spellcheck=${false} aria-describedby=${`${id}-size`} class=${over ? "invalid" : ""} placeholder=${pt("instrPlaceholder")} value=${value}
          onInput=${(e) => onChange(e.target.value)} />`
      : html`<${InstructionsPreview} text=${value} />`}
    <p class=${`note${over ? " feedback error" : ""}`} id=${`${id}-size`} role=${over ? "alert" : undefined} data-instructions-size>${over ? pt("instrTooLong", fmt(chars), fmt(INSTRUCTIONS_MAX_CHARS)) : pt("instrSize", fmt(chars), fmt(INSTRUCTIONS_MAX_CHARS), fmt(bytes))}</p>
    <p class=${`note${codexNear ? " feedback warning" : ""}`} data-instructions-codex>${pt(files ? "instrCodexFiles" : codexNear ? "instrCodexNear" : "instrCodex")}</p>
  </div>`;
}
