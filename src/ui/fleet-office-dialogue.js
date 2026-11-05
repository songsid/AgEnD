// #2861 (design: hxhsandy): the Office's dialogue box — a visual-novel box at the foot of the stage when a person talks
// to an agent shown there. docs/design/office-dialogue-2861.md.
//
// - Heard: a person's message (the stream's `message`, role "user") → the box slides up: their portrait on the left,
//   their name, their words (the first TEXT_MAX characters, typed out).
// - Working: while the agent works, its portrait on the right and a status line (its own office_set line, else
//   "Working…").
// - Answered: its reply (role "agent") replaces the line (TEXT_MAX), the speaker is the agent; the box fades HOLD_MS
//   later. Concurrent conversations queue, newest first; the box shows the first one it may and "+N" for the rest.
// - On a share link (`share`: the host's `talk`, never any text): a faceless visitor, "Received a message", "Replied".
// - Only news: a message stamped within FRESH_MS of the server's clock (a replay on reconnect, a poll's catch-up, is not).
// - Drawn on the Office's canvas, in the stage's CSS px, after the scene (it never pans or zooms with it), so it needs no
//   CSS rule (a tab opened before an upgrade keeps its old app.css: the box is still right).
// - Reduced motion: no slide, no typing, no fade.
// Off unless the Office bar's Dialogue box is ticked (per browser): then nothing here runs at all.
import { own, PORTRAIT_STATES } from "./fleet-office-pack.js";

export const DLG = {
  TEXT_MAX: 120,
  /** A message older than this on the server's clock is not news (a replay, a catch-up). */
  FRESH_MS: 90_000,
  /** How long an answer stays before it fades. */
  HOLD_MS: 6000,
  FADE_MS: 500,
  SLIDE_MS: 220,
  /** A conversation with no answer goes after this. */
  WAIT_MS: 180_000,
  /** Typed out at this many characters a second. */
  CPS: 40,
  /** At most this many conversations are kept (the oldest go). */
  MAX: 24,
};

const GRAPHEMES = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const chars = (s) => (GRAPHEMES ? [...GRAPHEMES.segment(s)].map((x) => x.segment) : [...s]);

/**
 * What the box says of a message: one line of plain words — whitespace folded, a code block as "…", the markdown marks
 * at a line's start (#, >, *, -) and emphasis marks dropped — cut to `max` characters with "…".
 */
