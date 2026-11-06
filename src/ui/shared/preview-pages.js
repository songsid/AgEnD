// #2911 (6): every page in the thread — the list the preview panel shows. A page is what preview-versions.js counts as
// versions of one thing: the agent's complete ```html blocks with one <title> (the untitled ones together), or its
// attached .html files of one name. Pure: the panel draws it; nothing here runs a preview.
import "./chat-render.js";
import { htmlTitle } from "./preview-versions.js";

const R = () => globalThis.AgendChatRender;

/**
 * The pages in `msgs` (in thread order), newest first: [{ id, label, kind: "html" | "file", versions, latest }], where
 * `latest` is the newest version as the panel opens it ({ key, instance, msgKey, n | att, code, sender, ts }; an
 * attached file's code is read when it is opened). `label` is the title, the file name, or "" for untitled blocks.
 */
export function pagesOf(msgs, keyOf, instance) {
  const pages = new Map();
  const add = (id, label, kind, spec) => {
    const p = pages.get(id);
    if (p) { p.versions++; p.latest = spec; pages.delete(id); pages.set(id, p); }   // re-inserted: newest last
    else pages.set(id, { id, label, kind, versions: 1, latest: spec });
  };
  for (const x of Array.isArray(msgs) ? msgs : []) {
    if (x.role !== "agent") continue;
    const msgKey = keyOf(x);
    R().htmlFences(x.text).forEach((f, n) => {
      if (!f.terminated) return;
      const title = htmlTitle(f.code);
      add(`t:${title}`, title, "html", { key: `${msgKey}:f${n}`, instance, msgKey, n, code: f.code, sender: x.sender, ts: x.ts });
    });
    for (const a of Array.isArray(x.attachments) ? x.attachments : []) {
      if (!R().isHtmlAttachment(a)) continue;
      add(`a:${a.name.trim().toLowerCase()}`, a.name, "file", { key: `${msgKey}:a${a.id}`, instance, msgKey, att: { id: a.id, name: a.name, size: a.size }, code: null, sender: x.sender, ts: x.ts });
    }
  }
  return [...pages.values()].reverse();
}

/** The page `open` belongs to: its id in pagesOf's terms. */
export function pageIdOf(open) {
  if (!open) return null;
  return open.att ? `a:${String(open.att.name || "").trim().toLowerCase()}` : `t:${htmlTitle(open.code)}`;
}
