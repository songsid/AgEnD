/** #1629: stock shell inventory/paint prerequisite. No frame creation, effect code, content or network reads. */
const SPECS = [
  ["composer", ".shell .p-chat .chat-main > .dock"],
  ["reply", ".shell .thread .rb-row, .shell .thread .poll-voters"],
  ["navigation", ".shell .side-head, .shell .side-nav, .shell .side-section, .shell .side-foot, .shell .tabs, .shell .skip, .shell .side-resize"],
  ["header", ".shell .panel-head"], ["status", ".shell .main > .conn"], ["usage", ".shell > .u-rail"],
  ["widget", ".shell .aw, .shell .side-widget"], ["card", ".shell .p-chat > .chat-card"], ["permission", ".shell .n-item, .shell .dock .prompts"],
  ["menu", ".shell .menu-list[role=menu]"], ["session", ".shell .side-foot .pop[role=dialog]"],
  ["popover", ".shell .prefs-pop > .pop"], ["dialog", ".shell dialog.dlg"], ["lightbox", ".shell dialog.lb"],
  ["tour", "body > #tour.tour[role=dialog]"], ["keep", ".shell > .oc-keep"], ["toast", ".shell > .toasts"],
  ["confirmation", ".shell > .pending-stack, .shell .p-settings > .panel-body > .col > .pending-stack.inline"], ["preview", ".shell .chat-split > .pv-panel, .shell .chat-split > .pv-divider"],
  ["preview-menu", ".shell .thread details.pv-menu"], ["palette", ".shell .dock .cmd-palette"],
  ["drop", ".shell .p-chat > .drop-overlay"],
  ["thread-control", ".shell .chat-main > .amb-note, .shell .p-chat .jump-latest, .shell .thread .msg-tools, .shell .thread .msg > div.msg-actions, .shell .thread .msg > button.msg-quote, .shell .thread .st-more, .shell .thread .cb-head, .shell .thread .cb-more, .shell .thread .tc-head, .shell .thread .tc-more, .shell .thread .pv-head, .shell .thread .pv-note, .shell .thread .pv-banner, .shell .thread .effect-trial-offer, .shell .thread .click-chip"],
  ["link", ".shell .thread .md a, .shell .thread .st-text > a.st-link, .shell .dock .prompts .txt > a.st-link"], ["attachment", ".shell .thread .atts"], ["media", ".shell .thread .att-media"],
  ["panel-navigation", ".shell .p-fleet > .seg, .shell .p-settings > .seg"],
  ["panel-content", ".shell .p-fleet > .panel-body, .shell .p-needs > .panel-body, .shell .p-settings > .panel-body, .shell .p-log > .panel-body, .shell .p-details > .panel-body, .shell .p-view > .panel-body, .shell .p-view > .v-term, .shell .p-view > .v-id, .shell .p-view > .v-card"],
  ["panel-controls", ".shell .p-log > .log-bar, .shell .p-settings > .s-pending"],
  ["session-ended", "body > .agend-session-ended[role=alert]"],
];
export const STOCK_TRUST_INVENTORY = Object.freeze(SPECS.map(([kind, selector]) => Object.freeze({ kind, selector })));
const STRUCTURAL = ["html", "body", "#app", "#app > .shell", ".shell > .main", ".main > .p-chat", ".p-chat > .chat-split", ".chat-split > .chat-main"];
const CONTENT = [".main > .conn", ".p-chat > .panel-head", ".p-chat > .chat-card", ".p-chat > .aw-chat_header", ".chat-main > .amb-note", ".chat-main > .scroller", ".chat-main > .dock", ".sidebar > .side-head", ".sidebar > .side-nav", ".sidebar > .side-section", ".sidebar > .side-widget", ".sidebar > .side-foot", ".u-rail > .u-rail-head", ".u-rail > .u-rail-body"];
// Closed producer/topology inventory. Bare Outlet loading/error panels never become an effect surface.
const PANELS = Object.freeze({
  fleet: { required: [".panel-head", ".seg", ".panel-body"], optional: [] },
  needs: { required: [".panel-head", ".panel-body"], optional: [] },
  settings: { required: [".panel-head", ".seg", ".panel-body"], optional: [".s-pending"] },
  log: { required: [".panel-head", ".panel-body"], optional: [".log-bar"] },
  details: { required: [".panel-head", ".panel-body"], optional: [] },
  view: { required: [".panel-head"], optional: [".panel-body", ".v-term", ".v-id", ".v-card"] },
});
function panelSurface(doc, chat) {
  if (chat) return { panel: chat, structural: STRUCTURAL, content: CONTENT, kind: "chat" };
  const panel = doc.querySelector(".main > .panel"), kind = panel?.getAttribute("data-effect-panel"), spec = Object.hasOwn(PANELS, kind) ? PANELS[kind] : null;
  if (!spec || panel.className !== `panel p-${kind}` || [...panel.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())) return null;
  const children = [...panel.children], count = selector => children.filter(el => el.matches(selector)).length;
  if (spec.required.some(selector => count(selector) !== 1) || spec.optional.some(selector => count(selector) > 1)
    || children.some(el => !el.matches([...spec.required, ...spec.optional, "dialog.dlg", "dialog.lb"].join(",")))) return null;
  if (kind === "view" && !(count(".panel-body") === 1 && !count(".v-term") && !count(".v-id") && !count(".v-card")
    || !count(".panel-body") && count(".v-term") === 1 && count(".v-card") === 1)) return null;
  const prefix = `.p-${kind} > `;
  return { panel, kind, structural: [...STRUCTURAL.slice(0, 5), `.main > .p-${kind}`],
    content: [...CONTENT.filter(selector => !selector.startsWith(".p-chat") && !selector.startsWith(".chat-main")),
      ...[...spec.required, ...spec.optional].map(selector => prefix + selector)] };
}
const BARRIERS = '[role=menu],[role=dialog],[role=alertdialog],[role=listbox],dialog[open],details[open],.toast,.pending-stack:not(.inline),.oc-keep,.shell.sb-open,.p-chat.dragging,.agend-session-ended,audio[controls],video[controls],.effect-trial-panel';
/** Shared closed overlay list; a trial may exclude only its own positively identified panel. */
export const STOCK_EFFECT_BARRIERS = BARRIERS;
const finite = n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e7;
const none = x => x === "" || x === undefined || x === "none";
// The stock narrow header fades its own pixels inside its already bounded content context.
// This exception is never applied to an ancestor or another content surface.
function stockWidgetMask(host, selector, style) {
  return selector === ".p-chat > .aw-chat_header" && host.innerWidth < 900
    && typeof style.maskImage === "string"
    && /^linear-gradient\(to right, (?:rgb\(0, 0, 0\)|rgb\(0 0 0\)) calc\(100% - 32px\), (?:rgba\(0, 0, 0, 0\)|rgb\(0 0 0 \/ 0\))\)$/.test(style.maskImage);
}
function neutral(style, allowStockMask = false) {
  return !!style && ["transform", "perspective", "filter", "backdropFilter", "rotate", "scale", "translate", "offsetPath", "clipPath"].every(k => none(style[k])) && (none(style.maskImage) || allowStockMask)
    && style.opacity === "1" && style.isolation === "auto" && style.mixBlendMode === "normal" && style.contain === "none" && style.willChange === "auto"
    && (style.contentVisibility === undefined || ["", "visible"].includes(style.contentVisibility)) && (style.zoom === undefined || ["", "1", "normal"].includes(style.zoom));
}
function rect(el) {
  const r = el.getBoundingClientRect();
  return [r.x, r.y, r.width, r.height].every(finite) && r.width >= 0 && r.height >= 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}
