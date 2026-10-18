/**
 * #1629 r4 §1: the agent's read-only view of how it appears on the dashboard — `get_web_appearance` (what the page
 * draws now, resolved exactly as the status frame resolves it) and `preview_web_appearance` (an SVG per mode, built
 * from the page's own layout numbers). Pure: the fleet passes in what it already resolved; nothing here reads a file,
 * a path or another instance.
 *
 * The SVG names only this instance's pictures, as side files next to it (`avatar.png`, …: #1890 review — an SVG with a
 * picture inside outgrew what an agent's Read takes); text is XML-escaped; colours are checked again; fonts are generic
 * families. No browser, no live session, no other instance's content.
 */
import { autoIdentityColor, identityColorValue, resolveIdentityColor, resolvePlacements, type IdentityColorSource, type IdentityColorTiers, type Placement, type PlacementSource, type PlacementTiers } from "./web-identity-color.js";
import { effectivePalette, type Palette, type Theme, THEME_DEFAULTS, type ThemeMode } from "./web-theme.js";
import type { ResolvedCard } from "./web-card.js";

export type AvatarSource = "profile" | "theme" | "bot" | "emoji" | "initial";
/** The status frame's entry for one instance (getUiStatus): the fields the page draws a face and a ring from. */
export interface FrameEntry {
  name: string;
  display_name?: string;
  avatar?: { kind: string; src?: string; text?: string; alt?: string };
  accent?: string;
  theme_avatar?: { kind: string; src?: string };
  theme_accent?: string;
  /** #1958: the identity colour's tiers and its placements' (getUiStatus). */
  color?: IdentityColorTiers;
  color_show?: PlacementTiers;
}

/**
 * #1958: the identity colour drawn for this instance while agents' themes are shown, where it comes from, its value on
 * a light and a dark page, where it shows (and whose choice that is), and whether the host turned colours off — what
 * the agent needs to know: a person's choice wins over its own (theme.identity), field by field.
 */
export function resolvedIdentityColor(e: FrameEntry, host: { show?: unknown; off?: boolean } = {}): {
  color: string; source: IdentityColorSource; light: string; dark: string; show: Placement[]; show_source: PlacementSource; off: boolean;
} {
  const r = resolveIdentityColor(e.color ?? { auto: autoIdentityColor(e.name) }, { showThemes: true });
  const p = resolvePlacements(e.color_show ?? {}, { showThemes: true, hostDefault: host.show });
  return { color: r.color, source: r.source, light: identityColorValue(r.color, "light"), dark: identityColorValue(r.color, "dark"), show: p.show, show_source: p.source, off: host.off === true };
}

/** The face the page draws while agents' themes are shown (the default), and where it comes from. */
export function resolvedAvatar(e: FrameEntry): { source: AvatarSource; url?: string; text?: string } {
  if (e.theme_avatar?.kind === "image" && e.theme_avatar.src) return { source: "theme", url: e.theme_avatar.src };
  const a = e.avatar;
  if (a?.kind === "image" && a.src?.startsWith("/ui/img/avatar/")) return { source: "profile", url: a.src };
  if (a?.kind === "image" && a.src?.startsWith("/ui/img/bot/")) return { source: "bot", url: a.src };
  if (a?.kind === "emoji") return { source: "emoji", ...(a.src ? { url: a.src } : {}), ...(a.text ? { text: a.text } : {}) };
  return { source: "initial", text: a?.text ?? (e.display_name || e.name).slice(0, 1).toUpperCase() };
}
/** The ring the page draws round a picture face: the theme's colour, else an own bot's; none for an emoji or initial. */
export function resolvedRing(e: FrameEntry): { color: string; source: "theme" | "bot" } | null {
  const pictured = e.theme_avatar?.kind === "image" || e.avatar?.kind === "image";
  if (!pictured) return null;
  if (e.theme_accent) return { color: e.theme_accent, source: "theme" };
  if (e.accent) return { color: e.accent, source: "bot" };
  return null;
}

/** The effective look per mode: the palette over the token defaults, and the fixed choices. */
export function effectiveTheme(theme: Theme): Record<ThemeMode, Required<Palette> & { font: string; bubbleRadius: number; bubbleBorder: string }> {
  const one = (mode: ThemeMode) => ({ ...effectivePalette(theme, mode), font: theme.font ?? "inter", bubbleRadius: theme.bubble?.radius ?? 18, bubbleBorder: theme.bubble?.border ?? "none" });
  return { light: one("light"), dark: one("dark") };
}

