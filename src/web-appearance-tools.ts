/**
 * #1629 r4 §1: get_web_appearance and preview_web_appearance, on the fleet's side. Both read only the caller's own
 * record (no target), through resolvers the fleet passes in — the status frame's entry, the theme, the card, this
 * instance's pictures. The preview's files are bytes for the daemon or the CLI to write in the agent's working
 * directory (the fleet never names a path); a preview larger than one message is handed over in parts.
 */
import { createHash, randomBytes } from "node:crypto";
import { appearanceView, type AppearanceInput, type FrameEntry, PICTURE_ROLES, pictureFileName, previewSvg, type PictureRole, type PreviewPictures } from "./web-appearance-view.js";
import { ASSET_PART_BYTES } from "./web-asset-parts.js";
import { imageSize, sniffMedia } from "./web-image-meta.js";
import type { ResolvedCard } from "./web-card.js";
import type { Theme, ThemeMode } from "./web-theme.js";

type Picture = { bytes: Buffer; mime: string } | null;
export interface AppearanceDeps {
  canvasWorkerEnabled?(): boolean;
  frame(name: string): FrameEntry;
  theme(name: string): { theme: Theme; locked: boolean; widgets?: AppearanceInput["widgets"]; ambient?: AppearanceInput["ambient"]; glyphAsset?: (id: string) => Picture };
  card(name: string): ResolvedCard;
  /** The resolved card's picture for a slot (the person's, else the agent's). */
  cardPicture(name: string, slot: "portrait" | "banner"): Picture;
  themeAsset(name: string, id: string): Picture;
  profileAvatar(name: string): Picture;
  botAvatar(name: string, key: string): Picture;
  /** get_web_theme's agent_edit and limits (one source for both tools). */
  themeAnswer(name: string): { agent_edit?: unknown; limits?: unknown };
  /** #1958: the host's identity-colour settings (web prefs color.show / color.off), for the colour view. */
  effects?(name: string): AppearanceInput["effects"];
  colorPrefs?(): { show?: unknown; off?: boolean };
  clock?: () => number;
}

