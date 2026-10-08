/**
 * #1408: a small DOM for the web app's tests — enough for the vendored Preact to render into, and for the chat
 * thread's keyed renderer to parse the markup chat-render.js produces (well-formed: escaped text, quoted attributes,
 * void and self-closing tags). No jsdom/happy-dom dependency (design §0).
 *
 * It is not a browser: layout numbers (scrollTop, scrollHeight, clientHeight) are plain fields a test sets, focus is
 * bookkeeping, and the selector engine knows what the app uses — tags, #id, .class, [attr], [attr=value],
 * :not(...), descendant and child combinators, and comma lists.
 */

type Listener = { fn: (e: any) => void; capture: boolean; once: boolean };

export class MiniEvent {
  type: string; bubbles: boolean; cancelable: boolean;
  target: any = null; currentTarget: any = null;
  defaultPrevented = false; propagationStopped = false; immediateStopped = false; eventPhase = 0;
  [k: string]: any;
  constructor(type: string, init: Record<string, any> = {}) {
    this.type = type; this.bubbles = init.bubbles ?? false; this.cancelable = init.cancelable ?? true;
    Object.assign(this, init);
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.propagationStopped = true; this.immediateStopped = true; }
}

class Target {
  _listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: any, opts?: boolean | { capture?: boolean; once?: boolean; passive?: boolean }) {
    if (!fn) return;
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    const once = typeof opts === "object" && !!opts?.once;
    const list = this._listeners.get(type) ?? [];
    if (list.some(l => l.fn === fn && l.capture === capture)) return;
    list.push({ fn, capture, once });
    this._listeners.set(type, list);
  }
  removeEventListener(type: string, fn: any, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    const list = this._listeners.get(type);
    if (list) this._listeners.set(type, list.filter(l => !(l.fn === fn && l.capture === capture)));
  }
  listenerCount(type?: string): number {
    if (type) return this._listeners.get(type)?.length ?? 0;
    let n = 0; for (const l of this._listeners.values()) n += l.length; return n;
  }
  _fire(e: MiniEvent, capture: boolean) {
    const list = [...(this._listeners.get(e.type) ?? [])].filter(l => l.capture === capture || e.eventPhase === 2);
    for (const l of list) {
      if (l.once) this.removeEventListener(e.type, l.fn, l.capture);
      e.currentTarget = this;
      l.fn.call(this, e);
      if (e.immediateStopped) break;
    }
  }
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const SVG_NS = "http://www.w3.org/2000/svg";

