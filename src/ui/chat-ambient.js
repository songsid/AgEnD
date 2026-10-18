// #2117: an agent's ambient effect on its own chat — falling petals, rising lanterns, twinkles, stars on a click. The
// agent sends data only (web-ambient.ts checks it; this checks the bounds again); the page draws it with plain nodes
// animated by the Web Animations API: transform and opacity only, positions through the CSSOM (no style attribute,
// #1300), every node aria-hidden and pointer-events: none. The looping layer sits behind the thread (.amb-layer, under
// the scroller and the dock); a burst shows over the messages for a moment (.amb-burst) and never takes the click.
//
// Its own gates (not the Canvas Worker runtime's, #2115): the viewer's "Show agents' themes, effects and widgets", safe
// mode, Web Animations support, and reduced motion only when this device chose to follow the system's setting
// (fx-motion.js; the user's direction: effects play by default). A hidden tab pauses. Nothing else gates it: it runs
// no agent code and fetches nothing but its own glyph pictures (fleet decision: no gate without a threat it stops).
// Caps: 24 looping particles, bursts of at most 16, at most 3 bursts alive — 72 nodes and animations per chat.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { useStore } from "/assets/app-store.js";
import { onPrefsChanged } from "/assets/app-prefs.js";
import { safeMode } from "/assets/owner-css.js";
import { setThemesShown, themeImageUrl, themesShown, themesStore } from "/assets/app-themes.js";
import { markMotionNoteShown, motionBlocked, motionNoteDue, onMotionChange, setFollowsReducedMotion } from "/assets/fx-motion.js";
import "./chat-strings.js";

export const AMBIENT_CAPS = { loop: 24, burst: 16, bursts: 3 };
const LOOP_PRESETS = ["fall", "rise", "twinkle"];
const RULES = {
  fall: { count: [1, 24], duration: [4, 30] }, rise: { count: [1, 24], duration: [4, 30] },
  twinkle: { count: [1, 24], duration: [1, 10] }, "burst-on-click": { count: [4, 16], duration: [0.3, 2] },
};
const COLOR = /^#[0-9a-f]{6}$/;
const ASSET = /^[0-9a-f]{32}$/;
const own = (o, k) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const num = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const pair = (v, lo, hi) => Array.isArray(v) && v.length === 2 && num(v[0], lo, hi) && num(v[1], lo, hi) && v[0] <= v[1];

/** A spec as the host keeps it, checked again; null when anything is off (it is then not drawn at all). */
export function sanitizeAmbient(spec) {
  if (!spec || typeof spec !== "object" || !own(RULES, spec.preset)) return null;
  const r = RULES[spec.preset];
  if (!Array.isArray(spec.glyphs) || spec.glyphs.length < 1 || spec.glyphs.length > 4) return null;
  const glyphs = [];
  for (const g of spec.glyphs) {
    if (typeof g === "string" && g.length >= 1 && g.length <= 32) glyphs.push(g);
    else if (g && typeof g === "object" && typeof g.asset === "string" && ASSET.test(g.asset)) glyphs.push({ asset: g.asset });
    else return null;
  }
  const colors = Array.isArray(spec.colors) ? spec.colors.filter((c) => typeof c === "string" && COLOR.test(c)).slice(0, 5) : [];
  if (!Number.isInteger(spec.count) || !num(spec.count, r.count[0], r.count[1])) return null;
  if (!pair(spec.duration, r.duration[0], r.duration[1]) || !pair(spec.size, 10, 40) || !pair(spec.spread, 20, 120)) return null;
  if (!num(spec.sway, 0, 80) || !num(spec.rotate, 0, 720)) return null;
  if (!Array.isArray(spec.opacity) || spec.opacity.length !== 3 || !spec.opacity.every((o) => num(o, 0, 1))) return null;
  return { preset: spec.preset, glyphs, colors, count: spec.count, duration: spec.duration, size: spec.size, sway: spec.sway, spread: spec.spread, rotate: spec.rotate, opacity: spec.opacity };
}

