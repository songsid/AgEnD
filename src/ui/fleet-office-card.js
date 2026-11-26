import { modelSwitchText, modelName, observationLabel } from "/assets/model-observation.js";
// #2661: a person's profile card in the Office (fleet-office.js opens it): a popover beside them, not a modal — the Office
// keeps running and is not dimmed; on a phone, a bottom sheet swiped down to close. Fixed 320 px wide.
//
//   [avatar + badge]  Display name
//                     instance-name (one line, cut, full on hover)
//                     Working · Master                       ← the state as the tooltip words it, and the title
//   Lv 50 · 260M work tokens                                 ← two lines over the XP bar, so neither wraps alone
//   10.4M to Lv 51
//   [=========-----]
//   Office  Engineering · Work        Model    claude-opus-5-5
//   Backend Claude Code               Today    12.3K · 45 requests
//   First seen  Day 42
//   Now: Typing away
//                               [Find in office]  [Chat]
//
// What a viewer sees follows the host (GET /ui/office-levels, src/office-levels.ts): the level for anyone who sees the
// Office; work tokens, today and first seen only where the usage report is served (`detail`). A share link's page (no
// `onChat`) shows the name, title, state and office only — never the model, the backend or numbers. A title a skin pack
// pins (`levels.fixed`) shows whatever the level; with hideLevel, no "Lv n" and no XP bar. Levels off: no level rows.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { backendLabel, modelText, namesOf } from "/assets/instance-nav.js";
import { badgeText, fixedOf, tierOf, titleOf, tokens, xpOf } from "./fleet-office-levels.js";
import { CARD_ROWS, CARD_SECTIONS, contrastRatio, relativeLuminance } from "./fleet-office-pack.js";
import { nineSlice } from "./fleet-office-dialogue.js";
import { RENAME_LEN } from "./fleet-office-store.js";

register("ocard", {
  en: {
    card: "{0}'s card", level: "Lv {0}", work: "{0} work tokens", estimated: "estimated", toNext: "{0} to Lv {1}", office: "Office", model: "Model", backend: "Backend",
    today: "Today", todayN: "{0} work tokens · {1} requests", firstSeen: "First seen", day: "Day {0}", now: "Now", nowLabel: "Now: ", find: "Find in office", chat: "Chat", pat: "Pat", feed: "Feed", tell: "Tell {0} (with their next message)", tellNote: "Off: only you see it. On: a line like “[Office] <your name> patted your head ×3” rides the next message they get anyway — it never wakes them.",
    chatWindow: "Open {0}’s chat in a new window",
    close: "Close", xp: "Progress to Lv {0}", rename: "Rename (only you see it)", renameField: "Name you see",
    previewPose: "Preview pose", previewOff: "Off", replay: "Replay", poseOption: "{0} ({1})",
    pose_idle: "Idle", pose_working: "Working", pose_paused: "Paused", pose_needs: "Needs a person", pose_walkDown: "Walk down", pose_walkUp: "Walk up",
    pose_walkSide: "Walk sideways", pose_walkLeft: "Walk left", pose_eat: "Eat", pose_pat: "Patted", pose_dragged: "Dragged", pose_stand: "Card pose",
  },
  "zh-TW": {
    card: "{0} 的名片", level: "Lv {0}", work: "{0} 工作 token", estimated: "估算", toNext: "再 {0} 到 Lv {1}", office: "辦公室", model: "模型", backend: "後端",
    today: "今天", todayN: "{0} 工作 token · {1} 次請求", firstSeen: "首次出現", day: "第 {0} 天", now: "現在", nowLabel: "現在：", find: "在辦公室找它", chat: "聊天", pat: "摸頭", feed: "餵點心", tell: "讓 {0} 知道（隨下一則訊息）", tellNote: "關閉：只有你看得到。開啟：下一則本來就會送給它的訊息會附上一行，例如「[Office] <你的名字> patted your head ×3」，不會叫醒它。",
    chatWindow: "在新視窗開啟 {0} 的聊天",
    close: "關閉", xp: "升到 Lv {0} 的進度", rename: "改名（只有你看得到）", renameField: "你看到的名字",
    previewPose: "預覽動作", previewOff: "關閉", replay: "重播", poseOption: "{0}（{1}）",
    pose_idle: "閒置", pose_working: "工作", pose_paused: "暫停", pose_needs: "呼叫人", pose_walkDown: "向下走", pose_walkUp: "向上走",
    pose_walkSide: "側著走", pose_walkLeft: "向左走", pose_eat: "吃點心", pose_pat: "被摸頭", pose_dragged: "被拖著", pose_stand: "名片站姿",
  },
});
const tc = (k, ...v) => t(`ocard.${k}`, ...v);
/** #4508 review: a pose's name in the viewer's language, with the strip key a pack author looks for ("Walk up (walkUp)"). */
export const poseName = (key) => { const k = `pose_${key}`, label = tc(k); return label && label !== `ocard.${k}` ? tc("poseOption", label, key) : key; };

