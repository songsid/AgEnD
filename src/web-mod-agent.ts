/**
 * #1629 r4 §4 (r4-5b): an agent and mods — export_web_mod and propose_web_mod. Neither takes a target: the caller is
 * the instance its IPC connection or agent token belongs to.
 *
 * - export_web_mod { name, version, title? }: its own look as a bundle — its theme with its pictures, its own card
 *   text (the agent's fields, never a person's), and the widgets it placed. Never custom CSS and never the sidebar: no
 *   agent path reaches a person's. The fleet builds the bytes; the daemon (or agend-agent) writes them to
 *   `.agend/mods/<name>-<version>.agendmod.json` in the agent's working directory — whole, or fetched in parts.
 * - propose_web_mod { file }: a bundle from its working directory (read on its side; sent in parts), checked whole and
 *   kept as a proposal a person reviews in Settings → Appearance → Mods. Anything carrying custom CSS is refused
 *   (owner_css_not_from_agent): provenance is the path the bytes came in by, never what the file says. It counts as an
 *   upload, and the fleet switch and a person's lock refuse it. Agents never import.
 */
import { createHash, randomBytes } from "node:crypto";
import { ASSET_PART_BYTES, MOD_UPLOAD_MAX_BYTES } from "./web-asset-parts.js";
import { agentAppearanceEditAllowed, type AppearanceLimiter } from "./web-appearance-policy.js";
import { checkModBundle, type ModContext } from "./web-mod-bundle.js";
import { buildModBundle, type ModExportParts } from "./web-mod-export.js";
import type { ModStore } from "./web-mod-store.js";
import type { ThemeStore } from "./web-theme-store.js";
import { AGENT_WIDGET_SLOTS } from "./web-widget.js";
import { canonicalText } from "./web-theme.js";

/** An exported mod that fits one message is sent whole; a larger one is fetched in parts (as a preview is). */
export const MOD_INLINE_BYTES = 600 * 1024;
export const MOD_IDLE_MS = 60_000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

type Answer = Record<string, unknown>;
interface Built { id: string; name: string; data: Buffer; sha256: string; last: number }
interface Upload { id: string; count: number; next: number; bytes: number; sha256: string; parts: Buffer[]; received: number; last: number }

export interface AgentModsDeps {
  themes: ThemeStore;
  mods: ModStore;
  limiter: AppearanceLimiter;
  webConfig: () => { themes?: { agent_edit?: boolean } } | undefined | null;
  context: () => ModContext;
  /**
   * r4-5c: an effect as this agent may read it (its own, or one a person shared) — never a person's private effect,
   * even one placed on its instance: that is not the agent's to carry away. Null: not readable by it (or no library).
   */
  readOwnEffect?: (instance: string, id: string) => { name: string; files: ReadonlyMap<string, Uint8Array> } | null;
  /** A muted status line in the agent's own web chat (#1672's notice lane). */
  notice: (instance: string, text: string) => void;
  changed: () => void;
  clock?: () => number;
}

export class AgentMods {
  private readonly built = new Map<string, Built>();
  private readonly uploads = new Map<string, Upload>();
  constructor(private readonly deps: AgentModsDeps) {}
  private now(): number { return (this.deps.clock ?? (() => performance.now()))(); }

  handle(instance: string, tool: string, args: Answer): Answer {
    const now = this.now();
    for (const [k, b] of this.built) if (now - b.last > MOD_IDLE_MS) this.built.delete(k);
    for (const [k, u] of this.uploads) if (now - u.last > MOD_IDLE_MS && k !== instance) this.uploads.delete(k);
    if (tool === "export_web_mod") return args.part !== undefined ? this.exportPart(instance, args.part, now) : this.exportMod(instance, args, now);
    if (tool === "propose_web_mod") return this.propose(instance, args, now);
    return { error: "unknown_tool" };
  }