/** `name`'s ambients from GET /ui/themes, checked: { loop, click } (either null). Null when it has none. */
export function ambientFor(name) {
  const a = themesStore.get().ambient;
  if (!a || typeof a !== "object" || !own(a, name)) return null;
  const mine = a[name];
  const loop = own(mine, "loop") ? sanitizeAmbient(mine.loop && mine.loop.spec) : null;
  const click = own(mine, "click") ? sanitizeAmbient(mine.click && mine.click.spec) : null;
  if (loop && !LOOP_PRESETS.includes(loop.preset)) return null;
  if (click && click.preset !== "burst-on-click") return null;
  return loop || click ? { loop, click } : null;
}

/** Why this page does not draw ambients now, or null. */
export function ambientBlock(win = globalThis) {
  if (safeMode()) return "safe";
  if (!themesShown()) return "hidden";
  if (motionBlocked(win)) return "reducedMotion";
  const El = win.Element;
  if (!El || !El.prototype || typeof El.prototype.animate !== "function") return "unsupported";
  return null;
}

/** The gate as state: moves with the switches, the themes and the device's reduced-motion answer. */
function useAmbientBlock() {
  useStore(themesStore);
  const [, bump] = useState(0);
  useEffect(() => {
    const again = () => bump((n) => n + 1);
    const offPrefs = onPrefsChanged((changed) => { if (changed.has("fx.show")) again(); });
    const offMotion = onMotionChange(again);
    return () => { if (typeof offPrefs === "function") offPrefs(); offMotion(); };
  }, []);
  return ambientBlock();
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** One particle node: a text glyph (its colour, else the accent) or a glyph picture. */
function particle(doc, name, spec, cls) {
  const g = pick(spec.glyphs), size = Math.round(rand(spec.size[0], spec.size[1]));
  let el;
  if (typeof g === "string") {
    el = doc.createElement("span");
    el.textContent = g;
    el.style.setProperty("font-size", `${size}px`);
    if (spec.colors.length) el.style.setProperty("color", pick(spec.colors));
  } else {
    el = doc.createElement("img");
    el.src = themeImageUrl(name, g.asset);
    el.alt = "";
    el.decoding = "async";
    el.draggable = false;
    el.style.setProperty("width", `${size}px`);
    el.style.setProperty("height", `${size}px`);
  }
  el.className = cls;
  el.setAttribute("aria-hidden", "true");
  return { el, size };
}

/**
 * Draw `ambient` ({ loop, click }) for `name` into `layer` (behind) and `front` (bursts), listening on `surface` for
 * clicks. Returns { stop() }: every node and animation it made goes, every listener it added is removed.
 */
export function startAmbient({ name, ambient, layer, front, surface, doc = globalThis.document }) {
  const anims = new Set();
  const loopNodes = [];
  let bursts = 0, stopped = false;
  const track = (a) => { anims.add(a); if (doc.visibilityState === "hidden") a.pause(); return a; };

  const drawLoop = () => {
    for (const n of loopNodes.splice(0)) n.remove();
    for (const a of [...anims]) if (a._amb === "loop") { a.cancel(); anims.delete(a); }
    const spec = ambient.loop;
    if (!spec) return;
    const h = layer.clientHeight || 600, w = layer.clientWidth || 360;
    const [o0, o1, o2] = spec.opacity;
    for (let i = 0; i < Math.min(spec.count, AMBIENT_CAPS.loop); i++) {
      const { el, size } = particle(doc, name, spec, "amb-p");
      const dur = rand(spec.duration[0], spec.duration[1]) * 1000;
      const turn = spec.rotate * (Math.random() < 0.5 ? -1 : 1);
      let frames;
      if (spec.preset === "twinkle") {
        el.style.setProperty("left", `${rand(0, Math.max(0, w - size))}px`);
        el.style.setProperty("top", `${rand(0, Math.max(0, h - size))}px`);
        frames = [
          { transform: "scale(0.6) rotate(0deg)", opacity: o0 },
          { transform: `scale(1) rotate(${turn / 2}deg)`, opacity: o1, offset: 0.5 },
          { transform: `scale(0.6) rotate(${turn}deg)`, opacity: o2 },
        ];
      } else {
        el.style.setProperty("left", `${rand(0, Math.max(0, w - size))}px`);
        el.style.setProperty("top", "0px");
        const dx = rand(-spec.sway, spec.sway), down = spec.preset === "fall";
        const from = down ? -size - 4 : h + 4, to = down ? h + 4 : -size - 4;
        frames = [
          { transform: `translate(0px, ${from}px) rotate(0deg)`, opacity: o0 },
          { transform: `translate(${dx * 0.6}px, ${from + (to - from) * 0.15}px) rotate(${turn * 0.15}deg)`, opacity: o1, offset: 0.15 },
          { transform: `translate(${-dx * 0.4}px, ${from + (to - from) * 0.6}px) rotate(${turn * 0.6}deg)`, opacity: (o1 + o2) / 2, offset: 0.6 },
          { transform: `translate(${dx}px, ${to}px) rotate(${turn}deg)`, opacity: o2 },
        ];
      }
      layer.appendChild(el);
      loopNodes.push(el);
      // A negative delay starts each one part-way through, so the layer is already full when it appears.
      const a = el.animate(frames, { duration: dur, delay: -Math.random() * dur, iterations: Infinity, easing: "linear" });
      a._amb = "loop";
      track(a);
    }
  };

  const burst = (x, y) => {
    const spec = ambient.click;
    if (!spec || bursts >= AMBIENT_CAPS.bursts || stopped) return;
    bursts++;
    const [, o1, o2] = spec.opacity;
    let left = Math.min(spec.count, AMBIENT_CAPS.burst);
    const done = (el, a) => { el.remove(); anims.delete(a); if (--left === 0) bursts--; };
    for (let i = 0, n = left; i < n; i++) {
      const { el, size } = particle(doc, name, spec, "amb-p");
      el.style.setProperty("left", `${x - size / 2}px`);
      el.style.setProperty("top", `${y - size / 2}px`);
      const angle = (i / n) * Math.PI * 2 + rand(-0.3, 0.3), dist = rand(spec.spread[0], spec.spread[1]);
      const turn = rand(-spec.rotate, spec.rotate) / 2;
      front.appendChild(el);
      const a = el.animate([
        { transform: "translate(0px, 0px) scale(0.4) rotate(0deg)", opacity: o1 },
        { transform: `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px) scale(1) rotate(${turn}deg)`, opacity: Math.min(o2, o1) },
      ], { duration: rand(spec.duration[0], spec.duration[1]) * 1000, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" });
      a._amb = "burst";
      track(a);
      let gone = false;
      const finish = () => { if (!gone) { gone = true; done(el, a); } };
      a.onfinish = finish; a.oncancel = finish;
    }
  };

  // Passive and never cancelling: the click still lands on what is under it. Only in the thread (not the composer),
  // and not on a menu or dialog open over it: stars are for the conversation.
  const onDown = (ev) => {
    if (!ambient.click || ev.button > 0) return;
    const target = ev.target;
    if (!target || typeof target.closest !== "function" || !target.closest(".scroller") || target.closest("[role=menu], [role=dialog]")) return;
    const box = front.getBoundingClientRect();
    burst(ev.clientX - box.left, ev.clientY - box.top);
  };
  const onVisible = () => { for (const a of anims) { if (doc.visibilityState === "hidden") a.pause(); else a.play(); } };
  // Size moves (a rotated phone, the preview panel opening): the loop is drawn again for the new box, a moment later.
  let resizeTimer = null, lastW = layer.clientWidth, lastH = layer.clientHeight;
  const ro = typeof globalThis.ResizeObserver === "function" ? new globalThis.ResizeObserver(() => {
    if (layer.clientWidth === lastW && layer.clientHeight === lastH) return;
    lastW = layer.clientWidth; lastH = layer.clientHeight;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!stopped) drawLoop(); }, 200);
  }) : null;

  drawLoop();
  if (ambient.click) surface.addEventListener("pointerdown", onDown, { passive: true });
  doc.addEventListener("visibilitychange", onVisible);
  if (ro && ambient.loop) ro.observe(layer);

  return {
    stop() {
      stopped = true;
      clearTimeout(resizeTimer);
      if (ro) ro.disconnect();
      surface.removeEventListener("pointerdown", onDown, { passive: true });
      doc.removeEventListener("visibilitychange", onVisible);
      for (const a of anims) a.cancel();
      anims.clear();
      for (const n of loopNodes.splice(0)) n.remove();
      while (front.firstChild) front.firstChild.remove();
    },
    /** For tests and the smoke: what is alive now. */
    stats() { return { nodes: layer.children.length + front.children.length, animations: anims.size, bursts }; },
  };
}