export interface AppearanceInput {
  entry: FrameEntry;
  theme: Theme;
  card: ResolvedCard;
  locked: boolean;
  agentEdit: boolean;
  limits: Record<string, unknown>;
  /** #1958: the host's identity-colour settings (color.show / color.off). */
  colorPrefs?: { show?: unknown; off?: boolean };
  /** r4-4: its placed widgets, by slot. */
  effects?: Array<{ id: string; by: string; params?: Record<string, unknown>; playback: Record<string, unknown> }>;
  widgets?: Partial<Record<"chat_header" | "details", { spec: unknown; data: unknown; by: string }>>;
}
/** get_web_appearance: current placements and untrusted recent playback observations. */
export function appearanceView(i: AppearanceInput): Record<string, unknown> {
  const card: Record<string, unknown> = {};
  for (const k of ["portrait", "banner"] as const) if (i.card[k]) card[k] = { id: i.card[k]!.id, by: i.card[k]!.by, url: i.card[k]!.src };
  for (const k of ["tagline", "bio"] as const) if (i.card[k]) card[k] = { text: i.card[k]!.text, by: i.card[k]!.by };
  // #2086: which part of a cropped banner stays in view (0 top … 100 bottom; absent: the centre), and whose choice.
  if (i.card.banner_focus) card.banner_focus = { value: i.card.banner_focus.value, by: i.card.banner_focus.by };
  return {
    name: i.entry.name,
    display_name: i.entry.display_name ?? null,
    avatar: resolvedAvatar(i.entry),
    ring: resolvedRing(i.entry),
    identity_color: resolvedIdentityColor(i.entry, i.colorPrefs),
    card,
    theme: effectiveTheme(i.theme),
    working_label: i.theme.workingLabel ?? null,
    background: i.theme.background ? { image: i.theme.background.image, fit: i.theme.background.fit, opacity: i.theme.background.opacity } : null,
    effects: i.effects ?? [],
    widgets: (["chat_header", "details"] as const).flatMap(slot => { const w = i.widgets?.[slot]; return w ? [{ slot, by: w.by, spec: w.spec, data: w.data }] : []; }),
    shown_when: "A viewer who turned off \"Show agents' themes, effects and widgets\", or a page opened with ?safe=1, sees the default look, the bot's face, no card colours and no widgets.",
    locked: i.locked,
    agent_edit: i.agentEdit,
    limits: i.limits,
  };
}

// ── The preview ── the page's numbers (app.css): a 720 px column, the M card (240 px portrait; #2038: the banner 3:1
// of the width, held between 140 and 240 px, as `.id-card`'s --id-ar / --id-bmin / --id-bmax), a 56 px chat header
// with a 32 px face, bubbles of the theme's radius and border.
const W = 720, PAD = 16, PORTRAIT_H = 240, HEADER_H = 56;
const BIO_LINES = 12;
// #2050: the preview is a file that any viewer's fonts draw, so nothing can measure it: lines are laid out with an upper
// bound of each grapheme's advance (measured in Chrome, sans-serif / serif / monospace, 400 and 600 weight: CJK and
// fullwidth 1 em, Latin capitals up to 1 em, lowercase up to 0.89, other symbols up to 1.02), and the column is also
// clipped in the SVG so a wider substitute font cannot draw past it.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
const PICTO = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
function graphemeEm(g: string): number {
  const cps = Array.from(g);
  // An emoji sequence a font cannot join is drawn as its parts: each pictograph counts.
  const pictos = cps.filter(c => PICTO.test(c)).length;
  if (pictos) return 1.25 * pictos;
  if (cps.some(c => WIDE.test(c))) return 1;
  const c = cps[0];
  return c === " " ? 0.35 : /[0-9]/.test(c) ? 0.6 : /[a-z]/.test(c) ? 0.95 : /[A-Z]/.test(c) ? 1 : 1.05;
}
const charPx = (g: string, size: number) => graphemeEm(g) * size;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s: string) => Array.from(SEGMENTER.segment(s), x => x.segment);
/**
 * Wrap `text` (its own line breaks kept) to `maxPx` at `size`, at most `maxLines` lines; what does not fit ends the last
 * line with "…". Latin text breaks at a space when one is on the line; CJK breaks anywhere. Never splits a grapheme.
 */