function visible(host, el) {
  if (!el || el.isConnected !== true) return false;
  // A descendant of a closed details/dialog may have a styled box but no painted client rect.
  const s = host.getComputedStyle(el);
  return s.display !== "none" && s.visibility === "visible" && s.opacity !== "0" && el.getClientRects().length > 0;
}
/** Conservatively include stock outer shadows and focus outlines, not only the border box. Unknown paint refuses. */
function outset(style) {
  let pad = 0;
  if (!none(style.textShadow)) return null;
  if (style.outlineStyle !== "none") {
    const width = parseFloat(style.outlineWidth), offset = parseFloat(style.outlineOffset);
    if (![width, offset].every(Number.isFinite)) return null;
    pad = Math.max(pad, width + Math.max(0, offset));
  }
  if (!none(style.boxShadow)) {
    // Computed colors may contain commas; remove closed color functions before splitting the shadow list.
    const shadow = style.boxShadow.replace(/(?:rgba?|color|color-mix)\([^()]*\)/g, "color");
    for (const part of shadow.split(",")) {
      if (/\binset\b/.test(part)) continue;
      const lengths = [...part.matchAll(/(-?\d+(?:\.\d+)?)px\b/g)].map(m => Number(m[1]));
      if (lengths.length < 2 || lengths.length > 4 || !lengths.every(Number.isFinite)) return null;
      const [x, y, blur = 0, spread = 0] = lengths;
      if (blur < 0) return null;
      // Stock blur support is bounded generously; no arbitrary constant padding is the security argument.
      pad = Math.max(pad, Math.abs(x) + 3 * blur + Math.max(0, spread), Math.abs(y) + 3 * blur + Math.max(0, spread));
    }
  }
  return pad <= 256 ? Math.ceil(pad) : null;
}
/**
 * #2086: the identity card's banner fill (a blurred copy beside a centred banner) — the one filter stock admits. Only
 * this exact value, on exactly `.id-banner-box > img.id-banner-fill`, absolutely positioned in that box (so the box is
 * its containing block — #2089 review: a fixed fill is the viewport's, and no box clips it), and the box positioned and
 * clipping on both axes; its paint is then that box's rectangle (the blur and its scale never leave it). The box must
 * also be a real block box that the browser reports as the fill's offset parent (#2089 review r3: `display: contents`
 * keeps the computed position and overflow but generates no box, so an outer ancestor would place the fill, and an inline
 * box clips differently). Anything else with a filter refuses.
 */