/** The days from `first` (YYYY-MM-DD, the fleet's zone) to today on this device's clock, counting the first as day 1. */
export function dayOf(first, nowMs = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(first || "");
  if (!m) return null;
  const d = new Date(nowMs), today = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.max(1, Math.floor((today - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86_400_000) + 1);
}

/**
 * What the card says (pure, for the component and the tests): `node` the org chart's node; `lv` levelsOk's answer (or
 * null); `levels` the style's pack `levels` (or null); `share` a share link's page; `state` the state's words; `now`
 * the tooltip's activity line; `where` the office (and area) in words. M-3533: `rows` ({ key, label, value }[]) the
 * card's rows instead of the office's own (a Hub room's office: the agent's owner and introduction); `display` the card's
 * name instead of the person's (a room's: the agent's own name, where the scene's label adds its owner).
 */
export function cardModel({ node, lv, levels, share = false, state, now, where, rows: given = null, display = "" }) {
  const it = node.i || {};
  const names = node.i ? namesOf(node.i) : { primary: node.name, secondary: "" };
  const fx = fixedOf(node.name, levels);
  const on = !!(lv && lv.enabled);
  const e = on ? lv.levels.get(node.name) || null : null;
  const showLevel = !!e && !(fx && fx.hideLevel);
  const title = on && fx ? fx.title : e ? titleOf(e.level, levels && levels.titles) : null;
  const detail = !share && !!e && e.workTokens !== undefined;
  const xp = showLevel && detail ? xpOf(e.level, e.workTokens, lv.unit) : null;
  const rowItems = Array.isArray(given) ? given.filter((r) => r && r.value) : [{ key: "office", label: tc("office"), value: where }];
  if (!given && !share && it.model) rowItems.push({
    key: "model",
    label: it.model_observation ? observationLabel("selection") : tc("model"),
    value: it.model_observation ? (modelName(it.model_observation.session) || observationLabel("unresolved")) : modelText(it),
  });
  if (!given && !share && it.backend) rowItems.push({ key: "backend", label: tc("backend"), value: backendLabel(it.backend) });
  if (detail) rowItems.push({ key: "today", label: tc("today"), value: tc("todayN", tokens(e.today.workTokens), e.today.requests) });
  if (detail && e.firstSeen) rowItems.push({ key: "firstSeen", label: tc("firstSeen"), value: tc("day", dayOf(e.firstSeen)) });
  const rows = rowItems.map((r) => [r.label, r.value]);
  return {
    name: display || names.primary, instance: given ? "" : node.name, state, title,
    stateLine: title ? `${state} · ${title}` : state,
    badge: on && fx && fx.hideLevel ? { mark: true, tier: 0 } : e ? { text: badgeText(e.level), tier: tierOf(e.level) } : null,
    level: showLevel ? { line1: detail ? `${tc("level", e.level)} · ${tc("work", tokens(e.workTokens))}` : tc("level", e.level), estimated: detail && e.estimated,
      line2: xp ? tc("toNext", tokens(xp.toNext), xp.next) : null, pct: xp ? xp.pct : null, next: xp ? xp.next : null } : null,
    rows, rowItems, now, modelSwitch: !share ? modelSwitchText(it.model_observation?.active) : "",
  };
}

// ── M-3433 (#4256): skin-pack card preset, style & layout resolution ──

const PRESET_LAYOUTS = {
  default: { avatarSize: "md", avatarSource: "sprite", headerAlign: "left", width: 320, sections: [...CARD_SECTIONS], rows: [...CARD_ROWS], rowColumns: 2, hide: [] },
  rpg: { avatarSize: "lg", avatarSource: "portrait", headerAlign: "center", width: 340, sections: [...CARD_SECTIONS], rows: [...CARD_ROWS], rowColumns: 2, hide: ["instance"] },
  compact: { avatarSize: "sm", avatarSource: "sprite", headerAlign: "left", width: 296, sections: ["header", "rows", "actions"], rows: ["office", "model", "today"], rowColumns: 2, hide: ["instance", "badge", "level", "xpBar", "now"] },
  dossier: { avatarSize: "md", avatarSource: "portrait", headerAlign: "left", width: 352, sections: [...CARD_SECTIONS], rows: [...CARD_ROWS], rowColumns: 1, hide: [] },
};
const PRESET_RADIUS = { default: "lg", rpg: "sm", compact: "md", dossier: "md" };
const AVATAR_PX = { sm: 44, md: 56, lg: 84 };
const RADIUS_VAR = { none: "0px", sm: "var(--r-sm)", md: "var(--r-md)", lg: "var(--r-lg)" };
const CARD_CSS_PROPS = [
  "--oo-card-bg", "--oo-card-border", "--oo-card-text", "--oo-card-muted", "--oo-card-accent",
  "--oo-card-bar-track", "--oo-card-bar-fill", "--oo-card-tile-bg", "--oo-card-btn-bg", "--oo-card-btn-text",
  "--oo-card-btn-primary-bg", "--oo-card-btn-primary-text", "--oo-card-radius", "--oo-card-w",
  "--oo-card-avatar", "--oo-card-frame-pad", "--oo-card-enter-ms",
];

function fgFor(bgHex, minRatio = 4.5, light = "#f6f4f0", dark = "#18181b") {
  const rl = contrastRatio(light, bgHex), rd = contrastRatio(dark, bgHex);
  if (rl >= rd) return rl >= minRatio ? light : "#ffffff";
  return rd >= minRatio ? dark : "#000000";
}

function mixHex(fgHex, bgHex, alpha) {
  const ch = (i) => {
    const a = parseInt(fgHex.slice(i, i + 2), 16), b = parseInt(bgHex.slice(i, i + 2), 16);
    return Math.round(a * alpha + b * (1 - alpha)).toString(16).padStart(2, "0");
  };
  return `#${ch(1)}${ch(3)}${ch(5)}`;
}

function scrimRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Resolve a checked pack's optional `card` into concrete layout, CSS custom properties, and backdrop config.
 * Returns null when the pack defines no `card` (legacy default rendering is preserved untouched).
 */
export function resolveCardSpec(packCard) {
  if (!packCard || typeof packCard !== "object") return null;
  const preset = PRESET_LAYOUTS[packCard.preset] ? packCard.preset : "default";
  const base = PRESET_LAYOUTS[preset];
  const rawLayout = packCard.layout || {};
  const layout = {
    avatarSize: rawLayout.avatarSize || base.avatarSize,
    avatarSource: rawLayout.avatarSource || base.avatarSource,
    headerAlign: rawLayout.headerAlign || base.headerAlign,
    width: rawLayout.width ?? base.width,
    sections: rawLayout.sections ? [...rawLayout.sections] : [...base.sections],
    rows: rawLayout.rows ? [...rawLayout.rows] : [...base.rows],
    rowColumns: rawLayout.rowColumns ?? base.rowColumns,
    hide: rawLayout.hide ? [...rawLayout.hide] : [...base.hide],
  };
  const s = packCard.style || {};
  const hasSurface = !!(s.background || s.backgroundImage);
  const bgRef = s.background || (s.backgroundImage ? "#181614" : null);
  const lum = bgRef ? relativeLuminance(bgRef) : null;
  const dark = lum !== null && lum < 0.35;

  let text = s.text || null;
  let muted = s.muted || null;
  let border = s.border || null;
  let accent = s.accent || null;
  let barTrack = s.barTrack || null;
  let barFill = s.barFill || null;
  let tileBgBase = null;
  let buttonBg = s.buttonBg || null;
  let buttonText = s.buttonText || null;
  let buttonPrimaryBg = s.buttonPrimaryBg || null;
  let buttonPrimaryText = s.buttonPrimaryText || null;

  const pickContrast = (against, minRatio, candidates) => {
    for (const c of candidates) if (c && contrastRatio(c, against) >= minRatio) return c;
    return fgFor(against, minRatio, "#f6f4f0", "#18181b");
  };

  if (hasSurface && bgRef) {
    if (!text || contrastRatio(text, bgRef) < 4.5) text = fgFor(bgRef, 4.5, "#f6f4f0", "#18181b");
    if (!border || contrastRatio(border, bgRef) < 3.0) {
      border = pickContrast(bgRef, 3.0, [dark ? "#6e665c" : "#71717a", dark ? "#a8a29e" : "#52525b"]);
    }
    if (accent && contrastRatio(accent, bgRef) < 4.5) accent = text;
    if (!barTrack) {
      barTrack = barFill
        ? pickContrast(barFill, 3.0, [dark ? "#342f2a" : "#d4d4d8", "#27272a", "#e4e4e7"])
        : (dark ? "#342f2a" : "#d4d4d8");
    }
    if (!barFill || contrastRatio(barFill, barTrack) < 3.0) {
      barFill = pickContrast(barTrack, 3.0, [s.accent, accent, dark ? "#e5b84b" : "#4f46e5"]);
    }
    // Dual-surface safety for RPG tiles (XP box = 65%, stat tile = 45% tint over bgRef):
    // both text and muted must stay >= 4.5:1 against bgRef AND the tinted tiles simultaneously.
    // If an extreme barTrack (e.g. #ffffff on dark #181614) would break dual-surface contrast,
    // decouple --oo-card-tile-bg from barTrack so the progress bar keeps barTrack while tiles stay readable.
    const mutedPool = [s.muted, dark ? "#d6d0c6" : "#374151", dark ? "#e7e5e0" : "#1f2937", text, "#ffffff", "#000000"].filter(Boolean);
    const surfacesFor = (tb) => (preset === "rpg" && tb ? [bgRef, mixHex(tb, bgRef, 0.65), mixHex(tb, bgRef, 0.45)] : [bgRef]);
    const okOnAll = (c, surfs) => surfs.every((sf) => contrastRatio(c, sf) >= 4.5);
    const pickDualMuted = (surfs) => mutedPool.find((c) => okOnAll(c, surfs)) || null;
    if (preset === "rpg") {
      const tileCandidates = [barTrack, dark ? "#342f2a" : "#d4d4d8", bgRef];
      let chosen = bgRef, chosenMuted = null;
      for (const tb of tileCandidates) {
        const surfs = surfacesFor(tb);
        if (!okOnAll(text, surfs)) continue;
        const m = pickDualMuted(surfs);
        if (m) { chosen = tb; chosenMuted = m; break; }
      }
      tileBgBase = chosen;
      muted = chosenMuted || text;
    } else {
      muted = pickDualMuted([bgRef]) || text;
    }
    if (!buttonBg) {
      buttonBg = buttonText
        ? pickContrast(buttonText, 4.5, [dark ? "#2c2622" : "#e4e4e7", "#1f2937", "#f4f4f5"])
        : (dark ? "#2c2622" : "#e4e4e7");
    }
  } else {
    // Partial overrides without an explicit card background: pair each supplied side with a contrasting counterpart.
    if (barTrack && (!barFill || contrastRatio(barFill, barTrack) < 3.0)) {
      barFill = pickContrast(barTrack, 3.0, [s.accent, "#4f46e5", "#e5b84b"]);
    } else if (barFill && !barTrack) {
      barTrack = pickContrast(barFill, 3.0, ["#27272a", "#e4e4e7"]);
    }
    if (buttonText && !buttonBg) buttonBg = pickContrast(buttonText, 4.5, ["#1f2937", "#f4f4f5"]);
  }

  if (buttonBg && (!buttonText || contrastRatio(buttonText, buttonBg) < 4.5)) {
    buttonText = fgFor(buttonBg, 4.5, "#f6f4f0", "#18181b");
  }
  // Primary button falls back to accent in CSS: resolve its foreground explicitly so light/dark surface never breaks contrast.
  if (!buttonPrimaryBg && buttonPrimaryText) {
    buttonPrimaryBg = pickContrast(buttonPrimaryText, 4.5, [accent, "#1d4ed8", "#18181b", "#f4f4f5"]);
  } else if (!buttonPrimaryBg && accent) {
    buttonPrimaryBg = accent;
  }
  if (buttonPrimaryBg && (!buttonPrimaryText || contrastRatio(buttonPrimaryText, buttonPrimaryBg) < 4.5)) {
    buttonPrimaryText = fgFor(buttonPrimaryBg, 4.5, "#f6f4f0", "#18181b");
  }

  const radiusKey = s.radius || PRESET_RADIUS[preset] || "lg";
  const avatarPx = AVATAR_PX[layout.avatarSize] || 56;
  const cssVars = {
    "--oo-card-w": `${layout.width}px`,
    "--oo-card-avatar": `${avatarPx}px`,
    "--oo-card-radius": RADIUS_VAR[radiusKey] || "var(--r-lg)",
  };
  if (s.background) cssVars["--oo-card-bg"] = s.background;
  else if (s.backgroundImage && bgRef) cssVars["--oo-card-bg"] = bgRef;
  if (border) cssVars["--oo-card-border"] = border;
  if (text) cssVars["--oo-card-text"] = text;
  if (muted) cssVars["--oo-card-muted"] = muted;
  if (accent) cssVars["--oo-card-accent"] = accent;
  if (barTrack) cssVars["--oo-card-bar-track"] = barTrack;
  if (barFill) cssVars["--oo-card-bar-fill"] = barFill;
  if (tileBgBase) cssVars["--oo-card-tile-bg"] = tileBgBase;
  if (buttonBg) cssVars["--oo-card-btn-bg"] = buttonBg;
  if (buttonText) cssVars["--oo-card-btn-text"] = buttonText;
  if (buttonPrimaryBg) cssVars["--oo-card-btn-primary-bg"] = buttonPrimaryBg;
  if (buttonPrimaryText) cssVars["--oo-card-btn-primary-text"] = buttonPrimaryText;

  const backdrop = (s.backgroundImage || s.frame) ? {
    backgroundImage: s.backgroundImage || null,
    frame: s.frame || null,
    slice: s.frame ? (s.slice ?? 8) : 0,
    scrim: s.backgroundImage && bgRef ? scrimRgba(bgRef, dark ? 0.56 : 0.72) : null,
  } : null;

  const motion = packCard.motion && packCard.motion.enter !== "none" ? packCard.motion : null;
  if (motion) cssVars["--oo-card-enter-ms"] = `${motion.ms}ms`;
  return { preset, layout, avatarPx, hideSet: new Set(layout.hide), cssVars, backdrop, motion };
}

/** Ordered visible rows for `model` under `spec`; never restores fields stripped by `cardModel` on share links. */
export function visibleRows(model, spec) {
  const items = Array.isArray(model?.rowItems) ? model.rowItems : [];
  if (!spec) return items;
  const byKey = new Map(items.map((r) => [r.key, r]));
  const out = [];
  for (const k of spec.layout.rows) {
    if (spec.hideSet.has(k)) continue;
    const item = byKey.get(k);
    if (item) out.push(item);
  }
  return out;
}

/** Draw optional pack backgroundImage (cover + readability scrim) and 9-slice frame onto the card's backing canvas. */
export function drawCardBackdrop(cv, { bgIm, frameIm, slice, scale = 2, scrim }) {
  const g = cv && cv.getContext ? cv.getContext("2d") : null;
  if (!g) return 0;
  const w = Math.round(cv.clientWidth || 0), h = Math.round(cv.clientHeight || 0);
  if (w < 2 || h < 2) return 0;
  const r = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
  if (cv.width !== Math.round(w * r) || cv.height !== Math.round(h * r)) {
    cv.width = Math.round(w * r);
    cv.height = Math.round(h * r);
  }
  g.setTransform(r, 0, 0, r, 0, 0);
  g.clearRect(0, 0, w, h);
  if (bgIm) {
    const iw = bgIm.naturalWidth || bgIm.width, ih = bgIm.naturalHeight || bgIm.height;
    if (iw && ih) {
      const k = Math.max(w / iw, h / ih), dw = iw * k, dh = ih * k;
      g.imageSmoothingEnabled = k < 1;
      g.drawImage(bgIm, Math.round((w - dw) / 2), Math.round((h - dh) / 2), Math.round(dw), Math.round(dh));
      if (scrim) { g.fillStyle = scrim; g.fillRect(0, 0, w, h); }
    }
  }
  let borderPx = 0;
  if (frameIm && slice > 0) {
    const maxBorder = Math.max(4, Math.min(20, Math.floor(Math.min(w, h) * 0.2)));
    const k = Math.max(1, Math.min(scale || 2, Math.floor(maxBorder / slice) || 1));
    g.imageSmoothingEnabled = false;
    if (nineSlice(g, frameIm, slice, 0, 0, w, h, k)) borderPx = slice * k;
  }
  return borderPx;
}

function drawPortraitAvatar(cv, im, W) {
  const g = cv && cv.getContext ? cv.getContext("2d") : null;
  const iw = im && (im.naturalWidth || im.width), ih = im && (im.naturalHeight || im.height);
  if (!g || !iw || !ih) return false;
  const r = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
  if (cv.width !== Math.round(W * r) || cv.height !== Math.round(W * r)) {
    cv.width = Math.round(W * r);
    cv.height = Math.round(W * r);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  const side = Math.min(iw, ih), sx = Math.round((iw - side) / 2), sy = Math.round((ih - side) * 0.18);
  g.imageSmoothingEnabled = side > cv.width;
  g.drawImage(im, sx, sy, side, side, 0, 0, cv.width, cv.height);
  return true;
}

/**
 * The card. `model`: cardModel's; `avatar(canvas, sizePx)`: draws the person's idle frame on it; `sheet`: a bottom
 * sheet (a phone); `place(el)`: the page positions the popover (beside the person, following them); `onChat` (none on
 * a share link), `onFind`, `onClose`; M-3293: `onReact(kind)` — Pat and Feed (only where play is on; none on a share
 * link); M-3433: optional `packCard`, `picture` (lazy image loader), `portrait` (src), `packScale`; M-3533: `action`
 * ({ label, title, run }) the card's own main action, from the page (a Hub room's office: "@ it", to ask it in the chat);
 * M-3533 R2b: `photo` (src) the agent's identity-card picture (a Hub room's), drawn as the pack portrait is, in place of
 * the figure once it loads; the figure while it loads or when it fails.
 */
/**
 * The card's name, and with `rename` ({ value, save }) a pencil beside it: a field for the name this browser shows
 * (Enter or leaving it keeps it, Escape does not; empty gives back their own).
 */
function CardName({ name, rename }) {
  const [editing, setEditing] = useState(false);
  const field = useRef(null);
  // Filled once, as the field appears: a `value` prop would put the name back over what is typed at each redraw.
  useLayoutEffect(() => { if (editing && field.current) { field.current.value = (rename && rename.value) || name; field.current.focus(); field.current.select(); } }, [editing]);
  if (!rename) return html`<strong class="oo-card-name">${name}</strong>`;
  const done = (keep) => { if (!editing) return; setEditing(false); if (keep && field.current) rename.save(field.current.value.trim()); };
  if (editing) return html`<input ref=${field} class="oo-card-rename" maxlength=${RENAME_LEN} aria-label=${tc("renameField")}
    onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); } }} onBlur=${() => done(true)} />`;
  return html`<span class="oo-card-name-row"><strong class="oo-card-name">${name}</strong><button type="button" class="icon-btn oo-card-rename-btn"
    aria-label=${tc("rename")} title=${tc("rename")} onClick=${() => setEditing(true)}>✎</button></span>`;
}

export function OfficeCard({ model: m, avatar, sheet, place, onChat, onFind, onClose, onReact = null, tell = null, rename = null, preview = null, packCard = null, picture = null, portrait = null, packScale = 2, action = null, photo = null }) {
  // #4504: a skin pack's pose preview (`preview` = { poses, pose, set, replay }): the person plays the picked pose in place.
  const previewRow = preview ? html`<div key="preview" class="oo-card-preview"><label>${tc("previewPose")}
      <select value=${preview.pose} onChange=${(e) => preview.set(e.target.value)}><option value="">${tc("previewOff")}</option>${preview.poses.map((p) => html`<option value=${p}>${poseName(p)}</option>`)}</select></label>
      <button type="button" class="btn btn-sm btn-ghost oo-card-replay" disabled=${!preview.pose} onClick=${preview.replay}>${tc("replay")}</button></div>` : null;
  // `action`: one, or a list (M-3565: a Hub room's "@ it" and "Chat with it one-to-one"); the first is the primary button.
  const actions = Array.isArray(action) ? action.filter(Boolean) : action ? [action] : [];
  const actionButtons = actions.map((a, i) => html`<button key=${i} type="button" class=${`btn btn-sm ${i === 0 ? "btn-primary " : ""}oo-card-action`} title=${a.title || undefined} aria-label=${a.title || undefined} onClick=${a.run}>${a.label}</button>`);
  const box = useRef(null), canvas = useRef(null), bgCanvas = useRef(null), swipe = useRef(null);
  const [picRev, setPicRev] = useState(0);
  const spec = useMemo(() => resolveCardSpec(packCard), [packCard]);
  const avatarPx = spec ? spec.avatarPx : 56;
  const wantPortrait = !!(spec && spec.layout.avatarSource === "portrait" && portrait && typeof picture === "function");
  const [photoIm, setPhotoIm] = useState(null);
  useEffect(() => {
    setPhotoIm(null);
    if (!photo || typeof Image === "undefined") return undefined;
    let live = true;
    const im = new Image();
    im.onload = () => { if (live) setPhotoIm(im); };
    im.src = photo;
    return () => { live = false; };
  }, [photo]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !el.style) return undefined;
    for (const prop of CARD_CSS_PROPS) {
      const val = spec && spec.cssVars[prop];
      if (val !== undefined) el.style.setProperty(prop, val);
      else el.style.removeProperty(prop);
    }
    if (place) place(el);
    return () => {
      if (!el.style) return;
      for (const prop of CARD_CSS_PROPS) el.style.removeProperty(prop);
    };
  }, [spec, sheet]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    if (photoIm && drawPortraitAvatar(cv, photoIm, avatarPx)) return;
    if (wantPortrait) {
      const im = picture(portrait, () => setPicRev((n) => n + 1));
      if (im && drawPortraitAvatar(cv, im, avatarPx)) return;
    }
    if (avatar) avatar(cv, avatarPx);
  });

  useEffect(() => {
    if (!spec || !spec.backdrop || !bgCanvas.current || typeof picture !== "function") return undefined;
    const wake = () => setPicRev((n) => n + 1);
    const paint = () => {
      const cv = bgCanvas.current, el = box.current;
      if (!cv || !el) return;
      const bgIm = spec.backdrop.backgroundImage ? picture(spec.backdrop.backgroundImage, wake) : null;
      const frameIm = spec.backdrop.frame ? picture(spec.backdrop.frame, wake) : null;
      const borderPx = drawCardBackdrop(cv, { bgIm, frameIm, slice: spec.backdrop.slice, scale: packScale, scrim: spec.backdrop.scrim });
      if (el.style) {
        if (borderPx > 0) el.style.setProperty("--oo-card-frame-pad", `${Math.min(28, borderPx + 6)}px`);
        else el.style.removeProperty("--oo-card-frame-pad");
      }
      if (place) place(el);
    };
    paint();
    const RO = globalThis.ResizeObserver;
    if (typeof RO === "function" && box.current) {
      const ro = new RO(() => paint());
      ro.observe(box.current);
      return () => ro.disconnect();
    }
    return undefined;
  }, [spec, picture, packScale, picRev, sheet]);

  useEffect(() => { place && place(box.current); });
  // Closed (unmounted): the page hears it, as it heard the card open — a scene drawn around the card (the tags it covered,
  // #4379 review) is drawn again without it, reduced motion included.
  const placeNow = useRef(place);
  placeNow.current = place;
  useEffect(() => () => { if (placeNow.current) placeNow.current(null); }, []);
  // A bottom sheet closes on a swipe down (60 px or more). M-3633 (Prism #4414): a sheet whose content scrolls lets the
  // browser scroll it (touch-action pan-y — and a browser that takes a touch for scrolling cancels the pointer, so a
  // swipe there could never finish): it closes from its grip, a handle the browser leaves to the page (touch-action
  // none, kept at its top). One that fits closes from anywhere, as before. `data-scrolls` says which (the CSS).
  const scrolls = () => { const t = box.current, sc = t && ((typeof t.querySelector === "function" && t.querySelector(".oo-card-body")) || t); return !!sc && sc.scrollHeight > sc.clientHeight + 1; };
  // …and (Leader #4414) a card whose content scrolls — a sheet, or a desk card held shorter under an area's name —
  // says there is more below: `data-more` while it is not scrolled to its end, a fade over the pinned actions (the CSS).
  useLayoutEffect(() => {
    const t = box.current;
    if (!t || typeof t.setAttribute !== "function") return undefined;
    const sc = (typeof t.querySelector === "function" && t.querySelector(".oo-card-body")) || t;
    const mark = () => {
      if (sheet && scrolls()) t.setAttribute("data-scrolls", ""); else t.removeAttribute("data-scrolls");
      if (sc.scrollHeight - sc.scrollTop - sc.clientHeight > 2) t.setAttribute("data-more", ""); else t.removeAttribute("data-more");
    };
    mark();
    const RO = globalThis.ResizeObserver, ro = typeof RO === "function" ? new RO(mark) : null;
    if (ro) { ro.observe(t); for (const el of t.querySelectorAll?.(".oo-card-body, .oo-card-body > *, .oo-card > *") ?? []) ro.observe(el); }
    if (typeof sc.addEventListener === "function") sc.addEventListener("scroll", mark, { passive: true });
    return () => { if (ro) ro.disconnect(); if (typeof sc.removeEventListener === "function") sc.removeEventListener("scroll", mark); };
  });
  const down = (e) => {
    if (!sheet) return;
    const onGrip = !!(e.target && typeof e.target.closest === "function" && e.target.closest(".oo-card-grip"));
    swipe.current = onGrip || !scrolls() ? e.clientY : null;
  };
  const up = (e) => { if (sheet && swipe.current !== null && e.clientY - swipe.current > 60) onClose(); swipe.current = null; };

  // Legacy default path (packs without `card`): preserve exact markup and classes.
  if (!spec) {
    return html`<div ref=${box} class=${`oo-card${sheet ? " sheet" : ""}`} role="dialog" aria-modal="false" aria-label=${tc("card", m.name)}
        onPointerDown=${down} onPointerUp=${up} onPointerCancel=${() => { swipe.current = null; }}>
      ${sheet ? html`<div class="oo-card-grip" aria-hidden="true"></div>` : null}
      ${m.modelSwitch ? html`<p class="oo-card-now model-switch" role="status"><strong>${m.modelSwitch}</strong></p>` : null}
      <div class="oo-card-head">
        <div class="oo-card-avatar"><canvas ref=${canvas} width="56" height="56" aria-hidden="true"></canvas>
          ${m.badge ? html`<span class=${`oo-badge tier-${m.badge.tier}${m.badge.mark ? " mark" : ""}`} aria-hidden="true">${m.badge.mark ? "" : m.badge.text}</span>` : null}</div>
        <div class="oo-card-names">
          <${CardName} name=${m.name} rename=${rename} />
          ${m.instance ? html`<div class="oo-card-instance mono" title=${m.instance}>${m.instance}</div>` : null}
          <div class="oo-card-state">${m.stateLine}</div>
        </div>
        <button type="button" class="icon-btn oo-card-close" aria-label=${tc("close")} title=${tc("close")} onClick=${onClose}>×</button>
      </div>
      ${m.level ? html`<div class="oo-card-xp">
        <div>${m.level.line1}${m.level.estimated ? html` <span class="muted">(${tc("estimated")})</span>` : null}</div>
        ${m.level.line2 ? html`<div class="muted">${m.level.line2}</div>` : null}
        ${m.level.pct !== null ? html`<progress class="oo-card-bar" max="100" value=${Math.round(m.level.pct * 100)} aria-label=${tc("xp", m.level.next)}></progress>` : null}
      </div>` : null}
      <dl class="oo-card-rows">${(m.rowItems || m.rows.map(([label, value]) => ({ key: "", label, value }))).map((r) => html`<div data-row=${r.key || undefined}><dt>${r.label}</dt><dd>${r.value}</dd></div>`)}</dl>
      ${m.now ? html`<div class="oo-card-now"><span class="muted">${tc("nowLabel")}</span>${m.now}</div>` : null}
      ${tell ? html`<label class="check oo-card-tell" title=${tc("tellNote")}><input type="checkbox" checked=${tell.on} onChange=${(e) => tell.set(e.target.checked)} />
        <span>${tc("tell", m.name)}</span></label>` : null}
      ${previewRow}
      <div class="oo-card-actions">
        ${onReact ? html`<button type="button" class="btn btn-sm btn-ghost oo-card-pat" onClick=${() => onReact("pat")}>${tc("pat")}</button>
          <button type="button" class="btn btn-sm btn-ghost oo-card-feed" onClick=${() => onReact("feed")}>${tc("feed")}</button>` : null}
        ${onFind ? html`<button type="button" class="btn btn-sm btn-ghost oo-card-find" onClick=${onFind}>${tc("find")}</button>` : null}
        ${onChat ? html`<button type="button" class="btn btn-sm btn-primary oo-card-chat" title=${tc("chatWindow", m.name)} aria-label=${tc("chatWindow", m.name)} onClick=${onChat}>${tc("chat")}</button>` : null}
        ${actionButtons}
      </div>
    </div>`;
  }

  const hide = spec.hideSet;
  const rows = visibleRows(m, spec);
  const stateLine = hide.has("title") ? m.state : m.stateLine;
  const classes = [
    "oo-card",
    "oo-card-custom",
    spec.preset !== "default" ? `oo-card-${spec.preset}` : "",
    spec.layout.headerAlign === "center" ? "oo-card-center" : "",
    `oo-card-cols-${spec.layout.rowColumns}`,
    spec.backdrop && spec.backdrop.frame ? "oo-card-framed" : "",
    sheet ? "sheet" : "",
  ].filter(Boolean).join(" ");

  const renderSection = (sec) => {
    if (sec === "header") {
      return html`<div key="header" class="oo-card-head">
        <div class="oo-card-avatar"><canvas ref=${canvas} width=${avatarPx} height=${avatarPx} aria-hidden="true"></canvas>
          ${m.badge && !hide.has("badge") ? html`<span class=${`oo-badge tier-${m.badge.tier}${m.badge.mark ? " mark" : ""}`} aria-hidden="true">${m.badge.mark ? "" : m.badge.text}</span>` : null}</div>
        <div class="oo-card-names">
          <${CardName} name=${m.name} rename=${rename} />
          ${!hide.has("instance") && m.instance ? html`<div class="oo-card-instance mono" title=${m.instance}>${m.instance}</div>` : null}
          <div class="oo-card-state">${stateLine}</div>
        </div>
        <button type="button" class="icon-btn oo-card-close" aria-label=${tc("close")} title=${tc("close")} onClick=${onClose}>×</button>
      </div>`;
    }
    if (sec === "level") {
      if (!m.level || hide.has("level")) return null;
      return html`<div key="level" class="oo-card-xp">
        <div>${m.level.line1}${m.level.estimated ? html` <span class="muted">(${tc("estimated")})</span>` : null}</div>
        ${m.level.line2 ? html`<div class="muted">${m.level.line2}</div>` : null}
        ${m.level.pct !== null && !hide.has("xpBar") ? html`<progress class="oo-card-bar" max="100" value=${Math.round(m.level.pct * 100)} aria-label=${tc("xp", m.level.next)}></progress>` : null}
      </div>`;
    }
    if (sec === "rows") {
      if (!rows.length) return null;
      return html`<dl key="rows" class="oo-card-rows">${rows.map((r) => html`<div key=${r.key} data-row=${r.key}><dt>${r.label}</dt><dd>${r.value}</dd></div>`)}</dl>`;
    }
    if (sec === "now") {
      if (!m.now || hide.has("now")) return null;
      return html`<div key="now" class="oo-card-now"><span class="muted">${tc("nowLabel")}</span>${m.now}</div>`;
    }
    if (sec === "tell") {
      if (!tell) return null;
      return html`<label key="tell" class="check oo-card-tell" title=${tc("tellNote")}><input type="checkbox" checked=${tell.on} onChange=${(e) => tell.set(e.target.checked)} />
        <span>${tc("tell", m.name)}</span></label>`;
    }
    if (sec === "actions") {
      return html`${previewRow}<div key="actions" class="oo-card-actions">
        ${onReact ? html`<button type="button" class="btn btn-sm btn-ghost oo-card-pat" onClick=${() => onReact("pat")}>${tc("pat")}</button>
          <button type="button" class="btn btn-sm btn-ghost oo-card-feed" onClick=${() => onReact("feed")}>${tc("feed")}</button>` : null}
        ${onFind ? html`<button type="button" class="btn btn-sm btn-ghost oo-card-find" onClick=${onFind}>${tc("find")}</button>` : null}
        ${onChat ? html`<button type="button" class="btn btn-sm btn-primary oo-card-chat" title=${tc("chatWindow", m.name)} aria-label=${tc("chatWindow", m.name)} onClick=${onChat}>${tc("chat")}</button>` : null}
        ${actionButtons}
      </div>`;
    }
    return null;
  };

  return html`<div ref=${box} class=${classes} data-preset=${spec.preset} data-enter=${spec.motion ? spec.motion.enter : undefined} role="dialog" aria-modal="false" aria-label=${tc("card", m.name)}
      onPointerDown=${down} onPointerUp=${up} onPointerCancel=${() => { swipe.current = null; }}>
    ${spec.backdrop ? html`<canvas ref=${bgCanvas} class="oo-card-bg" aria-hidden="true"></canvas>` : null}
    <div class="oo-card-body">
      ${sheet ? html`<div class="oo-card-grip" aria-hidden="true"></div>` : null}
      ${m.modelSwitch ? html`<p class="oo-card-now model-switch" role="status"><strong>${m.modelSwitch}</strong></p>` : null}
      ${spec.layout.sections.map(renderSection)}
    </div>
  </div>`;
}
