import { isDeepStrictEqual } from "node:util";
import { Document, isAlias, isMap, isScalar, parseDocument } from "yaml";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => v !== null && typeof v === "object" && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const scalar = (value: unknown): boolean => value === null || ["string", "number", "boolean"].includes(typeof value);
function canSplice(before: unknown, after: unknown): boolean {
  if (isDeepStrictEqual(before, after)) return true;
  if (scalar(before) && scalar(after)) return true;
  if (Array.isArray(before) && Array.isArray(after)) return before.length === after.length && before.every((v, i) => canSplice(v, after[i]));
  return record(before) && record(after) && Object.keys(before).every(key => Object.hasOwn(after, key) && canSplice(before[key], after[key]));
}

/** Add keys and edit scalar ranges in place. Structural replacements/removals retain the guarded no-wrap AST writer. */
export function stringifyFleetYaml(document: ReturnType<typeof parseDocument>, source: string): string {
  const fallback = () => document.toString({ lineWidth: 0 });
  try {
    const original = parseDocument(source, { keepSourceTokens: true });
    if (original.errors.length) return fallback();
    const before = original.toJS({ maxAliasCount: -1 }), after = document.toJS({ maxAliasCount: -1 });
    if (isDeepStrictEqual(before, after)) return source;
    if (!canSplice(before, after)) return fallback();
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const collect = (oldValue: unknown, newValue: unknown, path: Array<string | number>): void => {
      const node = path.length ? original.getIn(path, true) : original.contents;
      const next = path.length ? document.getIn(path, true) : document.contents;
      // Detaching an anchored scalar can materialize an unchanged alias too.
      // Replace that alias token, or the old anchor would change both values.
      const materializedScalar = isAlias(node) && isScalar(next);
      if (isDeepStrictEqual(oldValue, newValue) && !materializedScalar) return;
      if (scalar(oldValue) && scalar(newValue)) {
        // An alias intentionally left bound follows its anchor's edit; the
        // final parse/equivalence check still verifies its intended value.
        if (isAlias(node) && isAlias(next) && node.source === next.source) return;
        if ((!isScalar(node) && !isAlias(node)) || !isScalar(next) || !node.range) throw Error("No owned scalar range");
        let text = new Document(newValue).toString({ lineWidth: 0, defaultStringType: "QUOTE_DOUBLE", doubleQuotedAsJSON: true }).replace(/\n$/, "");
        const [start, end] = node.range;
        const replaced = source.slice(start, end);
        if (isScalar(node) && (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED")) {
          // Block headers (including their comment) belong to this value's
          // range. Quote the replacement on one line and keep that comment.
          text += replaced.split(/\r?\n/, 1)[0]!.match(/[ \t]+#.*$/)?.[0] ?? "";
          if (replaced.endsWith("\n")) text += eol;
        }
        // A YAML null may have an empty range directly after ':' or before '#'.
        if (start === end && source[start - 1] === ":") text = " " + text;
        if (start === end && source[end] === "#") text += " ";
        edits.push({ start, end, text });
        return;
      }
      if (Array.isArray(oldValue) && Array.isArray(newValue)) {
        oldValue.forEach((value, index) => collect(value, newValue[index], [...path, index]));
        return;
      }
      if (!record(oldValue) || !record(newValue)) throw Error("Not a mapping addition");
      if (!isMap(node) || !node.range) throw Error("No owned source mapping");
      const column = node.range[0] - source.lastIndexOf("\n", node.range[0] - 1) - 1;
      const additions = Object.fromEntries(Object.entries(newValue).filter(([key]) => !Object.hasOwn(oldValue, key)));
      if (node.flow && Object.keys(additions).length) {
        if (!isMap(next)) throw Error("Changed mapping kind");
        const standalone = new Document();
        const copy = next.clone();
        if (!isMap(copy)) throw Error("Changed mapping clone");
        copy.flow = true;
        standalone.contents = copy;
        // These are outside the value's range and remain in the original source.
        delete copy.anchor;
        copy.comment = undefined; copy.commentBefore = undefined;
        const text = standalone.toString({ lineWidth: 0 }).replace(/\n$/, "").replace(/\n/g, eol + " ".repeat(column));
        edits.push({ start: node.range[0], end: node.range[1], text });
        return;
      }
      if (Object.keys(additions).length) {
        const text = new Document(additions).toString({ lineWidth: 0 }).split("\n").slice(0, -1)
          .map(line => " ".repeat(column) + line).join(eol) + eol;
        const at = node.range[1];
        edits.push({ start: at, end: at, text: (at && source[at - 1] !== "\n" ? eol : "") + text });
      }
      for (const key of Object.keys(oldValue)) collect(oldValue[key], newValue[key], [...path, key]);
    };
    collect(before, after, []);
    let output = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    const checked = parseDocument(output);
    // Anchors, tags and other unusual source shapes must not change the AST's intended result.
    if (!checked.errors.length && isDeepStrictEqual(checked.toJS({ maxAliasCount: -1 }), after)) return output;
  } catch { /* unsupported source shape: retain the existing validated AST path */ }
  return fallback();
}