export class MiniNode extends Target {
  nodeType = 1; parentNode: MiniElement | null = null; childNodes: MiniNode[] = []; ownerDocument!: MiniDocument;
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): MiniNode | null { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return p.childNodes[i + 1] ?? null; }
  get previousSibling(): MiniNode | null { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return i > 0 ? p.childNodes[i - 1]! : null; }
  get parentElement() { return this.parentNode; }
  get isConnected(): boolean { let n: MiniNode | null = this; while (n) { if (n === (n.ownerDocument as any)?.documentElement) return true; n = n.parentNode; } return false; }
  _detach(n: MiniNode) {
    if (n.nodeType === 11) return;
    if (n.parentNode) { const p = n.parentNode; const i = p.childNodes.indexOf(n); if (i >= 0) p.childNodes.splice(i, 1); }
    n.parentNode = null;
  }
  insertBefore(n: MiniNode, ref: MiniNode | null) {
    if (n.nodeType === 11) { for (const c of [...n.childNodes]) this.insertBefore(c, ref); return n; }
    if (n === ref) return n;
    this._detach(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    n.parentNode = this as any;
    return n;
  }
  appendChild(n: MiniNode) { return this.insertBefore(n, null); }
  removeChild(n: MiniNode) { this._detach(n); return n; }
  replaceChild(n: MiniNode, old: MiniNode) { this.insertBefore(n, old); this._detach(old); return old; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(...nodes: any[]) { const p = this.parentNode; if (!p) return; for (const n of nodes) p.insertBefore(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n, this); p.removeChild(this); }
  append(...nodes: any[]) { for (const n of nodes) this.appendChild(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n); }
  prepend(...nodes: any[]) { const first = this.firstChild; for (const n of nodes) this.insertBefore(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n, first); }
  contains(n: MiniNode | null): boolean { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  get textContent(): string { return this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v: string) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; if (v !== "" && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v))); }
  dispatchEvent(e: MiniEvent): boolean {
    e.target = this;
    const path: MiniNode[] = [];
    let n: any = this.parentNode;
    while (n) { path.unshift(n); n = n.parentNode; }
    const doc: any = this.ownerDocument;
    if (path[0] !== doc && this.isConnected) path.unshift(doc);
    e.eventPhase = 1;
    for (const p of path) { (p as any)._fire(e, true); if (e.propagationStopped) return !e.defaultPrevented; }
    e.eventPhase = 2;
    this._fire(e, false);
    if (e.bubbles && !e.propagationStopped) {
      e.eventPhase = 3;
      for (const p of [...path].reverse()) { (p as any)._fire(e, false); if (e.propagationStopped) break; }
    }
    return !e.defaultPrevented;
  }
  // Selectors (elements only)
  get children(): MiniElement[] { return this.childNodes.filter(c => c.nodeType === 1) as MiniElement[]; }
  get firstElementChild() { return this.children[0] ?? null; }
  querySelectorAll(sel: string): MiniElement[] { const out: MiniElement[] = []; walk(this, el => { if (el !== (this as any) && matches(el, sel, this)) out.push(el); }); return out; }
  querySelector(sel: string): MiniElement | null { return this.querySelectorAll(sel)[0] ?? null; }
  getElementById(id: string): MiniElement | null { let found: MiniElement | null = null; walk(this, el => { if (!found && el.getAttribute("id") === id) found = el; }); return found; }
}

export class MiniText extends MiniNode {
  data: string;
  constructor(doc: MiniDocument, data: string) { super(); this.nodeType = 3; this.ownerDocument = doc; this.data = data; }
  get nodeValue() { return this.data; } set nodeValue(v: string) { this.data = v; }
  get textContent() { return this.data; } set textContent(v: string) { this.data = String(v); }
  get nodeName() { return "#text"; }
}

function walk(root: MiniNode, fn: (el: MiniElement) => void) {
  for (const c of root.childNodes) { if (c.nodeType === 1) { fn(c as MiniElement); walk(c, fn); } else if (c.nodeType === 11) walk(c, fn); }
  if ((root as any).content) walk((root as any).content, fn);
}