/**
 * The chat's ambient: renders its two layers inside .chat-main (`surface`) and runs them. `part` is "layer" (behind,
 * right after the theme picture) or "front" (after the dock); the "layer" instance owns the run and finds its sibling.
 */
export function ChatAmbient({ name, surface, part }) {
  const block = useAmbientBlock();
  const ambient = block ? null : ambientFor(name);
  const key = ambient ? JSON.stringify(ambient) : "";
  const ref = useRef(null);
  useEffect(() => {
    if (part !== "layer" || !ambient) return undefined;
    const layer = ref.current, host = surface.current;
    const front = host && host.querySelector(".amb-burst");
    if (!layer || !host || !front) return undefined;
    host.classList.add("has-amb");
    const run = startAmbient({ name, ambient, layer, front, surface: host });
    if (typeof globalThis !== "undefined") globalThis.__agendAmbient = run;   // the smoke reads stats(); nothing else
    return () => { run.stop(); host.classList.remove("has-amb"); if (globalThis.__agendAmbient === run) delete globalThis.__agendAmbient; };
  }, [name, key, part]);
  if (!ambient) return null;
  return part === "layer" ? html`<div ref=${ref} class="amb-layer" aria-hidden="true"></div>` : html`<div class="amb-burst" aria-hidden="true"></div>`;
}