export function clip(text, max = DLG.TEXT_MAX) {
  let s = String(text ?? "").replace(/```[\s\S]*?(```|$)/g, " … ");
  s = s.split("\n").map((l) => l.replace(/^\s*(?:#{1,6}\s+|>\s?|[*+-]\s+|\d+\.\s+)/, "")).join(" ");
  s = s.replace(/(\*\*|__|~~|`)/g, "").replace(/\s+/g, " ").trim();
  const c = chars(s);
  return c.length > max ? `${c.slice(0, max - 1).join("").trimEnd()}…` : s;
}

/**
 * The conversations: `heard(instance, person, text, t)` a person's message (`person` { name, account } — null on a
 * share: no one named); `answered(instance, text, t)` the agent's reply (none heard: nothing); `sweep(t)` drops what is
 * over; `list()` newest first. `t` is the page's monotonic clock. Each change bumps `rev()`.
 */
export function createDialogue() {
  const convs = new Map();
  let seq = 0, rev = 0;
  return {
    heard(instance, person, text, t) {
      if (typeof instance !== "string" || !instance) return null;
      convs.delete(instance);
      const c = { id: ++seq, instance, person: person || null, text: text == null ? null : clip(text), reply: null, heardAt: t, answeredAt: null, shownAt: null, replyShownAt: null };
      convs.set(instance, c);
      while (convs.size > DLG.MAX) convs.delete(convs.keys().next().value);
      rev++;
      return c;
    },
    answered(instance, text, t) {
      const c = convs.get(instance);
      if (!c || c.answeredAt !== null) return null;
      c.reply = text == null ? null : clip(text);
      c.answeredAt = t;
      rev++;
      return c;
    },
    /**
     * Drop what is over; whether anything went. An answer shown: HOLD_MS (and its fade) from when the box first showed
     * it (stageOf's replyShownAt) — never from when it came, so one queued behind another is seen in full when its turn
     * comes; an answer never shown (its agent not drawn here, or waiting in the queue): WAIT_MS after it came. A
     * conversation never answered: WAIT_MS after it was heard.
     */
    sweep(t, still = false) {
      let gone = false;
      for (const [k, c] of convs) {
        const over = c.answeredAt === null ? t >= c.heardAt + DLG.WAIT_MS
          : c.replyShownAt !== null ? t >= c.replyShownAt + DLG.HOLD_MS + (still ? 0 : DLG.FADE_MS) : t >= c.answeredAt + DLG.WAIT_MS;
        if (over) { convs.delete(k); gone = true; }
      }
      if (gone) rev++;
      return gone;
    },
    list: () => [...convs.values()].sort((a, b) => b.heardAt - a.heardAt || b.id - a.id),
    size: () => convs.size,
    rev: () => rev,
    clear() { if (convs.size) { convs.clear(); rev++; } },
  };
}

/**
 * The conversation the box shows and how many more wait: the newest whose agent is shown here (`shown(name)`) and
 * awake (`asleep(name)` false: paused, stopped, or in bed at bedtime — it waits until they wake to work, or expires);
 * `more`: the others shown here.
 */
export function pickFront(list, shown, asleep) {
  const here = list.filter((c) => shown(c.instance));
  const front = here.find((c) => !asleep(c.instance)) || null;
  return { front, more: front ? here.length - 1 : 0 };
}

/**
 * A stream `message` as the box takes it: { kind: "heard", instance, person, text } (a person's: role "user") or
 * { kind: "answered", instance, text } (the agent's reply: role "agent"), when it is news — stamped within FRESH_MS of
 * the server's time `serverNow`; else null. A status line is never one.
 */
export function messageOf(m, serverNow) {
  if (!m || typeof m !== "object" || typeof m.instance !== "string" || !m.instance) return null;
  if (m.role !== "user" && m.role !== "agent") return null;
  const at = typeof m.ts === "string" ? Date.parse(m.ts) : NaN;
  if (!Number.isFinite(at) || Math.abs(serverNow - at) > DLG.FRESH_MS) return null;
  const files = Array.isArray(m.attachments) && m.attachments.length > 0;
  const said = m.click && typeof m.click.label === "string" ? m.click.label : typeof m.text === "string" ? m.text : "";
  const text = said.trim() ? said : files ? "" : null;
  if (text === null) return null;
  if (m.role === "agent") return { kind: "answered", instance: m.instance, text, files: files && !said.trim() };
  const name = typeof m.sender === "string" && m.sender.trim() ? m.sender.trim() : "";
  const account = typeof m.from === "string" && /^[^\s:]{1,64}:[^\s:]{1,128}$/.test(m.from) ? m.from : null;
  return { kind: "heard", instance: m.instance, person: { name, account }, text, files: files && !said.trim() };
}

/** A share's `talk` (the host's: { now, items: [{ instance, kind, at }] }), checked: the items that are news. */
export function talkOf(d) {
  if (!d || typeof d !== "object" || typeof d.now !== "number" || !Array.isArray(d.items)) return [];
  return d.items.filter((x) => x && typeof x === "object" && typeof x.instance === "string" && x.instance && (x.kind === "heard" || x.kind === "answered")
    && typeof x.at === "number" && Number.isFinite(x.at) && Math.abs(d.now - x.at) <= DLG.FRESH_MS).sort((a, b) => a.at - b.at);
}

/** The expression a portrait shows for a state: its own, else idle, else any it has. */
const expressionOf = (p, state) => (p ? own(p, state) || own(p, "idle") || PORTRAIT_STATES.map((k) => own(p, k)).find(Boolean) || null : null);
/** A state's expression: working, a call (needs, crashed, looks stuck), else idle. */
export const portraitState = (state) => (state === "working" ? "working" : state === "needs" || state === "crashed" || state === "stuck" ? "needs" : "idle");
/**
 * The pack's portrait file for an agent ({ agent: name, state }) or a person ({ account }), or null: an agent's
 * byInstance, else the pack's default; a person's byUser (the default is the agents').
 */
export function portraitSrc(pack, who) {
  const p = pack && pack.portraits;
  if (!p || !who) return null;
  if (who.agent) return expressionOf(own(p.byInstance, who.agent) || p.default || null, portraitState(who.state));
  if (who.account) return expressionOf(own(p.byUser, who.account), "idle");
  return null;
}

/**
 * Where everything goes on a stage `W`×`H` (CSS px): the box (centred, at most 960 wide, at the foot), the portraits'
 * height and their two feet (left: the person, right: the agent — standing behind the box, VN style), the text's
 * place and lines, the name plate.
 */
export function boxLayout(W, H) {
  const narrow = W < 560;
  const m = narrow ? 8 : 16, w = Math.max(160, Math.min(960, W - 2 * m)), h = Math.round(Math.min(narrow ? 120 : 132, Math.max(narrow ? 100 : 96, H * (narrow ? 0.24 : 0.2))));
  const x = Math.round((W - w) / 2), y = Math.round(H - m - h);
  const ph = Math.round(Math.max(h * 1.4, Math.min(narrow ? 220 : 340, H * 0.42))), foot = Math.round(y + h * 0.55);
  const pad = narrow ? 12 : 18, font = narrow ? 14 : 15, lineH = Math.round(font * 1.4), statusH = narrow ? 18 : 20;
  const nameH = 22;
  return { narrow, box: { x, y, w, h }, portrait: { h: Math.min(ph, foot - 8), foot, maxW: Math.round(w * (narrow ? 0.36 : 0.3)), left: Math.round(x + w * 0.14), right: Math.round(x + w * 0.86) },
    pad, font, lineH, nameH, statusH, face: narrow ? 52 : 64,
    text: { x: x + pad, y: y + pad + 4, w: w - 2 * pad, lines: Math.max(2, Math.floor((h - 2 * pad - 4 - statusH) / lineH)) } };
}
/**
 * The layout with its box as tall as its words need (`n` lines, and the agent's line when `status`), at least two
 * lines' worth, still standing on the stage's foot: the portraits' feet and the text move with its top.
 */
export function fitBox(L, n, status) {
  const want = Math.round(L.pad * 2 + 4 + Math.max(2, n) * L.lineH + (status ? L.statusH : 0));
  const h = Math.min(L.box.h, Math.max(want, L.narrow ? 64 : 72)), dy = L.box.h - h;
  if (dy <= 0) return L;
  return { ...L, box: { ...L.box, y: L.box.y + dy, h }, portrait: { ...L.portrait, foot: L.portrait.foot + dy, h: Math.min(L.portrait.h, L.portrait.foot + dy - 8) },
    text: { ...L.text, y: L.text.y + dy } };
}

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/;
/**
 * `text` in lines at most `maxW` wide (measured), at most `max` lines (the last cut with "…" when there is more):
 * words for Latin text, any character for CJK; a word wider than a line is broken by character.
 */
export function wrap(measure, text, maxW, max) {
  const tokens = [];
  for (const g of chars(String(text ?? ""))) {
    const last = tokens[tokens.length - 1];
    if (/\s/.test(g)) { tokens.push(" "); continue; }
    if (CJK.test(g) || !last || last === " " || CJK.test(last[last.length - 1] || "")) tokens.push(g);
    else tokens[tokens.length - 1] = last + g;
  }
  const lines = [];
  let cur = "";
  const push = () => { lines.push(cur.trimEnd()); cur = ""; };
  for (const tk of tokens) {
    if (tk === " ") { if (cur) cur += " "; continue; }
    if (measure(cur + tk) <= maxW) { cur += tk; continue; }
    if (cur.trim()) push();
    if (measure(tk) <= maxW) { cur = tk; continue; }
    for (const g of chars(tk)) { if (cur && measure(cur + g) > maxW) push(); cur += g; }
  }
  if (cur.trim()) push();
  if (lines.length <= max) return lines;
  const out = lines.slice(0, max);
  let lastLine = out[max - 1];
  while (lastLine && measure(`${lastLine}…`) > maxW) lastLine = chars(lastLine).slice(0, -1).join("");
  out[max - 1] = `${lastLine.trimEnd()}…`;
  return out;
}

/** The first `n` characters of `lines`, line by line (what the typing has reached). */
export function typed(lines, n) {
  const out = [];
  let left = n;
  for (const l of lines) {
    if (left <= 0) break;
    const c = chars(l);
    out.push(c.slice(0, left).join(""));
    left -= c.length;
  }
  return out;
}
const lengthOf = (lines) => lines.reduce((a, l) => a + chars(l).length, 0);

/**
 * What the box is now, from its conversation `c` at `t`: { phase: "heard" | "working" | "answered", speaker
 * ("left": the person, "right": the agent), slide (0–1: how far it has risen), alpha, typedAt (when the speaker's line
 * began typing), done (gone) }. `working`: the agent works now. Reduced motion (`still`): risen, whole, no fade.
 */
export function stageOf(c, t, working, still) {
  if (c.shownAt === null) c.shownAt = t;
  if (c.answeredAt !== null && c.replyShownAt === null) c.replyShownAt = t;
  const phase = c.answeredAt !== null ? "answered" : working ? "working" : "heard";
  const slide = still ? 1 : Math.min(1, (t - c.shownAt) / DLG.SLIDE_MS);
  const fadeFrom = c.answeredAt !== null ? Math.max(c.answeredAt, c.replyShownAt) + DLG.HOLD_MS : Infinity;
  const alpha = t < fadeFrom ? 1 : still ? 0 : Math.max(0, 1 - (t - fadeFrom) / DLG.FADE_MS);
  return { phase, speaker: phase === "answered" ? "right" : "left", slide: 1 - (1 - slide) ** 3, alpha, typedAt: phase === "answered" ? c.replyShownAt : c.shownAt, done: alpha <= 0 };
}

/** The box's colours: the pack's dialogBox, else the dashboard's tokens. */
export function boxColours(dialogBox, pal) {
  const d = dialogBox || {};
  return { background: d.background || pal.surface, border: d.border || pal.border, text: d.text || pal.text, name: d.name || pal.accent, sub: pal.text2 };
}

const roundRect = (ctx, x, y, w, h, r) => {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
};
/** A 9-slice frame `im` over (x, y, w, h): `s` image px a side, drawn `k` CSS px an image px (unsmoothed). */
function nineSlice(ctx, im, s, x, y, w, h, k) {
  const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height, d = s * k;
  if (!iw || !ih || w < 2 * d || h < 2 * d) return false;
  const sx = [0, s, iw - s, iw], sy = [0, s, ih - s, ih], dx = [x, x + d, x + w - d, x + w], dy = [y, y + d, y + h - d, y + h];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const sw = sx[i + 1] - sx[i], sh = sy[j + 1] - sy[j], dw = dx[i + 1] - dx[i], dh = dy[j + 1] - dy[j];
    if (sw > 0 && sh > 0 && dw > 0 && dh > 0) ctx.drawImage(im, sx[i], sy[j], sw, sh, dx[i], dy[j], dw, dh);
  }
  return true;
}

/**
 * One face where a portrait stands (its feet at (cx, foot)): a portrait (`{ kind: "portrait", im }`, its height `h`,
 * at most `maxW` wide, bottom-anchored), else a framed square (`face` px) sitting just above the box — a picture
 * (`image`), an emoji, or an initial on the identity colour. `dim`: the one not speaking.
 */
function drawFace(ctx, face, cx, L, top, dim, env) {
  if (!face) return;
  ctx.save();
  ctx.globalAlpha *= dim ? 0.55 : 1;
  if (face.kind === "portrait" && face.im) {
    const iw = face.im.naturalWidth || face.im.width, ih = face.im.naturalHeight || face.im.height;
    if (iw && ih) {
      const k = Math.min(L.portrait.h / ih, L.portrait.maxW / iw), w = iw * k, h = ih * k;
      ctx.imageSmoothingEnabled = k < 1;                        // a pixel-art portrait scaled up stays crisp
      ctx.drawImage(face.im, Math.round(cx - w / 2), Math.round(L.portrait.foot - h), Math.round(w), Math.round(h));
    }
    ctx.restore();
    return;
  }
  const s = L.face, x = Math.round(cx - s / 2), y = Math.round(top - s - 6);
  ctx.fillStyle = env.pal.surface2; ctx.strokeStyle = env.pal.border; ctx.lineWidth = 2;
  roundRect(ctx, x, y, s, s, 10); ctx.fill(); ctx.stroke();
  ctx.save(); roundRect(ctx, x + 3, y + 3, s - 6, s - 6, 8); ctx.clip();
  if (face.kind === "image" && face.im) { ctx.imageSmoothingEnabled = true; ctx.drawImage(face.im, x + 3, y + 3, s - 6, s - 6); }
  else {
    if (face.kind === "initial") { ctx.fillStyle = face.color || env.pal.accent; ctx.fillRect(x + 3, y + 3, s - 6, s - 6); }
    ctx.fillStyle = face.kind === "initial" ? "#ffffff" : env.pal.text;
    ctx.font = `${face.kind === "emoji" ? 400 : 700} ${Math.round(s * (face.kind === "emoji" ? 0.5 : 0.44))}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(face.text || "?", x + s / 2, y + s / 2 + 1);
  }
  ctx.restore();
  ctx.restore();
}

/**
 * Draw the box on `ctx` (its transform: CSS px of the stage) — `v`: { L (boxLayout), stage (stageOf), left/right faces,
 * name (the plate), lines (the speaker's whole text, wrapped), status (the agent's line while it works, or null),
 * statusName, more, colours, frame ({ im, slice, k }) }. Whether it is still moving (rising, typing or fading).
 */
export function drawBox(ctx, v, t, env) {
  const { L, stage } = v, b = L.box;
  if (stage.done) return false;
  const rise = Math.round((1 - stage.slide) * (b.h + 40));
  ctx.save();
  ctx.globalAlpha = stage.alpha;
  ctx.translate(0, rise);
  // The portraits stand behind the box: the person's on the left, the agent's on the right (once it works or answers).
  drawFace(ctx, v.left, L.portrait.left, L, b.y, stage.speaker !== "left", env);
  if (v.right) drawFace(ctx, v.right, L.portrait.right, L, b.y, stage.speaker !== "right", env);
  const c = v.colours;
  ctx.save();
  // Opaque (the portraits stand behind it and must not show through); a pack's frame is drawn over the fill.
  ctx.fillStyle = c.background; roundRect(ctx, b.x, b.y, b.w, b.h, 12); ctx.fill();
  if (!(v.frame && v.frame.im && nineSlice(ctx, v.frame.im, v.frame.slice, b.x, b.y, b.w, b.h, v.frame.k))) {
    ctx.strokeStyle = c.border; ctx.lineWidth = 2; roundRect(ctx, b.x + 1, b.y + 1, b.w - 2, b.h - 2, 11); ctx.stroke();
  }
  ctx.restore();
  // The name plate: over the box's top edge, on the speaker's side.
  ctx.font = "700 13px system-ui, sans-serif";
  const nw = Math.min(b.w * 0.6, Math.ceil(ctx.measureText(v.name).width) + 20), nx = stage.speaker === "left" ? b.x + 14 : b.x + b.w - 14 - nw, ny = b.y - Math.round(L.nameH / 2);
  ctx.fillStyle = c.background; ctx.strokeStyle = c.name; ctx.lineWidth = 2;
  roundRect(ctx, nx, ny, nw, L.nameH, 6); ctx.fill(); ctx.stroke();
  ctx.fillStyle = c.name; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(fit(ctx, v.name, nw - 16), nx + 10, ny + L.nameH / 2 + 1);
  // The words, typed out.
  const n = env.still ? Infinity : Math.floor(((t - stage.typedAt) * DLG.CPS) / 1000);
  ctx.font = `400 ${L.font}px system-ui, sans-serif`; ctx.fillStyle = c.text; ctx.textBaseline = "top";
  const shown = typed(v.lines, n);
  shown.forEach((l, i) => ctx.fillText(l, L.text.x, L.text.y + 6 + i * L.lineH));
  // The agent's line while it works; "+N" for the conversations waiting.
  ctx.font = `italic 600 ${L.narrow ? 12 : 13}px system-ui, sans-serif`; ctx.textBaseline = "bottom";
  if (v.status) { ctx.fillStyle = c.name; ctx.textAlign = "right"; ctx.fillText(fit(ctx, v.status, b.w - 2 * L.pad), b.x + b.w - L.pad, b.y + b.h - Math.round(L.pad * 0.75)); }
  ctx.font = `600 ${L.narrow ? 11 : 12}px system-ui, sans-serif`;
  if (v.more > 0) {
    ctx.font = "700 13px system-ui, sans-serif";
    const tag = `+${v.more}`, tw = ctx.measureText(tag).width + 18, th = 22, tx = stage.speaker === "left" ? b.x + b.w - tw - L.pad : b.x + L.pad, ty = b.y + L.pad - 4;
    ctx.fillStyle = c.name; roundRect(ctx, tx, ty, tw, th, th / 2); ctx.fill();
    ctx.fillStyle = c.background; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(tag, tx + tw / 2, ty + th / 2 + 1);
  }
  ctx.restore();
  return stage.slide < 1 || n < lengthOf(v.lines) || stage.alpha < 1;
}
/** `s` cut to `w` px with "…". */
function fit(ctx, s, w) {
  if (ctx.measureText(s).width <= w) return s;
  let c = chars(s);
  while (c.length > 1 && ctx.measureText(`${c.join("")}…`).width > w) c = c.slice(0, -1);
  return `${c.join("")}…`;
}

/** Whether (x, y) — the stage's CSS px — is on the box (with the slide it has now). */
export const onBox = (L, stage, x, y) => !!L && !!stage && !stage.done && stage.alpha > 0.2
  && x >= L.box.x && x < L.box.x + L.box.w && y >= L.box.y + Math.round((1 - stage.slide) * (L.box.h + 40)) - L.nameH / 2 && y < L.box.y + L.box.h + (1 - stage.slide) * (L.box.h + 40);

/**
 * Pictures the box draws that are not a pack's: an avatar's `/ui/img/…` (avatarOf's), read once each; `get(src, done)`
 * the picture or null (not in yet: `done` once it is).
 */
export function createFaces(load = defaultLoad) {
  const seen = new Map();
  return (src, done) => {
    if (!src) return null;
    const had = seen.get(src);
    if (had) { if (had.im === undefined && done) had.waiting.add(done); return had.im || null; }
    const e = { im: undefined, waiting: new Set(done ? [done] : []) };
    seen.set(src, e);
    Promise.resolve(load(src)).catch(() => null).then((im) => { e.im = im || null; for (const fn of e.waiting) { try { fn(); } catch { /* the page's */ } } e.waiting.clear(); });
    return null;
  };
}
function defaultLoad(src) {
  return new Promise((resolve) => {
    if (typeof Image !== "function") { resolve(null); return; }
    const im = new Image();
    im.onload = () => resolve(im); im.onerror = () => resolve(null);
    im.src = src;
  });
}
