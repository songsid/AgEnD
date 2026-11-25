// Markdown on a card: the chat's own renderer (AgendChatRender.renderMarkdown — it escapes the text FIRST and then adds only
// a fixed set of tags, so nothing a person or an agent writes becomes a tag, an attribute or a script; links are http(s) / mailto only),
// drawn for a comment, a progress note, and — in reading mode — a card's text fields (goal, scope, context, state, result, blocked reason).
// One module so the timeline, the card's fields and the files' previews draw it the same way, and its code blocks are decorated as the chat's.
import { html, useEffect, useRef } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import "/assets/chat-render.js";
import "/assets/chat-strings.js";

/** A comment's text as the chat draws a message (Markdown, escaped first); the plain text when the renderer is not there. */
export const commentHtml = (text) => {
  const r = globalThis.AgendChatRender;
  return r && typeof r.renderMarkdown === "function" ? { __html: r.renderMarkdown(text) } : null;
};

/** The chat's copy: the clipboard, else a hidden text area (a plain-http page has no clipboard API). */
async function copyText(text) {
  try { if (navigator.clipboard && globalThis.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall back */ }
  const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.className = "offscreen";
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}
export const storedWrap = () => { try { return localStorage.getItem("agend_code_wrap") === "1"; } catch { return false; } };

/**
 * Code blocks as the chat's thread draws them (chat-thread.js `decorateCode`, the same classes, so the same sheet styles them):
 * a header with the language, Wrap and Copy, and a block of more than CODE_FOLD_LINES lines folded until opened. Built from nodes.
 */
export function decorateCode(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  const doc = root.ownerDocument;
  const R = globalThis.AgendChatRender;
  const limit = R && Number.isFinite(R.CODE_FOLD_LINES) ? R.CODE_FOLD_LINES : 30;
  const lineCount = R && typeof R.lineCount === "function" ? R.lineCount : (c) => String(c).split("\n").length;
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.parentNode && pre.parentNode.classList && pre.parentNode.classList.contains("codeblock")) continue;
    const box = doc.createElement("div"); box.className = "codeblock";
    const head = doc.createElement("div"); head.className = "cb-head";
    const lang = doc.createElement("span"); lang.className = "cb-lang"; lang.textContent = pre.dataset.lang || "text";
    const wrap = doc.createElement("button"); wrap.type = "button"; wrap.className = "chip-btn"; wrap.dataset.act = "toggleWrap"; wrap.textContent = t("chat.wrap");
    const copy = doc.createElement("button"); copy.type = "button"; copy.className = "chip-btn"; copy.dataset.act = "copyCode"; copy.textContent = t("chat.copy");
    head.append(lang, wrap, copy);
    pre.replaceWith(box); box.append(head, pre);
    const lines = lineCount(pre.textContent);
    if (lines > limit) {
      box.classList.add("folded");
      const more = doc.createElement("button"); more.type = "button"; more.className = "cb-more"; more.dataset.act = "toggleFold";
      more.dataset.lines = String(lines); more.textContent = t("chat.showAll", lines);
      box.append(more);
    }
  }
}

/** A click on one of a decorated block's buttons (Copy, Wrap, Show all), as the chat's thread answers it. */
async function onCodeClick(e) {
  const el = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
  if (!el) return;
  const act = el.dataset.act;
  if (act === "copyCode") {
    const pre = el.closest(".codeblock") && el.closest(".codeblock").querySelector("pre");
    if (!pre) return;
    const ok = await copyText(pre.textContent);
    const was = el.dataset.label || el.textContent; el.dataset.label = was;
    el.textContent = t(ok ? "chat.copied" : "chat.copyFailed");
    setTimeout(() => { el.textContent = was; }, 1200);
  } else if (act === "toggleWrap") {
    // The timeline (`.tl`) wraps all its code at once; elsewhere (a card's field, a file) the block's own Markdown box does.
    const stream = el.closest(".tl") || el.closest(".md");
    if (!stream) return;
    const on = stream.classList.toggle("wrap-code");
    try { localStorage.setItem("agend_code_wrap", on ? "1" : "0"); } catch { /* this page only */ }
  } else if (act === "toggleFold") {
    const box = el.closest(".codeblock");
    if (!box) return;
    const folded = box.classList.toggle("folded");
    el.textContent = !folded ? t("chat.showLess") : t("chat.showAll", el.dataset.lines);
  }
}

/** A comment's body: the chat's Markdown, its code blocks decorated as the chat's are. */
export function MdBody({ body, cls = "tl-body md", onActivate = null, title = undefined }) {
  const ref = useRef(null);
  useEffect(() => { decorateCode(ref.current); });
  // `onActivate`: a click on the text itself (not on a link, a code block's buttons or a selection being made) — a card's field opens its editor.
  const click = (e) => {
    void onCodeClick(e);
    if (!onActivate) return;
    const inside = e.target && e.target.closest ? e.target.closest("a, button, summary, pre, [data-act]") : null;
    const picked = typeof globalThis.getSelection === "function" && String(globalThis.getSelection() || "").length > 0;
    if (!inside && !picked) onActivate(e);
  };
  return html`<div class=${cls} ref=${ref} title=${title} onClick=${click} dangerouslySetInnerHTML=${body}></div>`;
}

/** Plain text as Markdown for a card's field: the same object `dangerouslySetInnerHTML` takes, or null when the renderer is not there. */
export const mdOf = commentHtml;
