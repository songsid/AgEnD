// #2208: a hand-written fleet.yaml (or classicBot.yaml) may share one value between two places — an anchor `&admins`
// and an alias `*admins`. Read naively, both places become the same JS object, and a document edit goes through the
// shared node: an edit meant for one connection either fails ("Expected YAML collection") or changes the other
// connection too, outside what the change was confirmed for. Two rules close that:
//   - a parsed value is unshared at load (unshareParsed): every place holds its own copy, so an edit in memory changes
//     one place;
//   - before a document write, the place written is unshared (detachForWrite): an alias on the way becomes a copy of
//     what it pointed to, and an anchor on the way gives every other alias of it its own copy. Anchors and aliases the
//     write does not touch stay as the operator wrote them.
import { isAlias, isCollection, isMap, isNode, isPair, isSeq, visit, type Document, type Node } from "yaml";

type Path = ReadonlyArray<string | number>;
type YamlDocument = Document.Parsed | Document;

/** At most this many values after the aliases are expanded: an alias "bomb" fails the load instead of filling memory. */
export const UNSHARE_MAX_VALUES = 200_000;

/**
 * A deep copy of a parsed YAML value in which no object or array appears twice: what an anchor and its aliases shared
 * becomes separate, equal copies. Values that are not plain objects or arrays (a js-yaml Date) are kept as they are.
 * Throws on a value that contains itself (a recursive alias) and past UNSHARE_MAX_VALUES values.
 */
export function unshareParsed<T>(value: T, label = "the YAML file"): T {
  const ancestors = new Set<object>();
  let count = 0;
  const copy = (v: unknown): unknown => {
    if (++count > UNSHARE_MAX_VALUES) throw new Error(`${label} expands to more than ${UNSHARE_MAX_VALUES} values through its aliases`);
    if (v === null || typeof v !== "object") return v;
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return v;
    if (ancestors.has(v)) throw new Error(`${label} has a value that contains itself (a recursive alias)`);
    ancestors.add(v);
    try {
      if (Array.isArray(v)) return v.map(copy);
      const out: Record<string, unknown> = proto === null ? Object.create(null) : {};
      for (const [k, x] of Object.entries(v)) Object.defineProperty(out, k, { value: copy(x), enumerable: true, writable: true, configurable: true });
      return out;
    } finally { ancestors.delete(v); }
  };
  return copy(value) as T;
}

/** A copy of `node` (an alias: of what it points to) holding no anchor and no alias. */
function materialize(doc: YamlDocument, node: Node, depth = 0): Node {
  if (depth > 64) throw new Error("fleet.yaml nests its aliases too deeply");
  const source = isAlias(node) ? node.resolve(doc as Document) : node;
  if (!source) throw new Error(`fleet.yaml has an alias without its anchor (*${isAlias(node) ? node.source : "?"})`);
  const copy = source.clone() as Node;
  const strip = (n: unknown): unknown => {
    if (isAlias(n)) return materialize(doc, n, depth + 1);
    if (!isNode(n)) return n;
    delete (n as { anchor?: string }).anchor;
    if (isCollection(n)) {
      n.items = (n.items as unknown[]).map(item => {
        if (!isPair(item)) return strip(item);
        item.key = strip(item.key); item.value = strip(item.value);
        return item;
      }) as typeof n.items;
    }
    return n;
  };
  return strip(copy) as Node;
}

/** Every alias outside `target` that points to it gets its own copy of it; then `target` drops its anchor. */
function unshareAnchor(doc: YamlDocument, target: Node): void {
  if (!target.anchor) return;
  let inside = false;
  visit(doc as Document, {
    Alias(_key, alias, path) {
      if (alias.resolve(doc as Document) !== target) return undefined;
      if (path.includes(target)) { inside = true; return undefined; }      // the anchor's own content (recursive)
      return materialize(doc, target);
    },
  });
  if (!inside) delete (target as { anchor?: string }).anchor;
}

function child(node: unknown, key: string | number): unknown {
  if (isMap(node)) return node.get(key, true);
  if (isSeq(node) && typeof key === "number") return node.get(key, true);
  return undefined;
}

/**
 * Make a write at `path` change that place only. Along the path, an alias is replaced by a copy of what it points to
 * and an anchor's other aliases each get a copy; at the end, the same for every anchor inside what is written over.
 * Call it before every setIn / deleteIn / in-place scalar change on the document.
 */
export function detachForWrite(doc: YamlDocument, path: Path): void {
  let parent: unknown = null;
  let node: unknown = doc.contents;
  for (let depth = 0; ; depth++) {
    if (isAlias(node) && (isMap(parent) || isSeq(parent))) {                    // (the root is never an alias: it comes first)
      const copy = materialize(doc, node);
      parent.set(path[depth - 1], copy);
      node = copy;
    }
    if (isNode(node)) unshareAnchor(doc, node);
    if (depth === path.length) {
      if (isNode(node)) {
        const anchored: Node[] = [];
        visit(node as Node, { Node(_key, n) { if (n !== node && n.anchor) anchored.push(n); } });
        for (const n of anchored) unshareAnchor(doc, n);
      }
      return;
    }
    const next = child(node, path[depth]);
    if (next === undefined) return;
    parent = node; node = next;
  }
}

type Json = unknown;
const isPlain = (v: Json): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);
const named = (at: ReadonlyArray<string | number>) => (at.length ? at.join(".") : "(the whole file)");

/** The deepest first place where two values differ, or null. */
function firstDifference(before: Json, after: Json, at: Array<string | number>): string | null {
  if (same(before, after)) return null;
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    for (let i = 0; i < before.length; i++) { const found = firstDifference(before[i], after[i], [...at, i]); if (found) return found; }
  }
  if (isPlain(before) && isPlain(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const found = firstDifference(before[key], after[key], [...at, key]); if (found) return found;
    }
  }
  return named(at);
}

/**
 * The first place (as a dotted path, as deep as it goes) where `after` differs from `before` outside every path in
 * `written`, or null.
 * A write at a path covers it and everything under it.
 */
export function changedOutside(before: Json, after: Json, written: ReadonlyArray<Path>, at: Array<string | number> = []): string | null {
  const covered = written.some(w => w.length <= at.length && w.every((k, i) => String(k) === String(at[i])));
  if (covered) return null;
  const leadsTo = written.some(w => w.length > at.length && at.every((k, i) => String(k) === String(w[i])));
  if (!leadsTo) return firstDifference(before, after, at);
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const found = changedOutside(before[i], after[i], written, [...at, i]);
      if (found) return found;
    }
    return null;
  }
  if (isPlain(before) && isPlain(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const found = changedOutside(before[key], after[key], written, [...at, key]);
      if (found) return found;
    }
    return null;
  }
  return same(before, after) ? null : named(at);
}
