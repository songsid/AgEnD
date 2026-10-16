/** Unmounted closed stock contract; actual component/paint evidence is the separate native recipe. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDom } from "./helpers/mini-dom.js";
import { isServedAsset } from "../src/auth-api.js";
const UI = join(process.cwd(), "src/ui"), read = (p: string) => readFileSync(join(UI, p), "utf8");
async function fixture() {
  const m = await import("/assets/effect-stock-trust.js"), doc: any = {}, nodes = new Map<string, any>(), marked: any[] = [];
  const style = () => ({ opacity: "1", isolation: "auto", mixBlendMode: "normal", contain: "none", willChange: "auto", zIndex: "auto", position: "static", display: "block", visibility: "visible", transform: "none", filter: "none", backdropFilter: "none", clipPath: "none", maskImage: "none", boxShadow: "none", textShadow: "none", outlineStyle: "none" });
  const node = (over: any = {}) => ({ ownerDocument: doc, isConnected: true, parentElement: null, style: { ...style(), ...over }, kind: "", r: { x: 10, y: 20, width: 100, height: 50 }, children: [] as any[],
    getAttribute() { return this.kind; }, getBoundingClientRect() { return this.r; }, getClientRects() { return ["none", "contents"].includes(this.style.display) ? [] : [this.r]; },
    querySelectorAll() { return this.children; }, querySelector() { return null; }, classList: { contains: (s: string) => s === "agend-effect-layer" }, matches() { return false; },
  });
  const structural = ["html", "body", "#app", "#app > .shell", ".shell > .main", ".main > .p-chat", ".p-chat > .chat-split", ".chat-split > .chat-main"];
  for (const s of structural) nodes.set(s, node()); doc.body = nodes.get("body"); doc.documentElement = nodes.get("html"); nodes.get("#app").parentElement = doc.body;
  const composer = node({ position: "relative", zIndex: "1" }), header = node({ position: "relative", zIndex: "2" }); composer.kind = "composer"; header.kind = "header"; marked.push(composer, header);
  const extra = new Map<string, any[]>(); extra.set(".chat-main > .dock", [composer]); extra.set(".p-chat > .panel-head", [header]);
  extra.set(".shell .p-chat .chat-main > .dock", [composer]); extra.set(".shell .panel-head", [header]);
  nodes.get(".main > .p-chat").querySelector = (s: string) => s.startsWith(".dock") ? composer : s.startsWith(".panel-head") ? header : null;
  doc.getElementById = (id: string) => nodes.get(`#${id}`) ?? null; doc.querySelector = (s: string) => nodes.get(s) ?? null;
  doc.querySelectorAll = (s: string) => s === "[data-trust]" ? marked : s === "#app > .shell" ? [nodes.get(s)] : s === ".main > .panel" ? [nodes.get(".main > .p-chat")] : extra.get(s) ?? [];
  doc.activeElement = doc.body;
  const host = { document: doc, innerWidth: 1366, getComputedStyle: (el: any) => el.style }, snapshot = (opts: any = {}) => m.stockEffectTrust(host, { ownerCss: "off", ...opts });
  return { m, doc, node, nodes, marked, composer, header, extra, host, snapshot };
}
describe("stock trust/paint prerequisite", () => {
  it("serves the closed stock proof; categories include the actual portal exceptions", async () => {
    const { m } = await fixture(); expect(isServedAsset("effect-stock-trust.js")).toBe(true);
    expect(m.STOCK_TRUST_INVENTORY.map((s: any) => s.kind)).toEqual(["composer", "reply", "navigation", "header", "status", "usage", "widget", "card", "permission", "menu", "session", "popover", "dialog", "lightbox", "tour", "keep", "toast", "confirmation", "preview", "preview-menu", "palette", "drop", "thread-control", "link", "attachment", "media", "panel-navigation", "panel-content", "panel-controls", "session-ended"]);
    expect(Object.isFrozen(m.STOCK_TRUST_INVENTORY)).toBe(true);
    expect(read("shared/app.js")).not.toContain("effect-stock-trust");
  });
  it("matches the actual fixed marker producers, including generated reply/poll HTML and direct-body portals", () => {
    for (const [file, kind] of [["panel-chat.js", "composer"], ["chat-thread.js", "reply"], ["shared/ui-menu.js", "menu"], ["shared/ui-dialog.js", "dialog"], ["image-lightbox.js", "lightbox"], ["shared/app-session.js", "session"], ["shared/owner-css.js", "keep"], ["shared/ui-toast.js", "toast"], ["shared/agent-widget.js", "widget"], ["panel-needs.js", "permission"], ["preview-panel.js", "preview"], ["shared/header-tools.js", "usage"]]) expect(read(file!), `${file}:${kind}`).toContain(`data-trust="${kind}"`);
    expect(read("panel-chat.js")).toContain('<div data-trust="card"'); expect(read("panel-chat.js")).toContain('<button data-trust="thread-control" type="button" class="jump-latest"'); expect(read("shared/app-shell.js")).toContain('<div data-trust="navigation" class="side-resize"');
    expect(read("chat-thread.js")).toContain('<ul data-trust="reply" class="poll-voters"');
    expect(read("chat-render.js")).toContain('data-trust="link"'); expect(read("chat-render.js")).toContain('data-trust="attachment"'); expect(read("chat-render.js")).toContain('data-trust="media"');
    for(const cls of ["cb-head","cb-more","tc-head","tc-more","pv-head","pv-banner","pv-note"]) expect(read("chat-thread.js")).toMatch(new RegExp(cls+'.*setAttribute\\("data-trust", "thread-control"\\)'));
    expect(read("chat-tour.js")).toContain('setAttribute("data-trust", "tour")');
    expect(read("shared/agend-auth.js")).toContain('setAttribute("data-trust", "session-ended")');
  });
  it("the real closed barrier selector suppresses Trial at desktop width while ordinary preview stays nonmodal", async () => {
    const f = await fixture(), real = installDom();
    try {
      const actual = real.document.createElement("aside"); actual.className = "pv-panel effect-trial-panel";
      const panel = f.node({ position: "relative", zIndex: "1" }); panel.kind = "preview"; f.marked.push(panel);
      f.extra.set(".shell .chat-split > .pv-panel, .shell .chat-split > .pv-divider", [panel]);
      f.extra.set(".chat-split > .pv-panel, .chat-split > .pv-divider", [panel]);
      const query = f.doc.querySelectorAll;
      f.doc.querySelectorAll = (selector: string) => selector === f.m.STOCK_EFFECT_BARRIERS ? actual.matches(selector) ? [panel] : [] : query(selector);
      expect(f.host.innerWidth).toBe(1366); expect(actual.matches(f.m.STOCK_EFFECT_BARRIERS)).toBe(true);
      expect(f.snapshot()).toMatchObject({ ok: true, front: false, agentFront: false, reason: "stock_overlay" });
      actual.className = "pv-panel"; expect(actual.matches(f.m.STOCK_EFFECT_BARRIERS)).toBe(false);
      expect(f.snapshot()).toMatchObject({ ok: true, front: true, agentFront: true, reason: "stock" });
    } finally { real.restore(); }
  });
  it("stock root/content order admits a bounded plain rect list and distinguishes CSS from modal restrictions", async () => {
    const f = await fixture(); expect(f.snapshot()).toMatchObject({ ok: true, front: true, agentFront: true, reason: "stock" });
    for (const ownerCss of ["on", "loading", "unknown", undefined]) expect(f.m.stockEffectTrust(f.host, { ownerCss })).toMatchObject({ ok: true, front: true, agentFront: false, agentReason: "owner_css", settingsHref: "/settings/appearance" });
    expect(f.snapshot().rects).toEqual([{ x: 10, y: 20, width: 100, height: 50 }, { x: 10, y: 20, width: 100, height: 50 }]);
  });
  it.each(["html", "body", "#app", "#app > .shell", ".shell > .main", ".main > .p-chat", ".p-chat > .chat-split", ".chat-split > .chat-main"])("refuses structural stacking mismatch at %s", async key => {
    const f = await fixture(); f.nodes.get(key).style.zIndex = "1"; expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_order_unknown" });
  });
  it.each([{ transform: "matrix(1,0,0,1,1,0)" }, { opacity: ".9" }, { isolation: "isolate" }, { mixBlendMode: "multiply" }, { contain: "paint" }, { willChange: "transform" }, { filter: "blur(1px)" }, { maskImage: "url(x)" }])("unknown structural paint fails closed: %j", async over => {
    const f = await fixture(); Object.assign(f.nodes.get("#app").style, over); expect(f.snapshot().ok).toBe(false);
  });
  it.each(["fixed", "sticky"])("structural position %s cannot introduce an implicit stacking context", async position => {
    const f = await fixture(); f.nodes.get("#app").style.position = position; expect(f.snapshot().ok).toBe(false);
  });
  it("display:contents cannot bypass the content band while children still paint", async () => {
    const f = await fixture(); f.composer.style.display = "contents"; f.composer.children = [f.node()]; expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_order_unknown" });
  });
  it("header level2 keeps nested menus above the later scroller level1", async () => {
    const f = await fixture(); f.header.style.zIndex = "1"; expect(f.snapshot().ok).toBe(false);
  });
  it("requires stock content to own level1, without pretending the entire app should be raised", async () => {
    const f = await fixture(); f.composer.style.zIndex = "-1"; expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_order_unknown" });
    f.composer.style.zIndex = "1"; f.composer.style.position = "static"; expect(f.snapshot().ok).toBe(false);
    expect(read("shared/app.css")).toContain('.app-root { z-index: auto; }');
  });
  it.each([
    "linear-gradient(to right, rgb(0, 0, 0) calc(100% - 32px), rgba(0, 0, 0, 0))",
    "linear-gradient(to right, rgb(0 0 0) calc(100% - 32px), rgb(0 0 0 / 0))",
  ])("only the exact narrow stock widget fade is supported: %s", async maskImage => {
    const f = await fixture(); const widget = f.node({ position: "relative", zIndex: "1", maskImage });
    f.extra.set(".p-chat > .aw-chat_header", [widget]); f.host.innerWidth = 390;
    expect(f.snapshot().ok).toBe(true);
    f.host.innerWidth = 900; expect(f.snapshot().ok).toBe(false);
    f.host.innerWidth = 390; f.nodes.get("#app").style.maskImage = maskImage; expect(f.snapshot().ok).toBe(false);
    f.nodes.get("#app").style.maskImage = "none"; f.composer.style.maskImage = maskImage; expect(f.snapshot().ok).toBe(false);
  });
  it.each(["url(x)", "linear-gradient(to right, rgb(0, 0, 0) calc(100% - 31px), rgba(0, 0, 0, 0))", "linear-gradient(to left, rgb(0, 0, 0) calc(100% - 32px), rgba(0, 0, 0, 0))"])("unknown widget masks fail closed: %s", async maskImage => {
    const f = await fixture(); f.host.innerWidth = 390; f.extra.set(".p-chat > .aw-chat_header", [f.node({ position: "relative", zIndex: "1", maskImage })]); expect(f.snapshot().ok).toBe(false);
  });
  it("new controls are in independent expected selectors, not discovered only through their marker", async () => {
    const {m}=await fixture();const selectors=Object.fromEntries(m.STOCK_TRUST_INVENTORY.map((s:any)=>[s.kind,s.selector]));
    expect(selectors.navigation).toContain(".shell .side-resize");expect(selectors["thread-control"]).toContain(".shell .p-chat .jump-latest");expect(selectors.card).toBe(".shell .p-chat > .chat-card");
  });
  it.each(["card", "jump", "resize"])("independently expects %s even with a missing/wrong marker", async which => {
    const f = await fixture(), spec = f.m.STOCK_TRUST_INVENTORY.find((s:any) => s.kind === (which === "card" ? "card" : which === "resize" ? "navigation" : "thread-control"));
    const el=f.node();el.kind=spec.kind;f.extra.set(spec.selector,[el]);f.marked.push(el);expect(f.snapshot().ok).toBe(true);
    el.kind="";expect(f.snapshot().ok).toBe(false);el.kind="wrong";expect(f.snapshot().ok).toBe(false);
  });
  it.each([{zIndex:"-1"},{transform:"matrix(1,0,0,1,0,0)"},{opacity:".5"},{filter:"blur(1px)"},{position:"static"}])("desktop preview paint ordering refuses %j", async over => {
    const f=await fixture(), el=f.node({position:"relative",zIndex:"1"});f.extra.set(".chat-split > .pv-panel, .chat-split > .pv-divider",[el]);expect(f.snapshot().ok).toBe(true);Object.assign(el.style,over);expect(f.snapshot()).toMatchObject({ok:false,reason:"stock_order_unknown"});
  });
  it("a display:contents preview cannot leave visible children outside its paint band", async () => {
    const f=await fixture(),el=f.node({position:"relative",zIndex:"1",display:"contents"});el.children=[f.node()];f.extra.set(".chat-split > .pv-panel, .chat-split > .pv-divider",[el]);expect(f.snapshot().ok).toBe(false);
  });
  it("sidebar resize has its own positive band and cannot inherit an unknown sidebar context", async () => {
    const f=await fixture(),resize=f.node({position:"absolute",zIndex:"5"}),sidebar=f.node({position:"relative"});f.extra.set(".shell .side-resize",[resize]);f.extra.set(".shell > .sidebar, .shell > .u-rail",[sidebar]);expect(f.snapshot().ok).toBe(true);
    resize.style.zIndex="-1";expect(f.snapshot().ok).toBe(false);resize.style.zIndex="5";sidebar.style.zIndex="-1";expect(f.snapshot().ok).toBe(false);sidebar.style.zIndex="auto";sidebar.style.isolation="isolate";expect(f.snapshot().ok).toBe(false);
  });
  it("a missing/unknown marker is not silently absent coverage, even when hidden", async () => {
    const f = await fixture(); f.composer.kind = ""; f.composer.style.display = "none"; expect(f.snapshot().ok).toBe(false);
    f.composer.kind = "composer"; const fake = f.node(); fake.kind = "permission"; f.marked.push(fake); expect(f.snapshot().ok).toBe(false);
  });
  it("caps markers and protected descendants", async () => {
    const f = await fixture(); f.composer.children = Array.from({ length: 4096 }, () => f.node()); expect(f.snapshot().ok).toBe(false);
    f.composer.children = []; f.marked.push(...Array(127).fill(f.composer)); expect(f.snapshot().ok).toBe(false);
  });
  it("protects descendants and derives conservative shadow/focus outsets; unknown paint refuses", async () => {
    const f = await fixture(); f.composer.style.boxShadow = "rgba(0, 0, 0, 0.3) 0px 2px 4px 1px";
    expect(f.snapshot().rects).toContainEqual({ x: -5, y: 5, width: 130, height: 80 });
    f.composer.style.boxShadow = "none"; f.composer.style.outlineStyle = "solid"; f.composer.style.outlineWidth = "2px"; f.composer.style.outlineOffset = "3px";
    expect(f.snapshot().rects).toContainEqual({ x: 5, y: 15, width: 110, height: 60 });
    f.composer.style.textShadow = "1px 1px blue"; expect(f.snapshot().ok).toBe(false);
  });
  it("never serializes DOMRect prototypes or unknown geometry", async () => {
    const f = await fixture(); f.composer.r.x = Number.NaN; expect(f.snapshot().ok).toBe(false);
    f.composer.r.x = 1e8; expect(f.snapshot().ok).toBe(false);
  });
  it("overlay/focus suppresses every front; CSS restriction affects agent fronts only", async () => {
    const f = await fixture(); const popup = f.node();
    f.doc.querySelectorAll = ((old: any) => (s: string) => s.startsWith('[role=menu]') ? [popup] : old(s))(f.doc.querySelectorAll);
    expect(f.snapshot()).toMatchObject({ ok: true, front: false, agentFront: false, reason: "stock_overlay" });
    popup.style.display = "none"; f.doc.activeElement = { matches: () => true }; expect(f.snapshot().front).toBe(false);
  });
  it.each(["fullscreenElement", "pictureInPictureElement"])("native %s suppresses every front", async key => {
    const f = await fixture(); f.doc[key] = f.node(); expect(f.snapshot()).toMatchObject({ ok: true, front: false, agentFront: false, reason: "stock_overlay" });
  });
  it("session end and a foreign/transformed frame root refuse all admission", async () => {
    const f = await fixture(), root = f.node(); expect(f.snapshot({ frameRoot: root }).ok).toBe(false);
    root.parentElement = f.doc.body; expect(f.snapshot({ frameRoot: root }).ok).toBe(true);
    root.style.contain = "paint"; expect(f.snapshot({ frameRoot: root }).ok).toBe(false);
    f.nodes.set(".agend-session-ended", f.node()); expect(f.snapshot()).toMatchObject({ ok: false, reason: "session_ended" });
  });
});