export function fitLines(text: string, maxPx: number, size: number, maxLines: number): string[] {
  const out: string[] = [];
  const width = (gs: string[]) => gs.reduce((n, g) => n + charPx(g, size), 0);
  let truncated = false;
  paragraphs: for (const para of text.split("\n")) {
    if (out.length >= maxLines) { truncated = true; break; }
    let cur: string[] = [];
    for (const g of graphemes(para)) {
      if (cur.length && width(cur) + charPx(g, size) > maxPx) {
        if (out.length >= maxLines - 1) { out.push(cur.join("")); truncated = true; break paragraphs; }
        // Latin breaks after the last space on the line; CJK (or a line with no space) breaks here.
        const space = WIDE.test(g) ? -1 : cur.lastIndexOf(" ");
        out.push((space > 0 ? cur.slice(0, space) : cur).join("").trimEnd());
        cur = space > 0 ? cur.slice(space + 1) : [];
      }
      cur.push(g);
    }
    out.push(cur.join(""));
  }
  if (truncated) {
    const last = graphemes(out[out.length - 1]);
    while (last.length && width(last) + charPx("…", size) > maxPx) last.pop();
    out[out.length - 1] = `${last.join("").trimEnd()}…`;
  }
  return out;
}
export const PREVIEW_BANNER = { aspect: 3, min: 140, max: 240 } as const;
const BANNER_H = Math.min(PREVIEW_BANNER.max, Math.max(PREVIEW_BANNER.min, Math.round(W / PREVIEW_BANNER.aspect)));
/**
 * #2086: the banner as the page crops it at its focus (object-fit: cover; object-position: 50% <focus>%): a nested SVG
 * whose viewBox is exactly the part shown. Without the picture's size, the nearest of top / middle / bottom.
 */
function bannerAt(name: string | null, y: number, focus: number, size: { width: number; height: number } | null): string {
  if (!name || !PREVIEW_FILE.test(name) || name.endsWith(".svg")) return "";
  if (!size || size.width < 1 || size.height < 1) {
    const yAlign = focus < 34 ? "YMin" : focus > 66 ? "YMax" : "YMid";
    return `<image href="${name}" x="0" y="${y}" width="${W}" height="${BANNER_H}" preserveAspectRatio="xMid${yAlign} slice"/>`;
  }
  const s = Math.max(W / size.width, BANNER_H / size.height);
  const vw = W / s, vh = BANNER_H / s;
  const r = (n: number) => Math.round(n * 100) / 100;
  return `<svg x="0" y="${y}" width="${W}" height="${BANNER_H}" viewBox="${r((size.width - vw) / 2)} ${r((size.height - vh) * focus / 100)} ${r(vw)} ${r(vh)}" preserveAspectRatio="none"><image href="${name}" width="${size.width}" height="${size.height}"/></svg>`;
}
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const FONT: Record<string, string> = { inter: "sans-serif", system: "sans-serif", mono: "monospace" };

export const PICTURE_ROLES = ["avatar", "portrait", "banner", "background"] as const;
export type PictureRole = typeof PICTURE_ROLES[number];
/** This instance's pictures by role, as the side files' names (null: none). */
export type PreviewPictures = Record<PictureRole, string | null>;
const PICTURE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
/** A side file's name for a picture of this role and type, or null for a type no page shows. */
export function pictureFileName(role: PictureRole, mime: string): string | null {
  return Object.hasOwn(PICTURE_EXT, mime) ? `${role}.${PICTURE_EXT[mime]}` : null;
}
/** Every name a preview writes: an SVG per mode, and the pictures it names. */
export const PREVIEW_FILE = /^(?:(?:light|dark)\.svg|(?:avatar|portrait|banner|background)\.(?:png|jpg|webp|gif))$/;
const COLOR = /^#[0-9a-f]{6}$/;