export class MiniElement extends MiniNode {
  localName: string; namespaceURI: string | null; attrs = new Map<string, string>();
  style: Record<string, any>;
  scrollTop = 0; scrollHeight = 0; clientHeight = 0; offsetParent: any = {};
  _value: string | undefined; checked = false; open = false; content?: MiniFragment;
  constructor(doc: MiniDocument, tag: string, ns: string | null = null) {
    super(); this.ownerDocument = doc; this.localName = tag.toLowerCase(); this.namespaceURI = ns;
    const style: Record<string, any> = { setProperty(k: string, v: string) { style[k] = v; }, removeProperty(k: string) { delete style[k]; }, cssText: "" };
    this.style = style;
    if (this.localName === "template") this.content = new MiniFragment(doc);
  }
  get tagName() { return this.localName.toUpperCase(); }
  get nodeName() { return this.tagName; }
  getAttribute(k: string) { return this.attrs.has(k) ? this.attrs.get(k)! : null; }
  setAttribute(k: string, v: any) { this.attrs.set(k, String(v)); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  hasAttribute(k: string) { return this.attrs.has(k); }
  toggleAttribute(k: string, on?: boolean) { const want = on ?? !this.attrs.has(k); if (want) this.attrs.set(k, ""); else this.attrs.delete(k); return want; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get id() { return this.getAttribute("id") ?? ""; } set id(v: string) { this.setAttribute("id", v); }
  get className() { return this.getAttribute("class") ?? ""; } set className(v: string) { this.setAttribute("class", v); }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    const write = (l: string[]) => { el.className = [...new Set(l)].join(" "); };
    return {
      contains: (c: string) => list().includes(c),
      add: (...cs: string[]) => write([...list(), ...cs]),
      remove: (...cs: string[]) => write(list().filter(x => !cs.includes(x))),
      toggle: (c: string, on?: boolean) => { const has = list().includes(c); const want = on ?? !has; if (want && !has) write([...list(), c]); if (!want && has) write(list().filter(x => x !== c)); return want; },
      get length() { return list().length; },
    };
  }
  get dataset(): Record<string, string> {
    const el = this;
    const key = (p: string) => `data-${p.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`;
    return new Proxy({}, {
      get: (_t, p: string) => el.getAttribute(key(p)) ?? undefined,
      set: (_t, p: string, v) => { el.setAttribute(key(p), v); return true; },
      has: (_t, p: string) => el.hasAttribute(key(p)),
      deleteProperty: (_t, p: string) => { el.removeAttribute(key(p)); return true; },
      ownKeys: () => [...el.attrs.keys()].filter(k => k.startsWith("data-")).map(k => k.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    }) as any;
  }
  get hidden() { return this.hasAttribute("hidden"); } set hidden(v: boolean) { this.toggleAttribute("hidden", !!v); }
  get disabled() { return this.hasAttribute("disabled"); } set disabled(v: boolean) { this.toggleAttribute("disabled", !!v); }
  get title() { return this.getAttribute("title") ?? ""; } set title(v: string) { this.setAttribute("title", v); }
  get type() { return this.getAttribute("type") ?? ""; } set type(v: string) { this.setAttribute("type", v); }
  get href() { return this.getAttribute("href") ?? ""; } set href(v: string) { this.setAttribute("href", v); }
  get value() { return this._value ?? this.getAttribute("value") ?? ""; } set value(v: string) { this._value = String(v); }
  get src() { return this.getAttribute("src") ?? ""; } set src(v: string) { this.setAttribute("src", v); }
  get tabIndex() { return Number(this.getAttribute("tabindex") ?? -1); } set tabIndex(v: number) { this.setAttribute("tabindex", v); }
  get innerHTML(): string { return this.childNodes.map(serialize).join(""); }
  set innerHTML(html: string) { const target: MiniNode = this.content ?? this; target.childNodes = []; for (const n of parseHtml(this.ownerDocument, html)) target.appendChild(n); }
  get outerHTML() { return serialize(this); }
  matches(sel: string) { return matches(this, sel, null); }
  closest(sel: string): MiniElement | null { let n: any = this; while (n && n.nodeType === 1) { if (matches(n, sel, null)) return n; n = n.parentNode; } return null; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { this.dispatchEvent(new MiniEvent("click", { bubbles: true, button: 0 })); }
  select() { /* text selection: nothing to do */ }
  showModal() { this.open = true; this.setAttribute("open", ""); }
  close() { this.open = false; this.removeAttribute("open"); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  scrollIntoView() { /* layout-free */ }
}

// Preact names an event prop by asking whether `on<name>` (lower case) is a property of the element: these must exist.
for (const ev of ["click", "input", "change", "keydown", "keyup", "paste", "submit", "scroll", "focus", "blur", "pointerdown", "mousedown",
  "touchstart", "dragenter", "dragover", "dragleave", "drop", "load", "error", "cancel", "close", "toggle", "focusin", "focusout"]) {
  Object.defineProperty(MiniElement.prototype, `on${ev}`, { value: null, writable: true, configurable: true });
}

export class MiniFragment extends MiniNode {
  constructor(doc: MiniDocument) { super(); this.nodeType = 11; this.ownerDocument = doc; }
}

export class MiniDocument extends MiniNode {
  documentElement: MiniElement; head: MiniElement; body: MiniElement; activeElement: MiniElement;
  readyState = "complete"; title = "";
  constructor() {
    super(); this.nodeType = 9; this.ownerDocument = this;
    this.documentElement = new MiniElement(this, "html");
    this.head = new MiniElement(this, "head"); this.body = new MiniElement(this, "body");
    this.documentElement.appendChild(this.head); this.documentElement.appendChild(this.body);
    this.childNodes = [this.documentElement]; this.documentElement.parentNode = this as any;
    this.activeElement = this.body;
  }
  createElement(tag: string) { return new MiniElement(this, tag, null); }
  createElementNS(ns: string, tag: string) { return new MiniElement(this, tag, ns); }
  createTextNode(data: string) { return new MiniText(this, String(data)); }
  createDocumentFragment() { return new MiniFragment(this); }
  createComment(data: string) { const t = new MiniText(this, ""); (t as any).nodeType = 8; (t as any).comment = data; return t; }
  get isConnected() { return true; }
}

// ── HTML in and out ──

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
function decode(s: string) { return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m); }
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

export function parseHtml(doc: MiniDocument, html: string): MiniNode[] {
  const root = new MiniFragment(doc);
  const stack: MiniNode[] = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+|<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1]!;
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {   // close tag
      const tag = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) { if ((stack[i] as MiniElement).localName === tag) { stack.length = i; break; } }
      continue;
    }
    if (m[2]) {
      const tag = m[2].toLowerCase();
      const parentNs = (top as MiniElement).namespaceURI;
      const el = new MiniElement(doc, tag, tag === "svg" || parentNs === SVG_NS ? SVG_NS : null);
      const attrRe = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(m[3] ?? ""))) el.setAttribute(a[1]!.toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ""));
      (el.content ?? top).ownerDocument; // keep TS quiet about unused content
      top.appendChild(el);
      if (!VOID.has(tag) && !m[4]) stack.push(tag === "template" ? el.content! : el);
      continue;
    }
    if (m[5]) top.appendChild(doc.createTextNode(decode(m[5])));
  }
  return [...root.childNodes];
}

