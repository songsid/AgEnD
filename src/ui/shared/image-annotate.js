// #3727 (M-2973): mark up a chat image and quote it to the agent. The image viewer's 「標註」 opens this editor in the
// viewer's own dialog: the picture on a canvas, and on top of it pen strokes, boxes, arrows and text in a few colours,
// with undo, redo and clear. 「引用給 Agent」 hands back the marked-up picture as a NEW PNG file (the original file is
// only read, never changed); the chat puts it in a composer as an attachment with a reply to the original message.
//
// Browser-only: the picture is the chat's own same-origin file (/ui/file/<hex>), drawn and encoded here — no server
// call, no other origin. No style attribute (#1300): classes only; the stylesheet is linked by this module (an older
// app.css lacks it). Pointer events, so a mouse, a pen and a finger draw the same way.
//
// M-3267 (the user, 11-17: 「引用給 agent 沒有辦法縮放圖再開始畫」): zoom and pan before (and between) marks. A desk: the
// wheel (a trackpad pinch arrives as ctrl+wheel) zooms at the cursor; − / the level / + / Fit; Space held, the middle
// button or the hand mode drags the picture. A phone: two fingers pinch and pan (a stroke the first finger began is
// dropped, never kept), one finger draws — or pans in the hand mode. The picture is placed by a CSSOM transform (the
// viewer's own math, image-zoom.js); every mark is kept in the picture's own pixels, so the quoted PNG is the same at any
// zoom, and a stroke is at least 3 screen px wide at the zoom it was drawn.
import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { clampPan, fitView, pinchView, stageToImage, zoomAt, STEP } from "./image-zoom.js";
import { register, t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";

export const annotateV1 = true;
register("annotate", {
  en: {
    title: "Annotate: {0}", titleNoName: "Annotate image", tools: "Tools", colours: "Colour",
    pen: "Pen (P)", box: "Box (B)", arrow: "Arrow (A)", text: "Text (T)", undo: "Undo (Ctrl+Z)", redo: "Redo (Ctrl+Shift+Z)", clear: "Clear",
    red: "Red", yellow: "Yellow", blue: "Blue", white: "White",
    textField: "Text", textShort: "Type, then Enter", textHint: "Click the picture where the text goes, type it here, then press Enter.", textAdd: "Add",
    close: "Close without sending", loading: "Loading the picture…",
    failedLoad: "The picture could not be loaded for annotating.", failedSave: "The annotated picture could not be made.",
    canvas: "Picture to annotate. Choose a tool, then draw on it.",
    zoom: "Zoom", zoomIn: "Zoom in (+)", zoomOut: "Zoom out (−)", zoomFit: "Fit the picture (0)", zoomLevel: "Zoom level: {0}% — fit the picture",
    hand: "Move the picture (H, or hold Space). Two fingers zoom and move it too.",
  },
  "zh-TW": {
    title: "標註：{0}", titleNoName: "標註圖片", tools: "工具", colours: "顏色",
    pen: "畫筆（P）", box: "方框（B）", arrow: "箭頭（A）", text: "文字（T）", undo: "復原（Ctrl+Z）", redo: "重做（Ctrl+Shift+Z）", clear: "清除",
    red: "紅", yellow: "黃", blue: "藍", white: "白",
    textField: "文字", textShort: "輸入後按 Enter", textHint: "先點圖片上要放文字的地方，在這裡輸入，再按 Enter。", textAdd: "加入",
    close: "關閉，不送出", loading: "正在載入圖片…",
    failedLoad: "無法載入這張圖片來標註。", failedSave: "無法產生標註後的圖片。",
    canvas: "要標註的圖片。選一個工具，然後在上面畫。",
    zoom: "縮放", zoomIn: "放大（+）", zoomOut: "縮小（−）", zoomFit: "整張圖（0）", zoomLevel: "縮放比例：{0}%，按一下看整張圖",
    hand: "移動圖片（H，或按住空白鍵）。兩指也能縮放和移動。",
  },
});

export const COLOURS = [["red", "#e5484d"], ["yellow", "#ffc53d"], ["blue", "#3e8eff"], ["white", "#ffffff"]];
export const TOOLS = ["pen", "box", "arrow", "text"];
const KEYS = { p: "pen", b: "box", a: "arrow", t: "text" };
/** The longest side a marked-up picture is drawn at (a larger original is scaled down; a smaller one is kept). */
export const MAX_SIDE = 2560;

/** Canvas size for a picture of w × h: its own size, scaled down to MAX_SIDE on its longest side. */
export function canvasSize(w, h) {
  const k = Math.min(1, MAX_SIDE / Math.max(1, w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
/** Stroke width for a canvas of w × h: readable on a phone screenshot and on a wide one. */
export const strokeWidth = (w, h) => Math.max(3, Math.round(Math.max(w, h) / 320));

/**
 * The marks as a history: `shapes` in drawing order (a "clear" is one too, so it can be undone) and `redo`, what undo
 * took back. Pure, so the order of undo / redo / clear is tested without a canvas.
 */
export function history() {
  let shapes = [], redo = [];
  return {
    get shapes() { return shapes; },
    /** What is drawn: everything after the last clear. */
    visible() { const at = shapes.map(s => s.tool).lastIndexOf("clear"); return shapes.slice(at + 1); },
    add(shape) { shapes = [...shapes, shape]; redo = []; },
    clear() { if (this.visible().length) this.add({ tool: "clear" }); },
    undo() { if (!shapes.length) return false; redo = [...redo, shapes[shapes.length - 1]]; shapes = shapes.slice(0, -1); return true; },
    redo() { if (!redo.length) return false; shapes = [...shapes, redo[redo.length - 1]]; redo = redo.slice(0, -1); return true; },
    get canUndo() { return shapes.length > 0; },
    get canRedo() { return redo.length > 0; },
  };
}

/** Draw one mark. `lw`: the stroke width for this canvas. */
export function drawShape(ctx, s, base) {
  const lw = s.lw ?? base;                          // a mark keeps the width it was drawn with
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = lw; ctx.strokeStyle = s.colour; ctx.fillStyle = s.colour;
  if (s.tool === "pen" && s.points.length) {
    ctx.beginPath(); ctx.moveTo(s.points[0][0], s.points[0][1]);
    for (const [x, y] of s.points.slice(1)) ctx.lineTo(x, y);
    if (s.points.length === 1) ctx.lineTo(s.points[0][0] + 0.01, s.points[0][1]);   // a dot
    ctx.stroke();
  } else if (s.tool === "box") {
    ctx.strokeRect(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0));
  } else if (s.tool === "arrow") {
    const angle = Math.atan2(s.y1 - s.y0, s.x1 - s.x0), head = lw * 4;
    ctx.beginPath(); ctx.moveTo(s.x0, s.y0); ctx.lineTo(s.x1, s.y1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x1 - head * Math.cos(angle - Math.PI / 6), s.y1 - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(s.x1 - head * Math.cos(angle + Math.PI / 6), s.y1 - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath(); ctx.fill();
  } else if (s.tool === "text" && s.text) {
    ctx.font = `bold ${s.size ?? lw * 6}px system-ui, sans-serif`; ctx.textBaseline = "top";
    // A dark outline, so a light colour reads on a light picture and the reverse.
    ctx.lineWidth = Math.max(2, lw * 0.8); ctx.strokeStyle = s.colour === "#ffffff" ? "#000000" : "rgba(0,0,0,0.65)";
    ctx.strokeText(s.text, s.x, s.y); ctx.fillText(s.text, s.x, s.y);
  }
  ctx.restore();
}

/** The marked-up picture's file name: the original's, before its extension, plus "-annotated.png". */
export function annotatedName(name) {
  const base = String(name || "image").replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 80) || "image";
  return `${base}-annotated.png`;
}

/**
 * Prism on #3735: the editor's colours are tokens (tokens.css). A tab whose cached tokens.css predates them would draw
 * transparent swatches and lose the selected tool, so the editor's root sets any of them that resolve to nothing —
 * CSSOM on its own element (#1300), the same values as tokens.css; a current tokens.css wins (nothing is set).
 */
export const MEDIA_TOKENS = [["--media-ink", "#ffffff"], ["--media-bar", "rgba(0, 0, 0, 0.75)"], ["--media-panel", "rgba(0, 0, 0, 0.6)"],
  ["--media-btn", "rgba(255, 255, 255, 0.12)"], ["--media-btn-on", "rgba(255, 255, 255, 0.32)"], ["--media-line", "rgba(255, 255, 255, 0.35)"],
  ...COLOURS.map(([k, v]) => [`--mark-${k}`, v])];
export function fillMissingTokens(el) {
  if (!el || typeof getComputedStyle !== "function") return;
  const computed = getComputedStyle(el);
  for (const [name, value] of MEDIA_TOKENS) if (!computed.getPropertyValue(name).trim()) el.style.setProperty(name, value);
}

/** The stylesheet, once per document. */
export function linkAnnotateCss(doc = typeof document !== "undefined" ? document : null) {
  if (!doc || !doc.head || doc.querySelector('link[data-annotate-css="1"]')) return;
  const link = doc.createElement("link");
  link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/image-annotate.css"); link.setAttribute("data-annotate-css", "1");
  doc.head.appendChild(link);
}

/**
 * M-3168: the stylesheet, linked once, and a promise that settles when it has arrived — loaded, failed, or after `wait` ms
 * (a slow or missing stylesheet never keeps the editor shut). The viewer shows the editor only then, so its first open
 * paints in its final layout; before, the first 「標註」 drew the bare editor (the picture at the far left) until the
 * stylesheet arrived. Nothing is fetched before the first 「標註」: a page that never annotates loads none of it.
 */
export function annotateCssReady(doc = typeof document !== "undefined" ? document : null, wait = 4000) {
  if (!doc || !doc.head) return Promise.resolve();
  linkAnnotateCss(doc);
  const link = doc.querySelector('link[data-annotate-css="1"]');
  // Already loaded (a second open, or another chat's), or already failed once (Fable #3977: a failed link never fires
  // again, so later opens would each wait the full `wait`).
  if (!link || link.sheet || link.getAttribute("data-annotate-css-failed") === "1") return Promise.resolve();
  return new Promise((done) => {
    let timer = null;
    const settle = (e) => { if (timer === null) return; clearTimeout(timer); timer = null;
      if (e?.type === "error") link.setAttribute("data-annotate-css-failed", "1");
      link.removeEventListener("load", settle); link.removeEventListener("error", settle); done(); };
    timer = setTimeout(settle, wait);
    link.addEventListener("load", settle); link.addEventListener("error", settle);
  });
}

/**
 * The editor, inside the viewer's dialog. `src`, `name`: the picture. `targets`: [{ key, label, quote(file) }] — the first
 * is this chat's composer, a second the other pane's; quote() answers true when the file went in. `onClose`: ✕ / Esc
 * (the dialog's own cancel), and after a quote.
 */
/** M-3267: the margin (CSS px) around the picture in the editor's stage. */
export const STAGE_MARGIN = 12;

export function AnnotateEditor({ src, name, targets = [], onClose, onError }) {
  const canvas = useRef(null), base = useRef(null), hist = useRef(history()), drag = useRef(null), textField = useRef(null);
  // M-3267: the stage, the view ({ s, tx, ty }: the picture's scale and top-left on the stage), whether it is fitted
  // (a resize keeps it fitted), the pointers down (stage points), the pan or pinch in progress, Space held.
  const stage = useRef(null), view = useRef(null), fitted = useRef(true), pointers = useRef(new Map()), gesture = useRef(null), spaceHeld = useRef(false), overStage = useRef(false);
  const [hand, setHand] = useState(false);
  const [pct, setPct] = useState(null);
  const [size, setSize] = useState(null);           // { w, h, lw } once the picture has loaded
  const [failed, setFailed] = useState(false);
  const [tool, setTool] = useState("pen");
  const [colour, setColour] = useState(COLOURS[0][1]);
  const [textAt, setTextAt] = useState(null);       // where a text mark goes: [x, y] on the canvas
  const [text, setText] = useState("");
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const refresh = () => setTick(n => n + 1);
  // Prism on #3735: an export (toBlob is asynchronous) belongs to the live editor. Closing it, or the editor going
  // away, retires one in flight: its file is never handed to a composer afterwards.
  const live = useRef({ alive: true, op: 0 });
  const close = () => { live.current.op++; onClose?.(); };
  useEffect(() => () => { live.current.alive = false; live.current.op++; }, []);
  useEffect(() => { linkAnnotateCss(); }, []);
  useEffect(() => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      const { w, h } = canvasSize(img.naturalWidth, img.naturalHeight);
      base.current = img; setSize({ w, h, lw: strokeWidth(w, h) });
    };
    img.onerror = () => setFailed(true);
    img.src = src;                                   // the chat's own file: same origin, so the canvas can be read back
    return () => { img.onload = null; img.onerror = null; };
  }, [src]);
  const paint = (extra, forExport = false) => {
    const c = canvas.current, s = size;
    if (!c || !s || !base.current) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, s.w, s.h);
    ctx.drawImage(base.current, 0, 0, s.w, s.h);
    for (const shape of hist.current.visible()) drawShape(ctx, shape, s.lw);
    if (extra) drawShape(ctx, extra, s.lw);
    if (textAt && !forExport) {                      // where the text will go: a small cross (never in the file)
      ctx.save(); ctx.strokeStyle = colour; ctx.lineWidth = Math.max(2, s.lw / 2);
      ctx.beginPath(); ctx.moveTo(textAt[0] - s.lw * 2, textAt[1]); ctx.lineTo(textAt[0] + s.lw * 2, textAt[1]);
      ctx.moveTo(textAt[0], textAt[1] - s.lw * 2); ctx.lineTo(textAt[0], textAt[1] + s.lw * 2); ctx.stroke(); ctx.restore();
    }
  };
  useEffect(() => { paint(); });
  /** Canvas pixels per screen pixel now (a phone shows a big picture small): a mark is at least 3 screen px wide, and
   *  text at least 20 screen px tall, whatever the picture's own size. */
  const perScreenPx = () => (view.current && view.current.s > 0 ? 1 / view.current.s : 1);
  const markWidth = () => Math.max(size.lw, Math.round(3 * perScreenPx()));
  const textSize = () => Math.max(size.lw * 6, Math.round(20 * perScreenPx()));
  /** M-3267: a pointer's stage point, and the picture pixel under it (the view's own mapping, at any zoom and pan). */
  const stagePoint = (e) => { const r = stage.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const point = (e) => { const [x, y] = stagePoint(e); return stageToImage(view.current, x, y); };
  const box = () => { const el = stage.current, m = STAGE_MARGIN;
    return { x: m, y: m, w: Math.max(1, (el?.clientWidth || 0) - 2 * m), h: Math.max(1, (el?.clientHeight || 0) - 2 * m) }; };
  const pic = () => ({ w: size.w, h: size.h });
  const show = (z, fit = false) => {
    view.current = z; fitted.current = fit;
    const c = canvas.current;
    if (c) c.style.transform = `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;   // CSSOM, never a style attribute (#1300)
    setPct(Math.round(z.s * 100));
  };
  const fit = () => { if (size && stage.current) show(fitView(box(), pic()), true); };
  const zoomBy = (k) => { if (!view.current) return; const b = box(); show(zoomAt(view.current, view.current.s * k, b.x + b.w / 2, b.y + b.h / 2, b, pic())); };
  // Fitted as soon as the canvas is there (before a paint), and kept fitted — or kept in view — when the stage resizes.
  useLayoutEffect(() => { if (size) fit(); }, [size]);
  useEffect(() => {
    const el = stage.current;
    if (!size || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (!view.current) return; if (fitted.current) fit(); else show(clampPan(view.current, box(), pic())); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [size]);
  // The wheel zooms at the cursor; not passive, so the page behind never scrolls.
  useEffect(() => {
    const el = stage.current;
    if (!size || !el) return;
    const onWheel = (e) => {
      if (!view.current) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const [x, y] = stagePoint(e), b = box();
      show(zoomAt(view.current, view.current.s * Math.exp(-(e.deltaY || 0) * unit * 0.002), x, y, b, pic()));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel, { passive: false });
  }, [size]);
  const panning = (e) => hand || spaceHeld.current || e.button === 1;
  const onDown = (e) => {
    if (!size || !view.current) return;
    const at = stagePoint(e);
    pointers.current.set(e.pointerId, at);
    stage.current.setPointerCapture?.(e.pointerId);
    if (pointers.current.size === 2 && e.pointerType === "touch") {
      // A second finger: a pinch. The stroke the first finger began is dropped (never kept as a mark).
      const [p0, p1] = [...pointers.current.values()];
      drag.current = null; paint();
      gesture.current = { kind: "pinch", start: view.current, p0, p1 };
      e.preventDefault();
      return;
    }
    if (pointers.current.size > 1 || gesture.current) return;
    const button = e.button ?? 0;
    if (button !== 0 && button !== 1) return;
    e.preventDefault();
    if (panning(e)) { gesture.current = { kind: "pan", start: view.current, at }; stage.current.classList.add("an-grabbing"); return; }
    if (button !== 0) return;
    const [x, y] = point(e);
    if (x < 0 || y < 0 || x > size.w || y > size.h) return;          // outside the picture: nothing to mark
    if (tool === "text") { setTextAt([x, y]); textField.current?.focus(); return; }
    const lw = markWidth();
    drag.current = tool === "pen" ? { tool, colour, lw, points: [[x, y]] } : { tool, colour, lw, x0: x, y0: y, x1: x, y1: y };
    paint(drag.current);
  };
  const onMove = (e) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, stagePoint(e));
    const g = gesture.current;
    if (g && g.kind === "pinch") {
      const [q0, q1] = [...pointers.current.values()];
      if (q0 && q1) show(pinchView(g.start, g.p0, g.p1, q0, q1, box(), pic()));
      e.preventDefault();
      return;
    }
    if (g && g.kind === "pan") {
      const [x, y] = stagePoint(e);
      show(clampPan({ s: g.start.s, tx: g.start.tx + x - g.at[0], ty: g.start.ty + y - g.at[1] }, box(), pic()));
      e.preventDefault();
      return;
    }
    if (g) return;                                                     // a pinch's last finger: nothing until it lifts
    const d = drag.current;
    if (!d) return;
    e.preventDefault();
    const [x, y] = point(e);
    if (d.tool === "pen") d.points.push([x, y]); else { d.x1 = x; d.y1 = y; }
    paint(d);
  };
  const onUp = (e) => {
    pointers.current.delete(e.pointerId);
    if (gesture.current) {
      // A pinch with one finger left waits for it to lift (it never starts a stroke); otherwise the gesture is over.
      gesture.current = pointers.current.size ? { kind: "rest" } : null;
      stage.current?.classList.remove("an-grabbing");
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const tiny = d.tool !== "pen" && Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 3;
    if (!tiny) hist.current.add(d);
    refresh();
  };
  const addText = () => {
    const value = text.trim();
    if (!value || !textAt) return;
    hist.current.add({ tool: "text", colour, lw: markWidth(), size: textSize(), x: textAt[0], y: textAt[1], text: value.slice(0, 200) });
    setText(""); setTextAt(null);
  };
  const undo = () => { if (hist.current.undo()) refresh(); };
  const redo = () => { if (hist.current.redo()) refresh(); };
  const clear = () => { hist.current.clear(); setTextAt(null); refresh(); };
  const quote = async (target) => {
    const c = canvas.current;
    if (!c || busy) return;
    const op = ++live.current.op, current = () => live.current.alive && live.current.op === op;
    setBusy(true);
    try {
      paint(null, true);                             // without the text cross
      const blob = await new Promise((resolve) => c.toBlob(resolve, "image/png"));
      if (!current()) return;                        // closed or gone while encoding: nothing is added anywhere
      if (!blob) throw new Error("no image");
      const file = new File([blob], annotatedName(name), { type: "image/png" });
      // The editor's own liveness travels with the file: a target that waits (the other pane's Chat mounting) checks it
      // at its commit, so closing the editor meanwhile cancels the quote and the attachment there (Prism on #3735 r2).
      if (await target.quote(file, current) && current()) onClose?.();
    } catch { if (current()) onError?.(t("annotate.failedSave")); }
    finally { if (live.current.alive) setBusy(false); }
  };
  useEffect(() => {
    const onKey = (e) => {
      const typing = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && (e.key === "z" || e.key === "Z")) { if (typing && !e.shiftKey && text) return; e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && !e.altKey && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
      if (typing || mod || e.altKey) return;
      // M-3267: Space held pans; + − 0 zoom; H the hand mode.
      // Space is "hold to move" while the pointer is over the picture's stage (a focused tool button keeps its Space
      // press anywhere else).
      if (e.key === " " && (overStage.current || !(e.target && e.target.tagName === "BUTTON"))) { e.preventDefault(); if (!spaceHeld.current) { spaceHeld.current = true; stage.current?.classList.add("an-space"); } return; }
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(STEP); return; }
      if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1 / STEP); return; }
      if (e.key === "0") { e.preventDefault(); fit(); return; }
      if (e.key === "h" || e.key === "H") { e.preventDefault(); setHand((v) => !v); return; }
      const k = KEYS[e.key.toLowerCase()];
      if (k) { e.preventDefault(); setTool(k); if (k !== "text") setTextAt(null); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= COLOURS.length) { e.preventDefault(); setColour(COLOURS[n - 1][1]); }
    };
    const onKeyUp = (e) => { if (e.key === " " && spaceHeld.current) { spaceHeld.current = false; stage.current?.classList.remove("an-space"); } };
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKeyUp);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("keyup", onKeyUp); };
  });
  const label = name ? t("annotate.title", name) : t("annotate.titleNoName");
  return html`<div class="an" data-trust="annotate" role="group" aria-label=${label} ref=${fillMissingTokens}>
    <div class="an-bar">
      <span class="an-name" title=${name}>${label}</span>
      <span class="an-tools" role="radiogroup" aria-label=${t("annotate.tools")}>
        ${TOOLS.map((k) => html`<button type="button" role="radio" aria-checked=${tool === k ? "true" : "false"} class=${`btn btn-sm an-tool an-tool-${k}${tool === k ? " on" : ""}`}
          title=${t(`annotate.${k}`)} aria-label=${t(`annotate.${k}`)} onClick=${() => { setTool(k); if (k !== "text") setTextAt(null); }}><span class="an-glyph" aria-hidden="true">${{ pen: "✎", box: "▭", arrow: "↗", text: "T" }[k]}</span></button>`)}
      </span>
      <span class="an-colours" role="radiogroup" aria-label=${t("annotate.colours")}>
        ${COLOURS.map(([k, v], i) => html`<button type="button" role="radio" aria-checked=${colour === v ? "true" : "false"} class=${`an-colour${colour === v ? " on" : ""}`}
          title=${`${t(`annotate.${k}`)} (${i + 1})`} aria-label=${t(`annotate.${k}`)} onClick=${() => setColour(v)}><span class=${`an-dot an-colour-${k}`} aria-hidden="true"></span></button>`)}
      </span>
      <span class="an-zoom" role="group" aria-label=${t("annotate.zoom")}>
        <button type="button" class="btn btn-sm an-zoom-out" disabled=${!size} title=${t("annotate.zoomOut")} aria-label=${t("annotate.zoomOut")} onClick=${() => zoomBy(1 / STEP)}><${Icon} name="minus" size=${16} /></button>
        <button type="button" class="btn btn-sm an-zoom-fit" disabled=${!size} title=${t("annotate.zoomFit")} aria-label=${t("annotate.zoomLevel", pct ?? 100)} onClick=${fit}>${pct === null ? "…" : `${pct}%`}</button>
        <button type="button" class="btn btn-sm an-zoom-in" disabled=${!size} title=${t("annotate.zoomIn")} aria-label=${t("annotate.zoomIn")} onClick=${() => zoomBy(STEP)}><${Icon} name="plus" size=${16} /></button>
        <button type="button" class=${`btn btn-sm an-hand${hand ? " on" : ""}`} aria-pressed=${hand ? "true" : "false"} title=${t("annotate.hand")} aria-label=${t("annotate.hand")}
          onClick=${() => setHand((v) => !v)}><span class="an-glyph" aria-hidden="true">✋</span></button>
      </span>
      <span class="an-history">
        <button type="button" class="btn btn-sm an-undo" disabled=${!hist.current.canUndo} title=${t("annotate.undo")} aria-label=${t("annotate.undo")} onClick=${undo}>↶</button>
        <button type="button" class="btn btn-sm an-redo" disabled=${!hist.current.canRedo} title=${t("annotate.redo")} aria-label=${t("annotate.redo")} onClick=${redo}>↷</button>
        <button type="button" class="btn btn-sm an-clear" disabled=${!hist.current.visible().length} onClick=${clear}>${t("annotate.clear")}</button>
      </span>
      <button type="button" class="icon-btn an-close" title=${t("annotate.close")} aria-label=${t("annotate.close")} onClick=${close}><${Icon} name="close" /></button>
    </div>
    ${tool === "text" ? html`<form class="an-text" onSubmit=${(e) => { e.preventDefault(); addText(); }}>
      <label class="an-text-label"><span>${t("annotate.textField")}</span>
        <input ref=${textField} type="text" maxlength="200" value=${text} placeholder=${t("annotate.textShort")} title=${t("annotate.textHint")} onInput=${(e) => setText(e.target.value)} /></label>
      <button type="submit" class="btn btn-sm" disabled=${!text.trim() || !textAt}>${t("annotate.textAdd")}</button>
    </form>` : null}
    <div ref=${stage} class=${`an-stage${hand ? " an-panning" : ""}${size ? " an-zoomable" : ""}`} onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp}
      onPointerEnter=${() => { overStage.current = true; }} onPointerLeave=${() => { overStage.current = false; }}>
      ${failed ? html`<p class="an-note" role="alert">${t("annotate.failedLoad")}</p>`
        : size ? html`<canvas ref=${canvas} class=${`an-canvas an-cursor-${tool}`} width=${size.w} height=${size.h} role="img" aria-label=${t("annotate.canvas")} />`
        : html`<p class="an-note" role="status">${t("annotate.loading")}</p>`}
    </div>
    <div class="an-actions">
      ${targets.map((target, i) => html`<button type="button" class=${`btn ${i === 0 ? "btn-primary" : ""} an-quote`} disabled=${!size || busy}
        data-target=${target.key} onClick=${() => quote(target)}>${target.label}</button>`)}
    </div>
  </div>`;
}
