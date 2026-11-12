// #3727 (M-2973): mark up a chat image and quote it to the agent. The image viewer's 「標註」 opens this editor in the
// viewer's own dialog: the picture on a canvas, and on top of it pen strokes, boxes, arrows and text in a few colours,
// with undo, redo and clear. 「引用給 Agent」 hands back the marked-up picture as a NEW PNG file (the original file is
// only read, never changed); the chat puts it in a composer as an attachment with a reply to the original message.
//
// Browser-only: the picture is the chat's own same-origin file (/ui/file/<hex>), drawn and encoded here — no server
// call, no other origin. No style attribute (#1300): classes only; the stylesheet is linked by this module (an older
// app.css lacks it). Pointer events, so a mouse, a pen and a finger draw the same way.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
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
  },
  "zh-TW": {
    title: "標註：{0}", titleNoName: "標註圖片", tools: "工具", colours: "顏色",
    pen: "畫筆（P）", box: "方框（B）", arrow: "箭頭（A）", text: "文字（T）", undo: "復原（Ctrl+Z）", redo: "重做（Ctrl+Shift+Z）", clear: "清除",
    red: "紅", yellow: "黃", blue: "藍", white: "白",
    textField: "文字", textShort: "輸入後按 Enter", textHint: "先點圖片上要放文字的地方，在這裡輸入，再按 Enter。", textAdd: "加入",
    close: "關閉，不送出", loading: "正在載入圖片…",
    failedLoad: "無法載入這張圖片來標註。", failedSave: "無法產生標註後的圖片。",
    canvas: "要標註的圖片。選一個工具，然後在上面畫。",
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
 * The editor, inside the viewer's dialog. `src`, `name`: the picture. `targets`: [{ key, label, quote(file) }] — the first
 * is this chat's composer, a second the other pane's; quote() answers true when the file went in. `onClose`: ✕ / Esc
 * (the dialog's own cancel), and after a quote.
 */
export function AnnotateEditor({ src, name, targets = [], onClose, onError }) {
  const canvas = useRef(null), base = useRef(null), hist = useRef(history()), drag = useRef(null), textField = useRef(null);
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
  const perScreenPx = () => { const c = canvas.current, r = c?.getBoundingClientRect(); return c && r && r.width > 0 ? c.width / r.width : 1; };
  const markWidth = () => Math.max(size.lw, Math.round(3 * perScreenPx()));
  const textSize = () => Math.max(size.lw * 6, Math.round(20 * perScreenPx()));
  const point = (e) => {
    const c = canvas.current, r = c.getBoundingClientRect();
    return [((e.clientX - r.left) / Math.max(1, r.width)) * c.width, ((e.clientY - r.top) / Math.max(1, r.height)) * c.height];
  };
  const onDown = (e) => {
    if (!size || (e.button ?? 0) !== 0) return;
    e.preventDefault();
    const [x, y] = point(e);
    if (tool === "text") { setTextAt([x, y]); textField.current?.focus(); return; }
    canvas.current.setPointerCapture?.(e.pointerId);
    const lw = markWidth();
    drag.current = tool === "pen" ? { tool, colour, lw, points: [[x, y]] } : { tool, colour, lw, x0: x, y0: y, x1: x, y1: y };
    paint(drag.current);
  };
  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    e.preventDefault();
    const [x, y] = point(e);
    if (d.tool === "pen") d.points.push([x, y]); else { d.x1 = x; d.y1 = y; }
    paint(d);
  };
  const onUp = () => {
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
      if (await target.quote(file) && current()) onClose?.();
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
      const k = KEYS[e.key.toLowerCase()];
      if (k) { e.preventDefault(); setTool(k); if (k !== "text") setTextAt(null); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= COLOURS.length) { e.preventDefault(); setColour(COLOURS[n - 1][1]); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
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
    <div class="an-stage">
      ${failed ? html`<p class="an-note" role="alert">${t("annotate.failedLoad")}</p>`
        : size ? html`<canvas ref=${canvas} class=${`an-canvas an-cursor-${tool}`} width=${size.w} height=${size.h} role="img" aria-label=${t("annotate.canvas")}
            onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp} />`
        : html`<p class="an-note" role="status">${t("annotate.loading")}</p>`}
    </div>
    <div class="an-actions">
      ${targets.map((target, i) => html`<button type="button" class=${`btn ${i === 0 ? "btn-primary" : ""} an-quote`} disabled=${!size || busy}
        data-target=${target.key} onClick=${() => quote(target)}>${target.label}</button>`)}
    </div>
  </div>`;
}