function serialize(n: MiniNode): string {
  if (n.nodeType === 3) return escText((n as MiniText).data);
  if (n.nodeType === 8) return "";
  if (n.nodeType === 11) return n.childNodes.map(serialize).join("");
  const el = n as MiniElement;
  const attrs = [...el.attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
  if (VOID.has(el.localName)) return `<${el.localName}${attrs}>`;
  return `<${el.localName}${attrs}>${el.childNodes.map(serialize).join("")}</${el.localName}>`;
}

// ── Selectors: what the app uses ──

type Compound = { tag?: string; id?: string; classes: string[]; attrs: Array<{ name: string; value?: string }>; nots: string[] };
function parseCompound(s: string): Compound {
  const c: Compound = { classes: [], attrs: [], nots: [] };
  const re = /^([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]|:not\(([^)]*\)?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[0] === "") break;
    if (m[1] && m[1] !== "*") c.tag = m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4], value: m[5] });
    else if (m[6]) c.nots.push(m[6]);
  }
  return c;
}
function matchCompound(el: MiniElement, c: Compound): boolean {
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.getAttribute("id") !== c.id) return false;
  const cls = el.className.split(/\s+/);
  for (const k of c.classes) if (!cls.includes(k)) return false;
  for (const a of c.attrs) { if (!el.hasAttribute(a.name)) return false; if (a.value !== undefined && el.getAttribute(a.name) !== a.value) return false; }
  for (const n of c.nots) if (matches(el, n, null)) return false;
  return true;
}
function matchChain(el: MiniElement, parts: Array<{ comb: string; c: Compound }>, i: number, scope: MiniNode | null): boolean {
  if (!matchCompound(el, parts[i]!.c)) return false;
  if (i === 0) return true;
  const comb = parts[i]!.comb;
  let p: any = el.parentNode;
  if (comb === ">") return !!p && p.nodeType === 1 && p !== scope && matchChain(p, parts, i - 1, scope);
  while (p && p.nodeType === 1 && p !== scope) { if (matchChain(p, parts, i - 1, scope)) return true; p = p.parentNode; }
  return false;
}
export function matches(el: MiniElement, selector: string, scope: MiniNode | null): boolean {
  return splitTop(selector, ",").some(sel => {
    const tokens = sel.trim().replace(/\s*>\s*/g, " > ").split(/\s+/).filter(Boolean);
    const parts: Array<{ comb: string; c: Compound }> = [];
    let comb = " ";
    for (const tok of tokens) { if (tok === ">") { comb = ">"; continue; } parts.push({ comb, c: parseCompound(tok) }); comb = " "; }
    return parts.length > 0 && matchChain(el, parts, parts.length - 1, scope);
  });
}
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const ch of s) { if (ch === "(" || ch === "[") depth++; if (ch === ")" || ch === "]") depth--; if (ch === sep && depth === 0) { out.push(cur); cur = ""; } else cur += ch; }
  out.push(cur); return out;
}

