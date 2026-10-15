/** #1629: the fixed effect template, shared by upload validation and the opaque shim. */
import { parse, type DefaultTreeAdapterMap } from "parse5";

export const EFFECT_SCRIPT_TYPES = ["", "text/javascript", "application/javascript"] as const;
export const EFFECT_UNSUPPORTED_TAGS = ["base", "embed", "frame", "frameset", "iframe", "link", "object", "portal", "template"] as const;
export const EFFECT_HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
/** Includes html/head/body; avoids deep-tree work in downstream consumers as well as this validator. */
export const EFFECT_MAX_ELEMENT_DEPTH = 256;
// A compatibility check, not a JavaScript security analyser. The runtime also guards these methods;
// sandbox/CSP and the parent's navigation fence remain the security boundary, including obfuscated code.
export const EFFECT_DOCUMENT_WRITE_PATTERN = String.raw`\bdocument\s*(?:\.\s*(?:open|write|writeln|close)\b|\[\s*["'](?:open|write|writeln|close)["']\s*\])`;

export type EffectTemplateProblem = "unsupported_element" | "unsupported_meta" | "unsupported_script" | "document_write" | "unsupported_depth";

/** HTML5 parsing matters here: entity-encoded attributes, namespaces and malformed markup are not regex HTML. */
export function effectTemplateProblem(html: string): EffectTemplateProblem | null {
  if (new RegExp(EFFECT_DOCUMENT_WRITE_PATTERN, "i").test(html)) return "document_write";
  // DOMParser(text/html) disables scripting: in particular, noscript contents are parsed as markup.
  const pending: Array<{ node: DefaultTreeAdapterMap["node"]; depth: number }> = [{ node: parse(html, { scriptingEnabled: false }), depth: 0 }];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if ("tagName" in node) {
      if (depth > EFFECT_MAX_ELEMENT_DEPTH) return "unsupported_depth";
      if ((EFFECT_UNSUPPORTED_TAGS as readonly string[]).includes(node.tagName.toLowerCase())) return "unsupported_element";
      if (node.tagName === "meta" && node.attrs.some(a => a.name === "http-equiv")) return "unsupported_meta";
      if (node.tagName === "script") {
        if (node.namespaceURI !== EFFECT_HTML_NAMESPACE || node.attrs.some(a => a.name !== "type")) return "unsupported_script";
        const type = node.attrs.find(a => a.name === "type")?.value.trim().toLowerCase() ?? "";
        if (!(EFFECT_SCRIPT_TYPES as readonly string[]).includes(type)) return "unsupported_script";
      }
    }
    if ("childNodes" in node) for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push({ node: node.childNodes[i]!, depth: depth + 1 });
  }
  return null;
}