  /** export_web_mod: the caller's own look, as a bundle file. */
  private exportMod(instance: string, args: Answer, now: number): Answer {
    if (typeof args.name !== "string" || !SLUG.test(args.name)) return { error: "name", message: "name: a-z, 0-9 and - (1..64)" };
    if (typeof args.version !== "string" || !SEMVER.test(args.version)) return { error: "version", message: "version: MAJOR.MINOR.PATCH" };
    // The importer's own rule (#1897 review): what is exported always imports.
    const title = canonicalText(args.title === undefined ? args.name : args.title, 1, 60);
    if (title === null) return { error: "title", message: "title: 1..60 characters on one line" };
    const rec = this.deps.themes.get(instance);
    const parts: ModExportParts = {};
    const { card, ...look } = rec.theme;
    let omitted = 0;
    if (Object.keys(look).length > 1 || rec.placements.effects.length) {
      const effects = rec.placements.effects.flatMap(p => { const e = this.deps.readOwnEffect?.(instance, p.id); if (!e) { omitted++; return []; } return [{ name: e.name, files: e.files, params: p.params ?? {} }]; });
      // A default look whose placed effects are all someone else's has nothing of its own to carry (#1910 review).
      if (Object.keys(look).length > 1 || effects.length) parts.theme = { theme: { ...look, v: 1 }, picture: id => { const a = rec.assets.find(x => x.id === id); const b = this.deps.themes.asset(instance, id); return a && b ? { bytes: b.bytes, kind: a.kind } : null; }, effects };
    }
    // Its own card text: the agent's fields (a person's card fields are theirs, kept elsewhere, and never exported here).
    if (card?.tagline || card?.bio) parts.identity = { ...(card.tagline ? { tagline: card.tagline } : {}), ...(card.bio ? { bio: card.bio } : {}) };
    for (const slot of AGENT_WIDGET_SLOTS) {
      const w = rec.placements.widgets[slot];
      if (w && w.by === "agent") (parts.widgets ??= {})[slot] = { spec: w.spec, data: w.data };
    }
    const built = buildModBundle({ name: args.name, version: args.version, title }, parts);
    if (!built.ok) return { error: built.error, message: built.error === "nothing_to_export" ? "You have no theme, card text or widgets of your own to export." : "A picture your theme names is missing.", ...(omitted ? { effects_omitted: omitted } : {}) };
    const data = Buffer.from(built.text, "utf8");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const omittedNote = omitted ? { effects_omitted: omitted } : {};
    if (data.length <= MOD_INLINE_BYTES) return { files: [{ name: built.filename, data_b64: data.toString("base64") }], ...omittedNote };
    const b: Built = { id: randomBytes(8).toString("hex"), name: built.filename, data, sha256, last: now };
    this.built.set(instance, b);                                     // one per instance: a new export replaces it
    return { transfer: b.id, files: [{ name: b.name, bytes: data.length, sha256, parts: Math.ceil(data.length / ASSET_PART_BYTES) }], ...omittedNote };
  }
  private exportPart(instance: string, raw: unknown, now: number): Answer {
    const p = raw as { transfer?: unknown; name?: unknown; index?: unknown } | null;
    const b = this.built.get(instance);
    if (!p || typeof p !== "object" || !b || p.transfer !== b.id || p.name !== b.name) return { error: "export", message: "No such export: ask for it again." };
    const count = Math.ceil(b.data.length / ASSET_PART_BYTES);
    if (!Number.isSafeInteger(p.index) || (p.index as number) < 0 || (p.index as number) >= count) return { error: "part", message: "No such part." };
    b.last = now;
    const i = p.index as number;
    return { data_b64: b.data.subarray(i * ASSET_PART_BYTES, (i + 1) * ASSET_PART_BYTES).toString("base64") };
  }

  /** Why the caller may not propose now, or null: the fleet switch, a person's lock, the upload limit. */
  private refusal(instance: string): Answer | null {
    if (!agentAppearanceEditAllowed(this.deps.webConfig())) return { error: "theme_editing_off", message: "Agent theme and effect changes are turned off for this fleet (web.themes.agent_edit: false)." };
    if (this.deps.themes.get(instance).locked) return { error: "locked", message: "Theme and effects are locked by a person." };
    const limit = this.deps.limiter.check(instance, ["upload"]);
    return limit.ok ? null : { ...limit, message: `Too many uploads; try again in ${limit.retry_after_s} s.` };
  }