// ── A page: globals the app reads ──

export interface MiniPage {
  document: MiniDocument; window: any; storage: Map<string, string>; restore: () => void;
}

/** Install a fresh document and window-ish globals on globalThis; restore() puts the previous ones back. */
export function installDom(opts: { url?: string; lang?: string; storage?: Record<string, string>; matchNarrow?: boolean } = {}): MiniPage {
  const g = globalThis as any;
  const saved: Record<string, any> = {};
  const keys = ["document", "window", "navigator", "localStorage", "sessionStorage", "location", "history", "matchMedia", "requestAnimationFrame", "cancelAnimationFrame", "Event", "KeyboardEvent", "Node", "HTMLElement", "Element", "Text", "SVGElement", "confirm", "isSecureContext"];
  for (const k of keys) saved[k] = Object.getOwnPropertyDescriptor(g, k);
  const document = new MiniDocument();
  const storage = new Map<string, string>(Object.entries(opts.storage ?? {}));
  const store = (m: Map<string, string>) => ({ getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear() });
  const url = new URL(opts.url ?? "http://127.0.0.1:19280/ui");
  const location: any = {
    get href() { return url.href; }, get origin() { return url.origin; }, get pathname() { return url.pathname; }, get search() { return url.search; }, get hash() { return url.hash; },
    assign: (h: string) => { location.assigned = h; }, replace: (h: string) => { location.replaced = h; }, assigned: null as string | null, replaced: null as string | null,
  };
  const history: any = {
    entries: [url.pathname + url.search + url.hash],
    pushState: (_s: unknown, _t: string, p: string) => { const u = new URL(p, url); url.pathname = u.pathname; url.search = u.search; url.hash = u.hash; history.entries.push(p); },
    replaceState: (_s: unknown, _t: string, p: string) => { const u = new URL(p, url); url.pathname = u.pathname; url.search = u.search; url.hash = u.hash; history.entries[history.entries.length - 1] = p; },
  };
  const win: any = Object.assign(new Target(), { document, location, history, innerHeight: 844, visualViewport: null });
  const define = (k: string, v: any) => Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  define("document", document); define("window", win); define("location", location); define("history", history);
  define("navigator", { language: opts.lang ?? "en", clipboard: undefined });
  define("localStorage", store(storage)); define("sessionStorage", store(new Map()));
  define("matchMedia", (q: string) => ({ matches: !!opts.matchNarrow && /max-width/.test(q), addEventListener() {}, removeEventListener() {} }));
  define("requestAnimationFrame", (f: () => void) => setTimeout(f, 0)); define("cancelAnimationFrame", (h: any) => clearTimeout(h));
  define("Event", MiniEvent); define("KeyboardEvent", MiniEvent); define("Node", MiniNode); define("Element", MiniElement); define("HTMLElement", MiniElement); define("Text", MiniText); define("SVGElement", MiniElement);
  define("confirm", () => true); define("isSecureContext", false);
  win.addEventListener = win.addEventListener.bind(win);
  return {
    document, window: win, storage,
    restore() { for (const k of keys) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; } },
  };
}

/** Fire a DOM event (bubbling) on `el`. */
export function fire(el: MiniNode, type: string, init: Record<string, any> = {}) {
  const e = new MiniEvent(type, { bubbles: true, ...init });
  el.dispatchEvent(e);
  return e;
}

/** Let Preact render and run its effects: a few turns of the macrotask queue (effects wait for a "frame"). */
export async function settle(turns = 4) {
  for (let i = 0; i < turns; i++) await new Promise(r => setTimeout(r, 0));
}