/**
 * The one-time note (the user's direction): the system asks for reduced motion and this chat's ambient or Canvas Worker plays anyway —
 * say so once on this device, and turn it off right here (this device's switch: the same on the public link, where
 * Settings is not). Shown only while an ambient or Canvas Worker is playing.
 */
export function AmbientMotionNote({ name, canvasPlaying = false }) {
  const block = useAmbientBlock();
  const shown = canvasPlaying || !block && !!ambientFor(name);
  const noteDue = motionNoteDue();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!shown || open || !noteDue) return;
    markMotionNoteShown();
    setOpen(true);
  }, [shown, noteDue]);
  if (!open || !shown) return null;
  const off = () => { setOpen(false); setFollowsReducedMotion(true); };
  return html`<div class="amb-note" data-trust="thread-control" role="status">
    <span>${t("chat.ambientMotionNote")}</span>
    <button type="button" class="amb-note-off" onClick=${off}>${t("chat.ambientMotionNoteLink")}</button>
    <button type="button" class="amb-note-x" aria-label=${t("chat.ambientMotionNoteClose")} onClick=${() => setOpen(false)}>×</button>
  </div>`;
}

/**
 * The fix for a block, done right here: both switches are this viewer's own (the show switch is a local choice on the
 * public link; the reduced-motion one is per device), so it works on the public link too; safe mode is the URL. Both
 * stay in Settings → Web appearance as well.
 */
const FIX = {
  hidden: () => setThemesShown(true),
  reducedMotion: () => setFollowsReducedMotion(false),
  safe: () => { const u = new URL(globalThis.location.href); u.searchParams.delete("safe"); globalThis.location.assign(u.toString()); },
};

/**
 * The chat ⋯ entries for `name`'s ambient: why it is not showing here (a visible reason; choosing it fixes it when the
 * page can), and — for an admin, never over the public link — Clear for each kind.
 */
export function ambientMenuItems(name, { publicLink, clear }) {
  const a = themesStore.get().ambient;
  const mine = a && own(a, name) ? a[name] : null;
  if (!mine || typeof mine !== "object" || !(own(mine, "loop") || own(mine, "click"))) return [];
  const items = [];
  const block = ambientBlock();
  if (block) {
    items.push({
      key: "ambient-blocked", label: t(`chat.ambientBlocked_${block}`), icon: "info",
      onSelect: () => { if (own(FIX, block)) FIX[block](); },
    });
  }
  if (!publicLink) for (const k of ["loop", "click"]) if (own(mine, k)) items.push({ key: `ambient-clear-${k}`, label: t(k === "loop" ? "chat.ambientClearLoop" : "chat.ambientClearClick"), icon: "trash", onSelect: () => clear(name, k) });
  return items;
}
