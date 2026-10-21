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
  const host = { document: doc, innerWidth: 1366, innerHeight: 768, getComputedStyle: (el: any) => el.style }, snapshot = (opts: any = {}) => m.stockEffectTrust(host, { ownerCss: "off", ...opts });
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
  it.each(["status", "prompt"])("independently protects the actual %s topic-link producer", async place => {
    const f = await fixture(), dom = installDom();
    try {
      const shell = dom.document.createElement("div"); shell.className = "shell"; dom.document.body.append(shell);
      let parent = shell;
      for (const cls of place === "status" ? ["thread", "st-text"] : ["dock", "prompts", "txt"]) {
        const next = dom.document.createElement("div"); next.className = cls; parent.append(next); parent = next;
      }
      const actual = dom.document.createElement("a"); actual.className = "st-link"; actual.setAttribute("data-trust", "link"); parent.append(actual);
      const spec = f.m.STOCK_TRUST_INVENTORY.find((x: any) => x.kind === "link");
      expect(actual.matches(spec.selector)).toBe(true);
      expect(read(place === "status" ? "chat-thread.js" : "panel-chat.js")).toContain('<a data-trust="link" class="st-link"');
      const el = f.node(); el.r = { x: 310, y: 410, width: 90, height: 24 };
      el.getAttribute = () => actual.getAttribute("data-trust") ?? "";
      f.extra.set(spec.selector, [el]); f.marked.push(el);
      expect(f.snapshot()).toMatchObject({ ok: true, front: true, rects: expect.arrayContaining([el.r]) });
      actual.removeAttribute("data-trust"); expect(f.snapshot().ok).toBe(false);
      actual.setAttribute("data-trust", "thread-control"); expect(f.snapshot().ok).toBe(false);
      actual.setAttribute("data-trust", "link"); expect(f.snapshot().ok).toBe(true);
    } finally { dom.restore(); }
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
  it("protects the shared motion note and its controls, and refuses missing markers or wrong paint order", async () => {
    const f = await fixture(), dom = installDom();
    try {
      const shell = dom.document.createElement("div"), main = dom.document.createElement("div"), actual = dom.document.createElement("div");
      shell.className = "shell"; main.className = "chat-main"; actual.className = "amb-note";
      actual.setAttribute("data-trust", "thread-control"); shell.append(main); main.append(actual); dom.document.body.append(shell);
      const spec = f.m.STOCK_TRUST_INVENTORY.find((x: any) => x.kind === "thread-control");
      expect(spec.selector).toContain(".shell .chat-main > .amb-note"); expect(actual.matches(spec.selector)).toBe(true);
      const el = f.node({ position: "relative", zIndex: "1" }), button = f.node();
      el.r = { x: 300, y: 200, width: 400, height: 50 }; button.r = { x: 650, y: 210, width: 60, height: 35 }; el.children = [button];
      el.getAttribute = () => actual.getAttribute("data-trust") ?? "";
      f.extra.set(spec.selector, [el]); f.extra.set(".chat-main > .amb-note", [el]); f.marked.push(el);
      expect(f.snapshot()).toMatchObject({ ok: true, rects: expect.arrayContaining([{ x: 300, y: 200, width: 410, height: 50 }]) });
      el.style.zIndex = "-1"; expect(f.snapshot().ok).toBe(false); el.style.zIndex = "1";
      actual.removeAttribute("data-trust"); expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_trust_unknown" });
      actual.setAttribute("data-trust", "reply"); expect(f.snapshot().ok).toBe(false);
    } finally { dom.restore(); }
  });
  it.each([["div", "msg-actions"], ["button", "msg-quote"]])("admits the exact stock reply %s.%s producer and protects paint, rejecting other ancestry/markers", async (tag, cls) => {
    const f = await fixture(), dom = installDom();
    try {
      const shell = dom.document.createElement("div"), thread = dom.document.createElement("div"), message = dom.document.createElement("div"), actual = dom.document.createElement(tag);
      shell.className = "shell"; thread.className = "thread"; message.className = "msg"; actual.className = cls; actual.setAttribute("data-trust", "thread-control");
      shell.append(thread); thread.append(message); message.append(actual); dom.document.body.append(shell);
      const spec = f.m.STOCK_TRUST_INVENTORY.find((entry: any) => entry.kind === "thread-control"); expect(actual.matches(spec.selector)).toBe(true);
      const el = f.node(), button = f.node(); el.r = { x: 300, y: 200, width: 200, height: 40 }; button.r = { x: 400, y: 210, width: 30, height: 20 }; el.children = [button];
      el.getAttribute = () => actual.getAttribute("data-trust") ?? ""; f.extra.set(spec.selector, [el]); f.marked.push(el);
      expect(f.snapshot()).toMatchObject({ ok: true, rects: expect.arrayContaining([{ x: 300, y: 200, width: 200, height: 40 }]) });
      actual.setAttribute("data-trust", "reply"); expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_trust_unknown" }); actual.setAttribute("data-trust", "thread-control");
      thread.append(actual); expect(actual.matches(spec.selector)).toBe(false);
      f.extra.set(spec.selector, []); expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_trust_unknown" });
    } finally { dom.restore(); }
  });
  it("independently expects the actual inert offer root and protects its descendant paint", async () => {
    const f = await fixture(), dom = installDom();
    try {
      const shell = dom.document.createElement("div"), thread = dom.document.createElement("div"), actual = dom.document.createElement("div");
      shell.className = "shell"; thread.className = "thread"; actual.className = "effect-trial-offer"; actual.setAttribute("data-trust", "thread-control");
      shell.append(thread); thread.append(actual); dom.document.body.append(shell);
      const spec = f.m.STOCK_TRUST_INVENTORY.find((s:any) => s.kind === "thread-control");
      expect(spec.selector).toContain(".shell .thread .effect-trial-offer"); expect(actual.matches(spec.selector)).toBe(true);
      expect(read("chat-thread.js")).toContain('class="effect-trial-offer" data-trust="thread-control"');
      const el = f.node(), child = f.node(); el.r = { x: 300, y: 400, width: 120, height: 60 }; child.r = { x: 310, y: 410, width: 140, height: 20 }; el.children = [child];
      el.getAttribute = () => actual.getAttribute("data-trust") ?? "";
      f.extra.set(spec.selector, [el]); f.marked.push(el);
      expect(f.snapshot()).toMatchObject({ ok: true, front: true, rects: expect.arrayContaining([{ x: 300, y: 400, width: 150, height: 60 }]) });
      actual.removeAttribute("data-trust"); expect(actual.matches(spec.selector)).toBe(true); expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_trust_unknown" });
      actual.setAttribute("data-trust", "reply"); expect(f.snapshot().ok).toBe(false);
    } finally { dom.restore(); }
  });
  it("independently requires the imported click chip marker and bounds its descendant paint", async () => {
    const f = await fixture(), dom = installDom();
    try {
      const shell = dom.document.createElement("div"), thread = dom.document.createElement("div"), chip = dom.document.createElement("div");
      shell.className = "shell"; thread.className = "thread"; chip.className = "click-chip"; chip.setAttribute("data-trust", "thread-control"); shell.append(thread); thread.append(chip); dom.document.body.append(shell);
      const spec = f.m.STOCK_TRUST_INVENTORY.find((s: any) => s.kind === "thread-control"); expect(spec.selector).toContain(".shell .thread .click-chip"); expect(chip.matches(spec.selector)).toBe(true);
      const el = f.node(), button = f.node(); el.r = { x: 200, y: 300, width: 120, height: 40 }; button.r = { x: 205, y: 305, width: 130, height: 30 }; el.children = [button]; el.getAttribute = () => chip.getAttribute("data-trust") ?? "";
      f.extra.set(spec.selector, [el]); f.marked.push(el); expect(f.snapshot()).toMatchObject({ ok: true, rects: expect.arrayContaining([{ x: 200, y: 300, width: 135, height: 40 }]) });
      chip.removeAttribute("data-trust"); expect(f.snapshot().ok).toBe(false); chip.setAttribute("data-trust", "reply"); expect(f.snapshot().ok).toBe(false);
    } finally { dom.restore(); }
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
    const f = await fixture(); f.composer.children = Array.from({ length: 4096 }, () => f.node()); expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_paint_limit" });
    f.composer.children = []; f.marked.push(...Array(4095).fill(f.composer)); expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_marker_limit" });
  });
  it("500 messages' contained stock toolbars fit the original paint budget without inspecting descendants", async () => {
    const f = await fixture(), spec = f.m.STOCK_TRUST_INVENTORY.find((x: any) => x.kind === "thread-control");
    const roots = Array.from({ length: 1000 }, () => { const el = f.node({ display: "flex", contain: "paint", overflowX: "clip", overflowY: "clip", overflowClipMargin: "0px", borderImageSource: "none" }); el.kind = "thread-control"; el.matches = () => true; el.querySelectorAll = () => { throw Error("contained descendants must not be walked"); }; return el; });
    f.marked.push(...roots); f.extra.set(spec.selector, roots); expect(f.snapshot().ok).toBe(true);
  });
  it.each(["unsupported", "supported-zero", "unknown", "supported-missing", "expanded"])("%s clip-margin capability is handled without guessing", async mode => {
    const f = await fixture(), spec = f.m.STOCK_TRUST_INVENTORY.find((x: any) => x.kind === "thread-control");
    const el = f.node({ display: "flex", contain: "paint", overflowX: "clip", overflowY: "clip", borderImageSource: "none" });
    el.kind = "thread-control"; el.matches = () => true; el.children = [f.node({ filter: "blur(20px)" })];
    el.style.getPropertyValue = () => mode === "supported-zero" ? "0px" : mode === "expanded" ? "8px" : "";
    if (mode !== "unknown") (f.host as any).CSS = { supports: () => mode !== "unsupported" };
    f.marked.push(el); f.extra.set(spec.selector, [el]);
    expect(f.snapshot().ok).toBe(["unsupported", "supported-zero"].includes(mode));
  });
  it("a contained toolbar protects its whole clip, including fixed descendants, but refuses its own overflowing ink", async () => {
    const f = await fixture(), spec = f.m.STOCK_TRUST_INVENTORY.find((x: any) => x.kind === "thread-control");
    const el = f.node({ display: "flex", contain: "paint", overflowX: "clip", overflowY: "clip", overflowClipMargin: "0px", borderImageSource: "none" }); el.kind = "thread-control"; el.matches = () => true;
    const child = f.node({ position: "fixed" }); child.r = { x: 600, y: 600, width: 40, height: 30 }; el.children = [child]; f.marked.push(el); f.extra.set(spec.selector, [el]);
    expect(f.snapshot().rects).toContainEqual(el.r); expect(f.snapshot().rects.some((r: any) => r.x + r.width >= 640)).toBe(false);
    el.style.contain = "none"; expect(f.snapshot().rects.some((r: any) => r.x + r.width >= 640)).toBe(true);
    el.style.contain = "paint"; el.style.outlineStyle = "solid"; el.style.outlineWidth = "3px"; el.style.outlineOffset = "6px";
    expect(f.snapshot().ok).toBe(false); el.style.outlineStyle = "none";
    el.style.boxShadow = "rgb(0, 0, 0) 0px 0px 20px 0px"; expect(f.snapshot().ok).toBe(false);
  });
  it.each(["contents", "inline", "fragmented", "expanded-clip", "auto", "border-image"])("%s never borrows a clipped-box proof", async fault => {
    const f = await fixture(), spec = f.m.STOCK_TRUST_INVENTORY.find((x: any) => x.kind === "thread-control");
    const el = f.node({ display: "flex", contain: "paint", overflowX: "clip", overflowY: "clip", overflowClipMargin: "0px", borderImageSource: "none" }); el.kind = "thread-control"; el.matches = () => true;
    el.children = [f.node({ filter: "blur(20px)" })]; if (["contents", "inline"].includes(fault)) el.style.display = fault;
    if (fault === "fragmented") el.getClientRects = () => [el.r, el.r]; if (fault === "expanded-clip") el.style.overflowClipMargin = "8px";
    if (fault === "auto") el.style.contentVisibility = "auto"; if (fault === "border-image") el.style.borderImageSource = "url(blob:example)";
    f.marked.push(el); f.extra.set(spec.selector, [el]); expect(f.snapshot().ok).toBe(false);
  });
  it.each(["filter", "backdropFilter"])("the contained root's own %s output never borrows the descendant clip", async property => {
    const f = await fixture(), spec = f.m.STOCK_TRUST_INVENTORY.find((x: any) => x.kind === "thread-control");
    const el = f.node({ display: "flex", contain: "paint", overflowX: "clip", overflowY: "clip", overflowClipMargin: "0px", borderImageSource: "none" });
    el.kind = "thread-control"; el.matches = () => true; f.marked.push(el); f.extra.set(spec.selector, [el]);
    expect(f.snapshot().ok).toBe(true);
    el.style[property] = property === "filter" ? "drop-shadow(0px 0px 20px red)" : "blur(20px)";
    expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_paint_unknown" });
    el.style[property] = "none"; expect(f.snapshot().ok).toBe(true);
  });
  it.each(["border-image", "auto", "hidden"])("the ordinary descendant walk refuses %s paint independently of the toolbar shortcut", async fault => {
    const f = await fixture(), child = f.node(); f.composer.children = [child];
    expect(f.snapshot().ok).toBe(true);
    if (fault === "border-image") child.style.borderImageSource = "url(blob:example)";
    else child.style.contentVisibility = fault;
    expect(f.snapshot()).toMatchObject({ ok: false, reason: "stock_paint_unknown" });
    child.style.borderImageSource = "none"; child.style.contentVisibility = "visible"; expect(f.snapshot().ok).toBe(true);
  });
  it.each([1, 8, 9])("keeps a marker %ipx above the viewport only within the physical 8px clip margin", async edge => {
    const f = await fixture(), spec = f.m.STOCK_TRUST_INVENTORY.find((x: any) => x.kind === "link"), el = f.node();
    el.kind = "link"; el.r = { x: 300, y: -10 - edge, width: 80, height: 10 }; f.marked.push(el); f.extra.set(spec.selector, [el]);
    const proof = f.snapshot(); expect(proof.ok).toBe(true);
    if (edge <= 8) expect(proof.rects).toContainEqual(el.r); else expect(proof.rects).not.toContainEqual(el.r);
  });
  it("inventories a long conversation without spending holes on off-screen history", async () => {
    const f = await fixture(), spec = f.m.STOCK_TRUST_INVENTORY.find((x: any) => x.kind === "link");
    const history = Array.from({ length: 210 }, (_, i) => { const el = f.node(); el.kind = "link"; el.r = { x: 300, y: -10000 + i * 30, width: 80, height: 20 }; return el; });
    f.marked.push(...history); f.extra.set(spec.selector, history);
    const proof = f.snapshot(); expect(proof.ok).toBe(true); expect(proof.rects.length).toBe(2);
    // Off-screen producers are still checked: no missing marker, filter, or unknown producer can hide there.
    history[0].kind = ""; expect(f.snapshot().ok).toBe(false); history[0].kind = "link";
    history[0].style.filter = "blur(1px)"; expect(f.snapshot().ok).toBe(false);
  });
  it("bounds dense viewport holes by conservative union; every original rectangle stays protected", async () => {
    const f = await fixture(), spec = f.m.STOCK_TRUST_INVENTORY.find((x: any) => x.kind === "link");
    const dense = Array.from({ length: 200 }, (_, i) => { const el = f.node(); el.kind = "link"; el.r = { x: 200 + i % 20 * 10, y: 200 + Math.floor(i / 20) * 20, width: 8, height: 16 }; return el; });
    f.marked.push(...dense); f.extra.set(spec.selector, dense);
    const proof = f.snapshot(); expect(proof.ok).toBe(true); expect(proof.rects).toHaveLength(128);
    for (const { r } of dense) expect(proof.rects.some((b: any) => b.x <= r.x && b.y <= r.y && b.x + b.width >= r.x + r.width && b.y + b.height >= r.y + r.height)).toBe(true);
  });
  it("protects descendants and derives conservative shadow/focus outsets; unknown paint refuses", async () => {
    const f = await fixture(); f.composer.style.boxShadow = "rgba(0, 0, 0, 0.3) 0px 2px 4px 1px";
    expect(f.snapshot().rects).toContainEqual({ x: -5, y: 5, width: 130, height: 80 });
    f.composer.style.boxShadow = "none"; f.composer.style.outlineStyle = "solid"; f.composer.style.outlineWidth = "2px"; f.composer.style.outlineOffset = "3px";
    expect(f.snapshot().rects).toContainEqual({ x: 5, y: 15, width: 110, height: 60 });
    f.composer.style.textShadow = "1px 1px blue"; expect(f.snapshot().ok).toBe(false);
  });
  it("#2086: the banner fill's one stock filter — exact value, exact element, clipped by its box (its paint is the box); anything else refuses", async () => {
    const f = await fixture();
    expect(read("shared/app.css")).toContain(`filter: ${f.m.STOCK_BANNER_FILL_FILTER};`);
    const card: any = f.node(), box: any = f.node({ overflowX: "hidden", overflowY: "hidden", position: "relative" }), fill: any = f.node({ filter: f.m.STOCK_BANNER_FILL_FILTER, position: "absolute" }), banner: any = f.node();
    card.kind = "card"; card.r = { x: 0, y: 100, width: 800, height: 260 }; box.r = { x: 0, y: 100, width: 800, height: 200 };
    fill.r = { x: -160, y: 60, width: 1120, height: 280 };                 // scaled up by its transform: beyond the box
    banner.r = { x: 150, y: 100, width: 500, height: 200 };
    fill.parentElement = box; fill.offsetParent = box; fill.matches = (sel: string) => sel === ".id-banner-box > img.id-banner-fill";
    card.children = [box, fill, banner];
    const spec = f.m.STOCK_TRUST_INVENTORY.find((s: any) => s.kind === "card");
    f.extra.set(spec.selector, [card]); f.marked.push(card);
    expect(f.snapshot()).toMatchObject({ ok: true, rects: expect.arrayContaining([{ x: 0, y: 100, width: 800, height: 260 }]) });
    for (const [what, change, undo] of [
      ["another filter value", () => { fill.style.filter = "blur(25px) saturate(0.75) brightness(0.7)"; }, () => { fill.style.filter = f.m.STOCK_BANNER_FILL_FILTER; }],
      ["a box that does not clip", () => { box.style.overflowY = "visible"; }, () => { box.style.overflowY = "hidden"; }],
      ["a filter on another element", () => { fill.matches = () => false; }, () => { fill.matches = (sel: string) => sel === ".id-banner-box > img.id-banner-fill"; }],
      ["a backdrop filter with it", () => { fill.style.backdropFilter = "blur(2px)"; }, () => { fill.style.backdropFilter = "none"; }],
      ["the same filter on the banner itself", () => { banner.style.filter = f.m.STOCK_BANNER_FILL_FILTER; }, () => { banner.style.filter = "none"; }],
      // #2089 review: the box clips only what it contains — a fixed fill is the viewport's; a static box is no one's.
      ["a fixed fill (the viewport's, never clipped by the box)", () => { fill.style.position = "fixed"; }, () => { fill.style.position = "absolute"; }],
      ["a static (relative-less) fill", () => { fill.style.position = "static"; }, () => { fill.style.position = "absolute"; }],
      ["a box that is not its containing block", () => { box.style.position = "static"; }, () => { box.style.position = "relative"; }],
      // #2089 review r3: `display: contents` keeps position and overflow but generates no box — an outer ancestor places
      // the fill (as the browser reports it) and the box's rect is empty; an inline box does not clip the same way.
      ["a box with display: contents", () => { box.style.display = "contents"; fill.offsetParent = card; }, () => { box.style.display = "block"; fill.offsetParent = box; }],
      ["display: contents even if the offset parent looked right", () => { box.style.display = "contents"; }, () => { box.style.display = "block"; }],
      ["an inline box", () => { box.style.display = "inline"; }, () => { box.style.display = "block"; }],
      ["an inline-block box", () => { box.style.display = "inline-block"; }, () => { box.style.display = "block"; }],
      ["a fill placed by another ancestor", () => { fill.offsetParent = card; }, () => { fill.offsetParent = box; }],
    ] as Array<[string, () => void, () => void]>) {
      change(); expect(f.snapshot(), what).toMatchObject({ ok: false, reason: "stock_paint_unknown" }); undo();
    }
    expect(f.snapshot().ok).toBe(true);
  });
  it("never serializes DOMRect prototypes or unknown geometry", async () => {
    const f = await fixture(); f.composer.r.x = Number.NaN; expect(f.snapshot().ok).toBe(false);
    f.composer.r.x = 1e8; expect(f.snapshot().ok).toBe(false);
  });
  it("overlays suppress fronts; editable focus keeps protected rectangles without suppressing unrelated paint", async () => {
    const f = await fixture(); const popup = f.node();
    f.doc.querySelectorAll = ((old: any) => (s: string) => s.startsWith('[role=menu]') ? [popup] : old(s))(f.doc.querySelectorAll);
    expect(f.snapshot()).toMatchObject({ ok: true, front: false, agentFront: false, reason: "stock_overlay" });
    popup.style.display = "none"; f.doc.activeElement = { matches: () => true }; const proof = f.snapshot(); expect(proof).toMatchObject({ front: true, agentFront: true }); expect(proof.rects).toContainEqual(f.composer.r);
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
