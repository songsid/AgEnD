/** #1629: the fixed effect template, shared by upload validation and the opaque shim. */
import { parse, type DefaultTreeAdapterMap } from "parse5";

export const EFFECT_SCRIPT_TYPES = ["", "text/javascript", "application/javascript"] as const;
export const EFFECT_UNSUPPORTED_TAGS = ["base", "embed", "frame", "frameset", "iframe", "link", "object", "portal", "template"] as const;
export const EFFECT_HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
// A compatibility check, not a JavaScript security analyser. The runtime also guards these methods;
// sandbox/CSP and the parent's navigation fence remain the security boundary, including obfuscated code.
export const EFFECT_DOCUMENT_WRITE_PATTERN = String.raw`\bdocument\s*(?:\.\s*(?:open|write|writeln|close)\b|\[\s*["'](?:open|write|writeln|close)["']\s*\])`;

export type EffectTemplateProblem = "unsupported_element" | "unsupported_meta" | "unsupported_script" | "document_write";

/** HTML5 parsing matters here: entity-encoded attributes, namespaces and malformed markup are not regex HTML. */
export function effectTemplateProblem(html: string): EffectTemplateProblem | null {
  if (new RegExp(EFFECT_DOCUMENT_WRITE_PATTERN, "i").test(html)) return "document_write";
  const walk = (node: DefaultTreeAdapterMap["node"]): EffectTemplateProblem | null => {
    if ("tagName" in node) {
      if ((EFFECT_UNSUPPORTED_TAGS as readonly string[]).includes(node.tagName.toLowerCase())) return "unsupported_element";
      if (node.tagName === "meta" && node.attrs.some(a => a.name === "http-equiv")) return "unsupported_meta";
      if (node.tagName === "script") {
        if (node.namespaceURI !== EFFECT_HTML_NAMESPACE || node.attrs.some(a => a.name !== "type")) return "unsupported_script";
        const type = node.attrs.find(a => a.name === "type")?.value.trim().toLowerCase() ?? "";
        if (!(EFFECT_SCRIPT_TYPES as readonly string[]).includes(type)) return "unsupported_script";
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) {
      const problem = walk(child);
      if (problem) return problem;
    }
    return null;
  };
  return walk(parse(html));
}
