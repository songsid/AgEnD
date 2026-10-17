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
  widgets?: Partial<Record<"chat_header" | "details", { spec: unknown; data: unknown; by: string }>>;
}
/** get_web_appearance's answer. Effects: none can be applied yet (they wait on the effects runtime). */
export function appearanceView(i: AppearanceInput): Record<string, unknown> {
  const card: Record<string, unknown> = {};
  for (const k of ["portrait", "banner"] as const) if (i.card[k]) card[k] = { id: i.card[k]!.id, by: i.card[k]!.by, url: i.card[k]!.src };
  for (const k of ["tagline", "bio"] as const) if (i.card[k]) card[k] = { text: i.card[k]!.text, by: i.card[k]!.by };
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
    effects: [],
    widgets: (["chat_header", "details"] as const).flatMap(slot => { const w = i.widgets?.[slot]; return w ? [{ slot, by: w.by, spec: w.spec, data: w.data }] : []; }),
    shown_when: "A viewer who turned off \"Show agents' themes, effects and widgets\", or a page opened with ?safe=1, sees the default look, the bot's face, no card colours and no widgets.",
    locked: i.locked,
    agent_edit: i.agentEdit,
    limits: i.limits,
  };
}

// ── The preview ── the page's numbers (app.css): a 720 px column, the M card (240 px portrait, banner half that), a
// 56 px chat header with a 32 px face, bubbles of the theme's radius and border.
const W = 720, PAD = 16, PORTRAIT_H = 240, BANNER_H = 120, HEADER_H = 56;
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
export function previewSvg(i: AppearanceInput, mode: ThemeMode, pics: PreviewPictures): string {
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
    if (i.card.banner) { out.push(img(pics.banner, 0, y, W, BANNER_H)); y += BANNER_H; }
    const top = y + PAD;
    let textX = PAD;
    if (i.card.portrait && pics.portrait) { out.push(img(pics.portrait, PAD, top, PORTRAIT_H * 0.75, PORTRAIT_H)); textX = PAD + PORTRAIT_H * 0.75 + PAD; }
    let ty = top + 18;
    if (i.card.tagline) { out.push(`<text x="${textX}" y="${ty}" font-family="${font}" font-size="15" font-weight="600" fill="${t.text}">${esc(i.card.tagline.text)}</text>`); ty += 24; }
    if (i.card.bio) for (const line of i.card.bio.text.split("\n")) { out.push(`<text x="${textX}" y="${ty}" font-family="${font}" font-size="13" fill="${t.text2}">${esc(line)}</text>`); ty += 18; }
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
