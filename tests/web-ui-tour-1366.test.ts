/**
 * #1366 item 4: the first sign-in tour in /ui. Shown once on this device, dismissed by Got it / Skip / Esc, replayed
 * from Tour in the sidebar, and built from classes only (#1300: no style attribute, no inline style). The dashboard's
 * own script runs as written in a vm with a small fake DOM; what a browser does with it is the smoke in the PR.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const UI = join(process.cwd(), "src", "ui");
const RENDER = readFileSync(join(UI, "chat-render.js"), "utf8");
const DASHBOARD = readFileSync(join(UI, "dashboard.html"), "utf8");
const PAGE = DASHBOARD.match(/<script>\n([\s\S]*?)<\/script>/)![1]!;

class FakeEl {
  id = ""; className = ""; hidden = false; title = ""; type = "";
  private text = "";
  /** As in a browser: setting it replaces the children. */
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(""); }
  set textContent(v: string) { for (const c of this.children) c.parent = null; this.children = []; this.text = v; }
  /** Markup is not parsed — except that a needs-you badge in it becomes a new badge element, as a redraw would. */
  set innerHTML(v: string) {
    this.textContent = "";
    if (v.includes("badge-await")) { const b = new FakeEl("span", this.doc); b.id = `badge-${++FakeEl.made}`; b.className = "badge-await"; this.append(b); }
  }
  static made = 0;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  constructor(public tag: string, private doc: FakeDoc) {}
  get style(): never { throw new Error(`style touched on <${this.tag}>`); }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (c: string) => { if (!list().includes(c)) this.className = [...list(), c].join(" "); },
      remove: (c: string) => { this.className = list().filter(x => x !== c).join(" "); },
      contains: (c: string) => list().includes(c),
      toggle: (c: string) => { const on = !list().includes(c); if (on) this.classList.add(c); else this.classList.remove(c); return on; },
    };
  }
  setAttribute(k: string, v: string) { if (k === "style") throw new Error("style attribute set"); this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  append(...kids: FakeEl[]) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  appendChild(k: FakeEl) { this.append(k); return k; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  focus() { this.doc.activeElement = this; }
  closest(sel: string) { let n: FakeEl | null = this; while (n) { if (sel === "[data-act]" && n.dataset.act) return n; n = n.parent; } return null; }
  addEventListener() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  get offsetParent() { return null; }
  /** Every element under this one, itself included. */
  all(): FakeEl[] { return [this, ...this.children.flatMap(c => c.all())]; }
}

class FakeDoc {
  activeElement: FakeEl | null = null;
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  body: FakeEl;
  fixed: Record<string, FakeEl> = {};
  constructor() {
    this.body = new FakeEl("body", this);
    for (const id of ["instanceList", "mainArea", "tourBtn", "attachBtn", "sendBtn", "stopBtn", "messages", "uptime", "sbOpen", "fleetEntry", "msgIn"]) {
      const e = new FakeEl("div", this); e.id = id; this.fixed[id] = e; this.body.append(e);
    }
    this.fixed.stopBtn.hidden = true;
  }
  createElement = (tag: string) => new FakeEl(tag, this);
  getElementById = (id: string) => this.body.all().find(e => e.id === id) ?? null;
  querySelector = (sel: string) => sel === ".badge-await" ? this.body.all().find(e => e.classList.contains("badge-await")) ?? null : null;
  querySelectorAll = () => [];
  contains = (e: FakeEl) => this.body.all().includes(e);
  addEventListener = (t: string, f: (e: unknown) => void) => { (this.listeners[t] ??= []).push(f); };
}

/**
 * The dashboard's script on a fresh page. `storage` is shared across loads (one device). null: reading the tour's key
 * throws. Only that key — the page's first line already reads agend_lang unguarded, so a storage that throws on
 * everything stops the whole script before the tour, which is not the tour's case to test.
 */
function load(storage: Map<string, string> | null = new Map(), lang = "en", narrow = false) {
  const doc = new FakeDoc();
  const s = storage ?? new Map<string, string>();
  const refuse = (k: string) => { if (!storage && k === "agend_tour_done") throw new Error("SecurityError"); };
  const localStorage = {
    getItem: (k: string) => { refuse(k); return s.get(k) ?? null; },
    setItem: (k: string, v: string) => { refuse(k); s.set(k, v); },
    removeItem: (k: string) => { s.delete(k); },
  };
  if (lang !== "en") s.set("agend_lang", lang);
  const c = vm.createContext({
    localStorage, navigator: { language: "en" }, document: doc, matchMedia: () => ({ matches: narrow }),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    EventSource: class { addEventListener() {} },
    AgendPreview: { init() {}, optedIn: () => false, onChange() {}, stopAll: () => [], stopIn: () => [], availability: () => ({ ok: false }), BANNER: "" },
  });
  vm.runInContext(RENDER, c);
  vm.runInContext(PAGE, c);
  const card = () => doc.getElementById("tour");
  const text = () => card()?.all().find(e => e.className === "tour-text")?.textContent;
  const buttons = () => (card()?.all() ?? []).filter(e => e.tag === "button");
  const click = (el: FakeEl) => { for (const f of doc.listeners.click ?? []) f({ target: el }); };
  const key = (k: string, repeat = false) => { for (const f of doc.listeners.keydown ?? []) f({ key: k, repeat, isComposing: false, preventDefault() {} }); };
  const button = (label: string) => buttons().find(b => b.textContent === label)!;
  const spotted = () => doc.body.all().filter(e => e.classList.contains("tour-spot")).map(e => e.id);
  return { doc, c, card, text, buttons, click, key, button, spotted };
}

describe("the first sign-in tour (#1366)", () => {
  it("opens on the first load: step 1 of 5, the instance list outlined, focus on Next", () => {
    const p = load();
    expect(p.card()?.attrs.role).toBe("dialog");
    expect(p.text()).toMatch(/Pick an instance/);
    expect(p.card()!.all().find(e => e.className === "tour-count")?.textContent).toBe("1 of 5");
    expect(p.spotted()).toEqual(["instanceList"]);
    expect(p.doc.activeElement?.textContent).toBe("Next");
    expect(p.buttons().map(b => b.textContent)).toEqual(["Skip", "Next"]);
  });

  it("walks the five points — same conversation, files, Stop, needs you — and Back goes back", () => {
    const p = load();
    p.click(p.button("Next"));
    expect([p.text(), p.spotted()]).toEqual([expect.stringMatching(/same conversation as its Telegram or Discord/), ["mainArea"]]);
    p.click(p.button("Next"));
    expect([p.text(), p.spotted()]).toEqual([expect.stringMatching(/📎/), ["attachBtn"]]);
    p.click(p.button("Back"));
    expect(p.spotted()).toEqual(["mainArea"]);
    p.click(p.button("Next")); p.click(p.button("Next"));
    expect([p.text(), p.spotted()]).toEqual([expect.stringMatching(/Send becomes Stop/), ["sendBtn"]]);
    p.click(p.button("Next"));
    expect(p.text()).toMatch(/needs you/);
    expect(p.buttons().map(b => b.textContent)).toEqual(["Back", "Got it"]);
  });

  it("outlines Stop when it is showing, and a real needs-you badge when there is one", () => {
    const p = load();
    p.doc.fixed.stopBtn.hidden = false;
    const badge = p.doc.createElement("span"); badge.id = "badge"; badge.className = "badge-await"; p.doc.fixed.instanceList.append(badge);
    vm.runInContext("showTourStep(3)", p.c);
    expect(p.spotted()).toEqual(["stopBtn"]);
    vm.runInContext("showTourStep(4)", p.c);
    expect(p.spotted()).toEqual(["badge"]);
  });

  it("Got it closes it, clears the outline, and it never opens again on this device", () => {
    const storage = new Map<string, string>();
    const p = load(storage);
    for (let i = 0; i < 4; i++) p.click(p.button("Next"));
    p.click(p.button("Got it"));
    expect([p.card(), p.spotted(), storage.get("agend_tour_done")]).toEqual([null, [], "1"]);
    expect(load(storage).card()).toBeNull();
  });

  it("Skip and Esc dismiss it for good too", () => {
    const a = new Map<string, string>(), pa = load(a);
    pa.click(pa.button("Skip"));
    expect([pa.card(), a.get("agend_tour_done")]).toEqual([null, "1"]);
    const b = new Map<string, string>(), pb = load(b);
    pb.click(pb.button("Next"));
    pb.key("Escape");
    expect([pb.card(), pb.spotted(), b.get("agend_tour_done")]).toEqual([null, [], "1"]);
  });

  it("Esc with the tour closed still does what it did before (closes the drawer)", () => {
    const p = load(new Map([["agend_tour_done", "1"]]));
    p.doc.body.classList.add("sb-open");
    p.key("Escape");
    expect(p.doc.body.classList.contains("sb-open")).toBe(false);
  });

  it("a held Esc that closes the tour does not go on to Stop the agent; a new press does (#1369 review)", () => {
    const p = load();
    const stops: string[] = [];
    (p.c as any).stops = stops;
    // A busy chat where Esc would Stop: the page's own check says yes, and cancelReply records what it was asked.
    vm.runInContext('stopOnEscape = () => true; cancelReply = (name) => { stops.push(String(name)); }; cur = "w";', p.c);
    p.key("Escape");                                            // closes the tour
    expect([p.card(), stops]).toEqual([null, []]);
    p.key("Escape", true); p.key("Escape", true);               // the same key, held
    expect(stops).toEqual([]);
    p.key("Escape");                                            // released and pressed again: not a repeat
    expect(stops).toEqual(["w"]);
  });

  it("on a phone, Tour from the open drawer closes the drawer first; Esc then closes the tour and focus goes back to ☰ (#1369 review)", () => {
    const p = load(new Map([["agend_tour_done", "1"]]), "en", true);
    p.doc.body.classList.add("sb-open");
    p.doc.fixed.tourBtn.dataset.act = "startTour";
    p.doc.fixed.tourBtn.focus();
    p.click(p.doc.fixed.tourBtn);
    expect(p.doc.body.classList.contains("sb-open")).toBe(false);
    expect(p.card()).not.toBeNull();
    expect(p.doc.activeElement?.textContent).toBe("Next");
    p.key("Escape");
    expect([p.card(), p.doc.activeElement?.id]).toEqual([null, "sbOpen"]);
  });

  it("Esc closes an open drawer before the tour (the drawer is on top of the card)", () => {
    const p = load(new Map(), "en", true);
    p.doc.body.classList.add("sb-open");
    p.key("Escape");
    expect([p.doc.body.classList.contains("sb-open"), p.card() !== null]).toEqual([false, true]);
    p.key("Escape");
    expect(p.card()).toBeNull();
  });

  it("the outline follows a redraw on the same step: a new needs-you badge, Send swapped for Stop — same card, same focus (#1369 review)", () => {
    const p = load();
    vm.runInContext('instances = [{ name: "w", status: "running" }]; awaiting.w = ""; renderList();', p.c);
    vm.runInContext("showTourStep(4)", p.c);
    const first = p.spotted();
    expect(first[0]).toMatch(/^badge-/);
    const focused = p.doc.activeElement, card = p.card();
    vm.runInContext("renderList()", p.c);                       // a status update redraws the list: a new badge element
    expect(p.spotted()).toHaveLength(1);
    expect(p.spotted()[0]).not.toBe(first[0]);
    expect([p.card(), p.doc.activeElement]).toEqual([card, focused]);

    vm.runInContext("showTourStep(3)", p.c);
    expect(p.spotted()).toEqual(["sendBtn"]);
    (p.doc.fixed.msgIn as any).value = "";                      // nothing typed: a busy agent shows Stop alone
    vm.runInContext('cur = "w"; activity.w = "working"; renderComposerButtons();', p.c);  // idle → working
    expect([p.doc.fixed.stopBtn.hidden, p.doc.fixed.sendBtn.hidden]).toEqual([false, true]);
    expect(p.spotted()).toEqual(["stopBtn"]);
  });

  it("Tour in the sidebar replays it after it was dismissed", () => {
    const p = load(new Map([["agend_tour_done", "1"]]));
    expect(p.card()).toBeNull();
    expect(p.doc.fixed.tourBtn.textContent).toBe("Tour");
    p.doc.fixed.tourBtn.dataset.act = "startTour";
    p.click(p.doc.fixed.tourBtn);
    expect(p.text()).toMatch(/Pick an instance/);
  });

  it("when this browser's storage cannot be read, it is not shown at all (never on every load)", () => {
    expect(load(null).card()).toBeNull();
  });

  it("speaks zh-TW where the dashboard does", () => {
    const p = load(new Map(), "zh-TW");
    expect(p.text()).toMatch(/選一個 instance/);
    expect(p.buttons().map(b => b.textContent)).toEqual(["略過", "下一步"]);
  });

  it("is styled by classes in the page's own <style>: no style attribute, no inline style (#1300)", () => {
    // The fake DOM throws on any style access or style attribute; reaching the end of the tour is the check.
    const p = load();
    for (let i = 0; i < 4; i++) p.click(p.button("Next"));
    p.click(p.button("Got it"));
    const css = DASHBOARD.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    for (const cls of [".tour {", ".tour-spot {", ".tour .tour-foot"]) expect(css).toContain(cls);
    expect(DASHBOARD).not.toMatch(/id="tourBtn"[^>]*style=/);
  });
});