/** One mode's SVG. Every picture is one of `pics` (this instance's), inline; nothing else is referenced. */
export function previewSvg(i: AppearanceInput, mode: ThemeMode, pics: PreviewPictures, bannerSize?: { width: number; height: number } | null): string {
  const raw = effectiveTheme(i.theme)[mode];
  // Colours go into attributes: each is checked again here (a file someone may open in a browser), else the default's.
  const t = { ...raw };
  for (const k of ["bg", "surface", "text", "text2", "accent", "userBubble", "agentBubble"] as const) if (!COLOR.test(t[k])) t[k] = THEME_DEFAULTS[mode][k];
  const font = FONT[t.font] ?? "sans-serif";
  const img = (name: string | null, x: number, y: number, w: number, h: number, extra = "") =>
    name && PREVIEW_FILE.test(name) && !name.endsWith(".svg") ? `<image href="${name}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"${extra}/>` : "";
  const out: string[] = [];
  let y = 0;
  // The card, as Details draws it at M.
  const hasCard = Object.keys(i.card).length > 0;
  if (hasCard) {
    if (i.card.banner) { out.push(bannerAt(pics.banner, y, i.card.banner_focus?.value ?? 50, bannerSize ?? null)); y += BANNER_H; }
    const top = y + PAD;
    let textX = PAD;
    if (i.card.portrait && pics.portrait) { out.push(img(pics.portrait, PAD, top, PORTRAIT_H * 0.75, PORTRAIT_H)); textX = PAD + PORTRAIT_H * 0.75 + PAD; }
    let ty = top + 18;
    // SVG text neither wraps nor clips: lay the card's text out to its column, as Details does (tagline: two lines).
    const column = W - textX - PAD, textTop = ty - 18;
    out.push(`<clipPath id="card-text"><rect x="${textX}" y="${textTop}" width="${column}" height="${(2 * 22 + 2 + BIO_LINES * 18) + 8}"/></clipPath><g clip-path="url(#card-text)">`);
    if (i.card.tagline) for (const line of fitLines(i.card.tagline.text, column, 15, 2)) { out.push(`<text x="${textX}" y="${ty}" font-family="${font}" font-size="15" font-weight="600" fill="${t.text}">${esc(line)}</text>`); ty += 22; }
    if (i.card.tagline) ty += 2;
    if (i.card.bio) for (const line of fitLines(i.card.bio.text, column, 13, BIO_LINES)) { out.push(`<text x="${textX}" y="${ty}" font-family="${font}" font-size="13" fill="${t.text2}">${esc(line)}</text>`); ty += 18; }
    out.push("</g>");
    y = Math.max(top + (i.card.portrait && pics.portrait ? PORTRAIT_H : 0), ty) + PAD;
  }
  // The chat header: the face (and its ring) and the name.
  const hy = y;
  out.push(`<rect x="0" y="${hy}" width="${W}" height="${HEADER_H}" fill="${t.surface}"/>`);
  const cx = PAD + 16, cy = hy + HEADER_H / 2;
  const ring = resolvedRing(i.entry), face = resolvedAvatar(i.entry);
  if (ring && COLOR.test(ring.color)) out.push(`<circle cx="${cx}" cy="${cy}" r="18" fill="none" stroke="${ring.color}" stroke-width="2"/>`);
  out.push(`<clipPath id="face"><circle cx="${cx}" cy="${cy}" r="16"/></clipPath>`);
  if (pics.avatar && (face.source === "theme" || face.source === "profile" || face.source === "bot")) out.push(img(pics.avatar, cx - 16, cy - 16, 32, 32, ` clip-path="url(#face)"`));
  else {
    out.push(`<circle cx="${cx}" cy="${cy}" r="16" fill="${t.surface}" stroke="${t.text2}" stroke-width="1"/>`);
    out.push(`<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-family="${font}" font-size="14" fill="${t.text}">${esc(face.text ?? "")}</text>`);
  }
  out.push(`<text x="${cx + 28}" y="${cy + 5}" font-family="${font}" font-size="15" font-weight="600" fill="${t.text}">${esc(i.entry.display_name || i.entry.name)}</text>`);
  y = hy + HEADER_H;
  // The thread: the theme's background picture under a pair of bubbles, then the working label.
  const threadTop = y, threadH = 200;
  out.push(`<rect x="0" y="${threadTop}" width="${W}" height="${threadH}" fill="${t.bg}"/>`);
  if (i.theme.background && pics.background) out.push(img(pics.background, 0, threadTop, W, threadH, ` opacity="${i.theme.background.opacity}"`));
  const stroke = t.bubbleBorder === "thin" ? ` stroke="${t.text2}" stroke-width="1"` : t.bubbleBorder === "accent" ? ` stroke="${t.accent}" stroke-width="1.5"` : "";
  out.push(`<rect x="${W - PAD - 300}" y="${threadTop + PAD}" width="300" height="44" rx="${t.bubbleRadius}" fill="${t.userBubble}"${stroke}/>`);
  out.push(`<text x="${W - PAD - 286}" y="${threadTop + PAD + 27}" font-family="${font}" font-size="14" fill="${t.text}">A message from a person</text>`);
  out.push(`<rect x="${PAD}" y="${threadTop + PAD + 60}" width="380" height="64" rx="${t.bubbleRadius}" fill="${t.agentBubble}"${stroke}/>`);
  out.push(`<text x="${PAD + 14}" y="${threadTop + PAD + 88}" font-family="${font}" font-size="14" fill="${t.text}">Your reply, in your colours.</text>`);
  out.push(`<text x="${PAD + 14}" y="${threadTop + PAD + 110}" font-family="${font}" font-size="13" fill="${t.accent}">A link in the accent colour</text>`);
  out.push(`<circle cx="${PAD + 6}" cy="${threadTop + threadH - 24}" r="4" fill="${t.accent}"/>`);
  out.push(`<text x="${PAD + 18}" y="${threadTop + threadH - 19}" font-family="${font}" font-size="13" fill="${t.text2}">${esc(i.theme.workingLabel ?? "Working")}…</text>`);
  y = threadTop + threadH;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}">`
    + `<title>${esc(`${i.entry.display_name || i.entry.name}: ${mode} mode`)}</title><rect width="${W}" height="${y}" fill="${t.bg}"/>${out.join("")}</svg>\n`;
}