export const STOCK_BANNER_FILL_FILTER = "blur(24px) saturate(0.75) brightness(0.7)";
function stockBannerFill(host, el) {
  const box = el.parentElement;
  if (typeof el.matches !== "function" || !el.matches(".id-banner-box > img.id-banner-fill") || !box) return null;
  const s = host.getComputedStyle(el), b = host.getComputedStyle(box);
  if (s.filter !== STOCK_BANNER_FILL_FILTER || !none(s.backdropFilter) || !none(b.filter) || !none(b.backdropFilter)) return null;
  if (!["hidden", "clip"].includes(b.overflowX) || !["hidden", "clip"].includes(b.overflowY)) return null;
  if (s.position !== "absolute" || !["relative", "absolute"].includes(b.position)) return null;
  if (b.display !== "block" || el.offsetParent !== box) return null;
  return rect(box);
}
function zeroClipMargin(host, style) {
  const margin = style.overflowClipMargin ?? style.getPropertyValue?.("overflow-clip-margin");
  // WebKit versions without this property still implement paint containment. An absent
  // computed value is usable only when the engine explicitly reports it unsupported;
  // unknown capability or a supported but unreadable/expanded margin cannot prove a box.
  return margin === "0px" || [undefined, ""].includes(margin)
    && host.CSS?.supports?.("overflow-clip-margin", "1px") === false;
}
function protectedPaint(host, root, budget) {
  // These two stock toolbar boxes physically clip ALL descendants, including fixed-position
  // children. Their entire box is a hole; descendant ink cannot escape it. Inline, fragmented,
  // expanded-clip or CSS-overridden boxes take the ordinary bounded walk instead.
  const s = host.getComputedStyle(root);
  if (root.matches?.(".shell .thread .msg-tools, .shell .thread .codeblock > .cb-head") && s.contain === "paint"
    && s.display === "flex" && s.overflowX === "clip" && s.overflowY === "clip" && zeroClipMargin(host, s)
    && none(s.filter) && none(s.backdropFilter) && s.borderImageSource === "none" && [undefined, "", "visible"].includes(s.contentVisibility) && root.getClientRects().length === 1) {
    if (++budget.n > 4096) { budget.exceeded = true; return null; }
    const r = rect(root), pad = outset(s);
    // Containment clips descendants, not the root's own ink. Do not infer a world-space
    // outset from local CSS lengths under a potentially transformed content ancestor.
    if (!r || pad !== 0) return null;
    return r;
  }
  const nodes = [root, ...root.querySelectorAll("*")]; budget.n += nodes.length;
  if (budget.n > 4096) { budget.exceeded = true; return null; }
  let union = null;
  for (const el of nodes) {
    if (!visible(host, el)) continue;
    const style = host.getComputedStyle(el), pad = outset(style);
    if (style.borderImageSource !== undefined && style.borderImageSource !== "none" || ![undefined, "", "visible"].includes(style.contentVisibility)) return null;
    const r = none(style.filter) ? rect(el) : stockBannerFill(host, el);
    if (!r || pad === null || !none(style.backdropFilter)) return null;
    const a = { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
    if (!union) union = a;
    else { const x = Math.min(union.x, a.x), y = Math.min(union.y, a.y); union = { x, y, width: Math.max(union.x + union.width, a.x + a.width) - x, height: Math.max(union.y + union.height, a.y + a.height) - y }; }
  }
  return union || { x: 0, y: 0, width: 0, height: 0 };
}
/** Snapshot immediately before reveal; callers must hide first on mutations/scroll/resize. No observer is installed here. */
export function stockEffectTrust(host, { frameRoot = null, ownerCss = "unknown" } = {}) {
  const fail = reason => ({ ok: false, reason, rects: [], front: false });
  try {
    const doc = host.document, app = doc.getElementById("app"), shell = doc.querySelector("#app > .shell"), chat = doc.querySelector(".main > .p-chat");
    if (!app || app.parentElement !== doc.body || !shell || doc.querySelectorAll("#app > .shell").length !== 1 || doc.querySelectorAll(".main > .panel").length !== 1) return fail("stock_route_unknown");
    const surface = panelSurface(doc, chat);
    if (!surface) return fail("stock_route_unknown");
    if (frameRoot && (frameRoot.ownerDocument !== doc || frameRoot.parentElement !== doc.body || !frameRoot.classList.contains("agend-effect-layer") || !neutral(host.getComputedStyle(frameRoot)) || !["static", "relative"].includes(host.getComputedStyle(frameRoot).position) || host.getComputedStyle(frameRoot).zIndex !== "auto")) return fail("stock_frame_root_unknown");
    for (const selector of surface.structural) {
      const el = doc.querySelector(selector), s = el && host.getComputedStyle(el);
      if (!el || el.isConnected !== true || !neutral(s) || s.zIndex !== "auto" || !["static", "relative"].includes(s.position)) return fail("stock_order_unknown");
    }
    for (const selector of surface.content) for (const el of doc.querySelectorAll(selector)) {
      if (!visible(host, el)) { const children = [...el.querySelectorAll("*")]; if (children.length > 4096 || children.some(child => visible(host, child))) return fail("stock_order_unknown"); continue; }
      const s = host.getComputedStyle(el);
      if (s.position !== (selector === ".p-settings > .s-pending" ? "sticky" : "relative") || s.zIndex !== (selector.endsWith(" > .panel-head") ? "2" : "1") || !neutral(s, stockWidgetMask(host, selector, s))) return fail("stock_order_unknown");
    }
    // The resize separator has no bounded content parent; prove its own level and neutral sidebar/usage ancestors.
    for (const el of doc.querySelectorAll(".shell > .sidebar, .shell > .u-rail")) {
      if (!visible(host, el)) { const children = [...el.querySelectorAll("*")]; if (children.length > 4096 || children.some(child => visible(host, child))) return fail("stock_order_unknown"); continue; }
      const s = host.getComputedStyle(el);
      if (!neutral(s) || s.zIndex !== "auto" || !["static", "relative"].includes(s.position)) return fail("stock_order_unknown");
    }
    for (const el of doc.querySelectorAll(".shell .side-resize")) if (visible(host, el)) {
      const s = host.getComputedStyle(el);
      if (!neutral(s) || s.position !== "absolute" || s.zIndex !== "5") return fail("stock_order_unknown");
    }
    // Desktop split preview is a stock level1 content owner too. Narrow preview is a modal sheet, handled below.
    if (host.innerWidth >= 900) for (const el of doc.querySelectorAll(".chat-split > .pv-panel, .chat-split > .pv-divider")) {
      if (!visible(host, el)) { const children = [...el.querySelectorAll("*")]; if (children.length > 4096 || children.some(child => visible(host, child))) return fail("stock_order_unknown"); continue; }
      const s = host.getComputedStyle(el);
      if (s.position !== "relative" || s.zIndex !== "1" || !neutral(s)) return fail("stock_order_unknown");
    }
    const marked = [...doc.querySelectorAll("[data-trust]")], expected = new Set(), rects = [], budget = { n: 0 };
    if (marked.length > 4096) return fail("stock_marker_limit");
    for (const { kind, selector } of STOCK_TRUST_INVENTORY) for (const el of doc.querySelectorAll(selector)) {
      if (el.ownerDocument !== doc || el.isConnected !== true || el.getAttribute("data-trust") !== kind) return fail("stock_trust_unknown");
      expected.add(el);
    }
    if (marked.some(el => !expected.has(el)) || surface.kind === "chat" && !chat.querySelector('.dock[data-trust="composer"]') || !surface.panel.querySelector('.panel-head[data-trust="header"]')) return fail("stock_trust_unknown");
    for (const el of marked) {
      const bounds = protectedPaint(host, el, budget); if (!bounds) return fail(budget.exceeded ? "stock_paint_limit" : "stock_paint_unknown");
      // Off-screen history remains inventoried and paint-checked; it need not consume a
      // viewport hole. Include the clip algorithm's extra 8px protection margin.
      if (bounds.width && bounds.height && (!finite(host.innerHeight) || bounds.x + bounds.width + 8 >= 0 && bounds.y + bounds.height + 8 >= 0 && bounds.x - 8 <= host.innerWidth && bounds.y - 8 <= host.innerHeight)) rects.push(bounds);
    }
    // Keep the existing 128-hole transport bound. Conservative union may hide extra
    // effect pixels; it can never reveal protected pixels, even for a dense viewport.
    if (rects.length > 128) {
      const rest = rects.splice(127), x = Math.min(...rest.map(r => r.x)), y = Math.min(...rest.map(r => r.y));
      rects.push({ x, y, width: Math.max(...rest.map(r => r.x + r.width)) - x, height: Math.max(...rest.map(r => r.y + r.height)) - y });
    }
    if (doc.querySelector(".agend-session-ended")) return fail("session_ended");
    let barrier = [...doc.querySelectorAll(BARRIERS)].some(el => visible(host, el));
    if (host.innerWidth < 900 && [...doc.querySelectorAll(".pv-panel")].some(el => visible(host, el))) barrier = true;
    if (doc.fullscreenElement || doc.pictureInPictureElement) barrier = true;
    // Focus alone does not change protected paint bounds. Composer/controls stay clipped; editable focus
    // separately suppresses pointer delivery in the registry, and keyboard events never enter a Worker.
    return { ok: true, rects, front: !barrier, reason: barrier ? "stock_overlay" : "stock", agentFront: !barrier && ownerCss === "off", agentReason: barrier ? "stock_overlay" : ownerCss === "off" ? "stock" : "owner_css", settingsHref: "/settings/look" };
  } catch { return fail("stock_trust_unknown"); }
}
