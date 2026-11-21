import { isDeepStrictEqual } from "node:util";
import { Document, isMap, parseDocument } from "yaml";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => v !== null && typeof v === "object" && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function onlyAdds(before: unknown, after: unknown): boolean {
  if (isDeepStrictEqual(before, after)) return true;
  if (Array.isArray(before) && Array.isArray(after)) return before.length === after.length && before.every((v, i) => onlyAdds(v, after[i]));
  return record(before) && record(after) && Object.keys(before).every(key => Object.hasOwn(after, key) && onlyAdds(before[key], after[key]));
}

/** Add-only saves splice new entries into the source; normal edits retain the guarded AST writer without wrapping. */
export function stringifyFleetYaml(document: ReturnType<typeof parseDocument>, source: string): string {
  const fallback = () => document.toString({ lineWidth: 0 });
  try {
    const original = parseDocument(source, { keepSourceTokens: true });
    if (original.errors.length) return fallback();
    const before = original.toJS({ maxAliasCount: -1 }), after = document.toJS({ maxAliasCount: -1 });
    if (isDeepStrictEqual(before, after)) return source;
    if (!onlyAdds(before, after)) return fallback();
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const collect = (oldValue: unknown, newValue: unknown, path: Array<string | number>): void => {
      if (isDeepStrictEqual(oldValue, newValue)) return;
      if (Array.isArray(oldValue) && Array.isArray(newValue)) {
        oldValue.forEach((value, index) => collect(value, newValue[index], [...path, index]));
        return;
      }
      if (!record(oldValue) || !record(newValue)) throw Error("Not a mapping addition");
      const node = path.length ? original.getIn(path, true) : original.contents;
      if (!isMap(node) || !node.range) throw Error("No owned source mapping");
      const column = node.range[0] - source.lastIndexOf("\n", node.range[0] - 1) - 1;
      if (node.flow) {
        const next = path.length ? document.getIn(path, true) : document.contents;
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
      const additions = Object.fromEntries(Object.entries(newValue).filter(([key]) => !Object.hasOwn(oldValue, key)));
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