  /** propose_web_mod: the bytes the daemon or agend-agent read on the agent's side — whole, or in parts. */
  private propose(instance: string, args: Answer, now: number): Answer {
    if (typeof args.data_b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.data_b64)) return { error: "data", message: "The file's bytes are missing." };
    const fail = (error: string, message: string): Answer => { this.uploads.delete(instance); return { error, message }; };
    if (args.part === undefined) {
      const refused = this.refusal(instance);
      if (refused) return refused;
      const bytes = Buffer.from(args.data_b64, "base64");
      if (bytes.length > MOD_UPLOAD_MAX_BYTES) return { error: "mod_too_large", message: "at most 8 MiB" };
      return this.finish(instance, bytes);
    }
    const p = args.part as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || Array.isArray(p)) return fail("part", "part: { index, count, bytes, sha256, upload? }");
    const { index, count, bytes, sha256 } = p;
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(bytes) || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return fail("part", "part: { index, count, bytes, sha256, upload? }");
    const chunk = Buffer.from(args.data_b64, "base64");
    if (chunk.length < 1 || chunk.length > ASSET_PART_BYTES) return fail("part", `each part is 1..${ASSET_PART_BYTES} bytes`);
    if (index === 0) {
      const refused = this.refusal(instance);
      if (refused) { this.uploads.delete(instance); return refused; }
      if ((bytes as number) < 1 || (bytes as number) > MOD_UPLOAD_MAX_BYTES) return fail("mod_too_large", "at most 8 MiB");
      if ((count as number) !== Math.ceil((bytes as number) / ASSET_PART_BYTES)) return fail("part", "count does not match bytes");
      this.uploads.set(instance, { id: randomBytes(8).toString("hex"), count: count as number, next: 0, bytes: bytes as number, sha256, parts: [], received: 0, last: now });
    }
    const up = this.uploads.get(instance);
    if (!up || (index !== 0 && p.upload !== up.id)) return fail("upload", "No such upload in progress: start again from part 0.");
    if (now - up.last > MOD_IDLE_MS) return fail("upload", "The upload waited too long between parts: start again from part 0.");
    if (index !== up.next || count !== up.count || bytes !== up.bytes || sha256 !== up.sha256) return fail("part", `expected part ${up.next} of the same upload`);
    if (up.received + chunk.length > up.bytes) return fail("part", "more bytes than declared");
    up.parts.push(chunk); up.received += chunk.length; up.next += 1; up.last = now;
    if (up.next < up.count) return { upload: up.id, received: up.received };
    this.uploads.delete(instance);
    const all = Buffer.concat(up.parts);
    if (all.length !== up.bytes || createHash("sha256").update(all).digest("hex") !== up.sha256) return { error: "part", message: "The parts do not add up to the declared file." };
    const refused = this.refusal(instance);
    if (refused) return refused;
    return this.finish(instance, all);
  }
  private finish(instance: string, bytes: Buffer): Answer {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { error: "mod_invalid", errors: [{ path: "", problem: "not UTF-8" }] }; }
    // By the path it came in by: an agent's file never brings custom CSS, whatever else it says (checked first).
    let carriesCss = false;
    try { const doc = JSON.parse(text) as { manifest?: { contents?: Record<string, unknown> } }; carriesCss = !!doc?.manifest?.contents && Object.hasOwn(doc.manifest.contents, "ownerCss"); } catch { /* the check below says why */ }
    if (carriesCss) return { error: "owner_css_not_from_agent", message: "A mod an agent proposes can't carry custom CSS: that is a person's own, set only by them." };
    const checked = checkModBundle(text, this.deps.context());
    if (!checked.ok) return { error: "mod_invalid", errors: checked.problems };
    const w = this.deps.mods.propose(instance, text, checked.mod);
    if (!w.ok) return { error: w.error, ...(w.detail ? { detail: w.detail } : {}) };
    this.deps.limiter.record(instance, ["upload"]);
    const m = checked.mod.manifest;
    this.deps.notice(instance, `Proposed a mod: ${m.title} (${m.name} ${m.version}). A person can review it in Settings → Appearance → Mods.`);
    this.deps.changed();
    return { proposed: { id: checked.mod.id, name: m.name, version: m.version, title: m.title, bytes: checked.mod.bytes }, message: "A person reviews it in Settings → Appearance → Mods; nothing changes until they install it." };
  }

  /** An instance was removed. */
  forget(instance: string): void { this.built.delete(instance); this.uploads.delete(instance); }
}