/** A preview whose files (base64) fit one message is sent whole; a larger one is fetched in parts. */
export const PREVIEW_INLINE_BYTES = 600 * 1024;
export const PREVIEW_IDLE_MS = 60_000;
/** A glyph picture's side file type (the glyph slot's kinds). */
const GLYPH_EXT: Readonly<Record<string, string>> = { "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MODES: readonly ThemeMode[] = ["light", "dark"];
type Built = { id: string; files: Array<{ name: string; data: Buffer; sha256: string }>; last: number };

export class AppearanceTools {
  private readonly previews = new Map<string, Built>();
  constructor(private readonly deps: AppearanceDeps) {}
  private now(): number { return (this.deps.clock ?? (() => performance.now()))(); }

  private input(name: string): AppearanceInput {
    const entry = this.deps.frame(name);
    const t = this.deps.theme(name);
    const answer = this.deps.themeAnswer(name);
    return { entry, theme: t.theme, card: this.deps.card(name), locked: t.locked, agentEdit: answer.agent_edit !== false, limits: (answer.limits ?? {}) as Record<string, unknown>, widgets: t.widgets, ambient: t.ambient,
      effects: this.deps.canvasWorkerEnabled?.() === true ? this.deps.effects?.(name) ?? [] : [], colorPrefs: this.deps.colorPrefs?.() ?? {} };
  }
  /** The face drawn, as bytes of this instance's: the theme's picture, the person's upload, or its own bot's. */
  private avatar(name: string, input: AppearanceInput): Picture {
    const e = input.entry;
    if (e.theme_avatar?.kind === "image" && input.theme.avatar) return this.deps.themeAsset(name, input.theme.avatar);
    const src = e.avatar?.kind === "image" ? e.avatar.src ?? "" : "";
    if (src.startsWith("/ui/img/avatar/")) return this.deps.profileAvatar(name);
    const bot = /^\/ui\/img\/bot\/([^/?#]+)/.exec(src);
    if (bot) { try { return this.deps.botAvatar(name, decodeURIComponent(bot[1]!)); } catch { return null; } }
    return null;
  }

  handle(name: string, tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const now = this.now();
    for (const [k, b] of this.previews) if (now - b.last > PREVIEW_IDLE_MS) this.previews.delete(k);   // nothing stale stays
    if (tool === "get_web_appearance") {
      const view = appearanceView(this.input(name));
      if (this.deps.canvasWorkerEnabled?.() !== true) delete view.effects;
      return view;
    }
    if (tool !== "preview_web_appearance") return { error: "unknown_tool" };
    if (args.part !== undefined) return this.part(name, args.part, now);
    const modes = args.modes === undefined ? MODES : args.modes;
    if (!Array.isArray(modes) || !modes.length || modes.length > 2 || !modes.every(m => m === "light" || m === "dark") || new Set(modes).size !== modes.length) {
      return { error: "modes", message: "modes: light and/or dark" };
    }
    const input = this.input(name);
    const bytes: Record<PictureRole, Picture> = {
      avatar: this.avatar(name, input),
      portrait: input.card.portrait ? this.deps.cardPicture(name, "portrait") : null,
      banner: input.card.banner ? this.deps.cardPicture(name, "banner") : null,
      background: input.theme.background ? this.deps.themeAsset(name, input.theme.background.image) : null,
    };
    // Each picture is its own file next to the SVGs (#1890 review: inside, they outgrew what an agent's Read takes).
    const names = {} as PreviewPictures;
    const files: Built["files"] = [];
    const add = (fileName: string, data: Buffer) => files.push({ name: fileName, data, sha256: createHash("sha256").update(data).digest("hex") });
    for (const role of PICTURE_ROLES) {
      const p = bytes[role], fileName = p ? pictureFileName(role, p.mime) : null;
      names[role] = fileName;
      if (p && fileName) add(fileName, p.bytes);
    }
    // #2086: the banner's own size, so the preview crops it at its focus exactly as the page does.
    const bannerKind = bytes.banner ? sniffMedia(bytes.banner.bytes) : null;
    const bannerSize = bytes.banner && bannerKind ? imageSize(bytes.banner.bytes, bannerKind) : null;
    // #2117: the looping ambient's glyph pictures, glyph1… next to the SVGs.
    const glyphPics: Record<string, string> = {};
    const glyphOf = this.deps.theme(name).glyphAsset;
    for (const g of input.ambient?.loop?.spec.glyphs ?? []) {
      if (typeof g === "string" || glyphPics[g.asset] || !glyphOf) continue;
      const p = glyphOf(g.asset), ext = p ? GLYPH_EXT[p.mime] : undefined;
      if (!p || !ext) continue;
      const fileName = `glyph${Object.keys(glyphPics).length + 1}.${ext}`;
      glyphPics[g.asset] = fileName;
      add(fileName, p.bytes);
    }
    for (const mode of modes as ThemeMode[]) add(`${mode}.svg`, Buffer.from(previewSvg(input, mode, names, bannerSize, glyphPics), "utf8"));
    const total = files.reduce((n, f) => n + f.data.length, 0);
    if (total <= PREVIEW_INLINE_BYTES) return { files: files.map(f => ({ name: f.name, data_b64: f.data.toString("base64") })) };
    const built: Built = { id: randomBytes(8).toString("hex"), files, last: now };
    this.previews.set(name, built);                                    // one per instance: a new preview replaces it
    return { preview: built.id, files: files.map(f => ({ name: f.name, bytes: f.data.length, sha256: f.sha256, parts: Math.ceil(f.data.length / ASSET_PART_BYTES) })) };
  }
  /** One part of the caller's own preview in progress (its id, a file it holds, an index in range, not gone stale). */
  private part(name: string, raw: unknown, now: number): Record<string, unknown> {
    const p = raw as { preview?: unknown; name?: unknown; index?: unknown } | null;
    const b = this.previews.get(name);
    if (!p || typeof p !== "object" || !b || p.preview !== b.id) return { error: "preview", message: "No such preview: ask for it again." };
    const f = b.files.find(x => x.name === p.name);
    const count = f ? Math.ceil(f.data.length / ASSET_PART_BYTES) : 0;
    if (!f || !Number.isSafeInteger(p.index) || (p.index as number) < 0 || (p.index as number) >= count) return { error: "part", message: "No such part." };
    b.last = now;                                                      // a preview being fetched stays while it is
    const i = p.index as number;
    return { data_b64: f.data.subarray(i * ASSET_PART_BYTES, (i + 1) * ASSET_PART_BYTES).toString("base64") };
  }
  /** An instance was removed. */
  forget(name: string): void { this.previews.delete(name); }
}
