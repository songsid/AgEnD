/**
 * #1629 (first design §4, §6; r2 (a)–(c); r4-4): the agent's own theme tools — get_web_theme, set_web_theme,
 * set_web_theme_asset, reset_web_theme, set_web_widget, remove_web_widget, set_web_ambient, clear_web_ambient (#2117) — and a person's reset, lock, widget removal and ambient. None takes a target: the caller is the
 * instance its IPC connection or agent token belongs to, and only that instance's record is ever read or written.
 *
 * Every agent write: the fleet-wide switch (web.themes.agent_edit), then the person's lock, then the shared limiter's
 * check, then validation and the write, then — only once it is on disk — the limiter's record. A refused, invalid or
 * failed call costs nothing. A person's reset and lock are never limited.
 */
import { type AppearanceBucket, AppearanceLimiter, agentAppearanceEditAllowed } from "./web-appearance-policy.js";
import { applyThemePatch, type Theme, THEME_DEFAULTS } from "./web-theme.js";
import { createHash, randomBytes } from "node:crypto";
import { slotLimit, THEME_ASSET_SLOTS, type ThemeAssetSlot, type ThemeStore } from "./web-theme-store.js";
import { ASSET_PART_BYTES, ASSET_UPLOAD_MAX_BYTES } from "./web-asset-parts.js";
import { AMBIENT_KINDS, type AmbientKind, ambientKind, ambientProblems, checkAmbient } from "./web-ambient.js";
import { AGENT_WIDGET_SLOTS, type AgentWidgetSlot, carryWidgetData, checkWidgetData, checkWidgetSpec, mergeWidgetData, WIDGET_SLOTS } from "./web-widget.js";

/** An upload in parts with no new part for this long is dropped (monotonic clock). */
export const ASSET_UPLOAD_IDLE_MS = 60_000;
interface Upload { id: string; slot: ThemeAssetSlot; count: number; next: number; bytes: number; sha256: string; parts: Buffer[]; received: number; last: number }

export type ToolAnswer = Record<string, unknown>;
type WebConfigView = { themes?: { agent_edit?: boolean } } | undefined | null;

export class WebAppearance {
  readonly limiter: AppearanceLimiter;
  /** At most one upload in parts per instance (a new part 0 replaces it). */
  private readonly uploads = new Map<string, Upload>();
  constructor(
    private readonly store: ThemeStore,
    private readonly webConfig: () => WebConfigView,
    private readonly changed: () => void = () => {},
    limiter?: AppearanceLimiter,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.limiter = limiter ?? new AppearanceLimiter();
  }

  /** Why an agent may not write now, or null. */
  private refusal(instance: string, buckets: readonly AppearanceBucket[]): ToolAnswer | null {
    if (!agentAppearanceEditAllowed(this.webConfig())) return { error: "theme_editing_off", message: "Agent theme and effect changes are turned off for this fleet (web.themes.agent_edit: false)." };
    if (!this.store.readable()) return { error: "themes_unreadable", message: "The fleet's theme file cannot be read; nothing can be changed until it is fixed." };
    if (this.store.get(instance).locked) return { error: "locked", message: "Theme and effects are locked by a person." };
    const limit = this.limiter.check(instance, buckets);
    return limit.ok ? null : { ...limit, message: `Too many changes; try again in ${limit.retry_after_s} s.` };
  }

  /** The effect tools share this exact switch/lock/limiter policy; no parallel gate or bucket. */
  authorizeEffect(instance: string, buckets: readonly AppearanceBucket[]): ToolAnswer | null { return this.refusal(instance, buckets); }

  /** get_web_theme: the caller's theme and everything an agent needs to write a good one. */
  getTheme(instance: string): ToolAnswer {
    const r = this.store.get(instance);
    return {
      effects: r.placements.effects,
      theme: r.theme, by: r.by, locked: r.locked, agent_edit: agentAppearanceEditAllowed(this.webConfig()),
      defaults: THEME_DEFAULTS,
      assets: r.assets.map(a => ({ id: a.id, slot: a.slot, bytes: a.bytes })),
      widgets: Object.fromEntries(AGENT_WIDGET_SLOTS.flatMap(slot => { const w = r.placements.widgets[slot]; return w ? [[slot, { spec: w.spec, data: w.data, by: w.by }]] : []; })),
      ambient: Object.fromEntries(AMBIENT_KINDS.flatMap(k => { const a = r.placements.ambient[k]; return a ? [[k, { spec: a.spec, by: a.by }]] : []; })),
      limits: { ...this.limiter.remaining(instance), ...this.assetLimits() },
    };
  }

  /** The upload limits in force now (r4.1 Q3 (b): the card's come from web.appearance), so an agent can size its files. */
  private assetLimits(): { asset_slots: Record<string, { max_width: number; max_height: number; max_bytes: number }>; asset_quota: { files: number; bytes: number } } {
    const limits = this.store.limits();
    const asset_slots: Record<string, { max_width: number; max_height: number; max_bytes: number }> = {};
    for (const slot of THEME_ASSET_SLOTS) { const l = slotLimit(slot, limits); asset_slots[slot] = { max_width: l.maxWidth, max_height: l.maxHeight, max_bytes: l.maxBytes }; }
    return { asset_slots, asset_quota: { ...limits.quota } };
  }

  /** set_web_theme { set?, clear? }: all or nothing. `{}` is a no-op (and counts as nothing). */
  setTheme(instance: string, patch: unknown): ToolAnswer {
    const isNoop = !!patch && typeof patch === "object" && !Array.isArray(patch) && Object.keys(patch).length === 0;
    if (isNoop) return { theme: this.store.get(instance).theme, rev: this.store.rev() };
    const refused = this.refusal(instance, ["change"]);
    if (refused) return refused;
    const current = this.store.get(instance);
    const next = applyThemePatch(current.theme, patch, { assets: new Set(current.assets.map(a => a.id)), slotOf: id => current.assets.find(a => a.id === id)?.slot });
    if (!next.ok) return { errors: next.errors };
    const w = this.store.setTheme(instance, next.theme, "agent");
    if (!w.ok) return { error: w.error, ...(w.detail ? { detail: w.detail } : {}) };
    this.limiter.record(instance, ["change"]);
    this.changed();
    return { theme: w.theme, rev: w.rev };
  }

  /**
   * set_web_theme_asset { slot, data_b64, part? }: the bytes the daemon or the CLI read on the agent's side — whole, or
   * in parts (web-asset-parts.ts). The switch and the lock are asked at the first part and again before the picture is
   * stored; uploads are not counted (the user's decision) — the slot's size limits and the picture quota still apply.
   */
  setAsset(instance: string, args: { slot?: unknown; data_b64?: unknown; part?: unknown }): ToolAnswer {
    if (typeof args.data_b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.data_b64)) return { error: "data", message: "The picture's bytes are missing." };
    if (args.part !== undefined) return this.setAssetPart(instance, args.slot, args.data_b64, args.part);
    const refused = this.refusal(instance, []);
    if (refused) return refused;
    return this.storeAsset(instance, args.slot, Buffer.from(args.data_b64, "base64"));
  }
  private storeAsset(instance: string, slot: unknown, bytes: Buffer): ToolAnswer {
    const w = this.store.addAsset(instance, slot, bytes);
    if (!w.ok) return { error: w.error, ...(w.detail ? { detail: w.detail } : {}) };
    return { id: w.id };
  }
  private setAssetPart(instance: string, slot: unknown, data: string, raw: unknown): ToolAnswer {
    const fail = (error: string, message: string): ToolAnswer => { this.uploads.delete(instance); return { error, message }; };
    const p = raw as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || Array.isArray(p)) return fail("part", "part: { index, count, bytes, sha256, upload? }");
    const { index, count, bytes, sha256 } = p;
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(bytes) || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return fail("part", "part: { index, count, bytes, sha256, upload? }");
    const chunk = Buffer.from(data, "base64");
    if (chunk.length < 1 || chunk.length > ASSET_PART_BYTES) return fail("part", `each part is 1..${ASSET_PART_BYTES} bytes`);
    const now = this.clock();
    // Uploads left idle by any instance go, so at most one picture's parts per active upload stay in memory.
    for (const [name, u] of this.uploads) if (now - u.last > ASSET_UPLOAD_IDLE_MS && name !== instance) this.uploads.delete(name);
    if (index === 0) {
      const refused = this.refusal(instance, []);
      if (refused) { this.uploads.delete(instance); return refused; }
      if (!THEME_ASSET_SLOTS.includes(slot as ThemeAssetSlot)) return fail("slot", THEME_ASSET_SLOTS.join(", "));
      const max = Math.min(ASSET_UPLOAD_MAX_BYTES, slotLimit(slot as ThemeAssetSlot, this.store.limits()).maxBytes);
      if ((bytes as number) < 1 || (bytes as number) > max) return fail("asset_too_large", `at most ${max / 1024} KiB for ${String(slot)}`);
      if ((count as number) !== Math.ceil((bytes as number) / ASSET_PART_BYTES)) return fail("part", "count does not match bytes");
      this.uploads.set(instance, { id: randomBytes(8).toString("hex"), slot: slot as ThemeAssetSlot, count: count as number, next: 0, bytes: bytes as number, sha256, parts: [], received: 0, last: now });
    }
    const up = this.uploads.get(instance);
    if (!up || (index !== 0 && p.upload !== up.id)) return fail("upload", "No such upload in progress: start again from part 0.");
    if (now - up.last > ASSET_UPLOAD_IDLE_MS) return fail("upload", "The upload waited too long between parts: start again from part 0.");
    if (index !== up.next || count !== up.count || bytes !== up.bytes || sha256 !== up.sha256 || slot !== up.slot) return fail("part", `expected part ${up.next} of the same upload`);
    if (up.received + chunk.length > up.bytes) return fail("part", "more bytes than declared");
    up.parts.push(chunk); up.received += chunk.length; up.next += 1; up.last = now;
    if (up.next < up.count) return { upload: up.id, received: up.received };
    this.uploads.delete(instance);
    const all = Buffer.concat(up.parts);
    if (all.length !== up.bytes || createHash("sha256").update(all).digest("hex") !== up.sha256) return { error: "part", message: "The parts do not add up to the declared picture." };
    const refused = this.refusal(instance, []);
    if (refused) return refused;
    return this.storeAsset(instance, up.slot, all);
  }

  /** reset_web_theme: the agent can always undo itself (a change for the limit). */
  resetTheme(instance: string): ToolAnswer {
    const refused = this.refusal(instance, ["change"]);
    if (refused) return refused;
    const w = this.store.reset(instance, "agent");
    if (!w.ok) return { error: w.error };
    this.limiter.record(instance, ["change"]);
    this.changed();
    return { theme: { v: 1 } as Theme };
  }

  /** A person's reset (Details, the chat menu): theme, placements and pictures go; the lock stays. Not limited. */
  humanReset(instance: string): ToolAnswer {
    this.uploads.delete(instance);
    const w = this.store.reset(instance, "human");
    if (!w.ok) return { error: w.error, status: w.status };
    this.changed();
    return { ok: true, rev: w.rev };
  }
  /** A person's lock (r2 (a)). Not limited. */
  humanLock(instance: string, locked: boolean): ToolAnswer {
    const w = this.store.setLocked(instance, locked);
    if (!w.ok) return { error: w.error, status: w.status };
    this.changed();
    return { ok: true, locked, rev: w.rev };
  }

  /**
   * set_web_widget { slot, spec?, data? } (r4-4): place a widget in one of its own slots (`spec`, a change), or give
   * the one there new values (`data` alone: merged, null removes a key — its own budget, 10 s apart). A widget a person
   * placed takes the agent's values but is never replaced by it. `sidebar` is the person's: owner_slot.
   */
  setWidget(instance: string, args: { slot?: unknown; spec?: unknown; data?: unknown }): ToolAnswer {
    const slot = this.agentSlot(args.slot);
    if (typeof slot !== "string") return slot;
    if (args.spec === undefined && args.data === undefined) return { error: "args", message: "Give spec (to place a widget) or data (new values for the one placed)." };
    const current = this.store.get(instance).placements.widgets[slot];
    if (args.spec === undefined) {
      const refused = this.refusal(instance, ["data"]);
      if (refused) return refused;
      if (!current) return { error: "no_widget", message: `Nothing is placed in ${slot}: give a spec first.` };
      const data = mergeWidgetData(current.data, args.data, current.spec);
      if (!data.ok) return { errors: data.errors };
      const w = this.store.setWidgetData(instance, slot, data.value, "agent");
      if (!w.ok) return { error: w.error, ...(w.detail ? { detail: w.detail } : {}) };
      this.limiter.record(instance, ["data"]);
      this.changed();
      return { slot, widget: { spec: w.widget.spec, data: w.widget.data, by: w.widget.by }, rev: w.rev };
    }
    const refused = this.refusal(instance, ["change"]);
    if (refused) return refused;
    if (current?.by === "human") return { error: "person_placed", message: `A person placed the widget in ${slot}: you can give it values (data), but not replace or remove it.` };
    const spec = checkWidgetSpec(args.spec, slot);
    if (!spec.ok) return { errors: spec.errors };
    const data = args.data === undefined ? { ok: true as const, value: carryWidgetData(current?.data ?? {}, spec.value) } : checkWidgetData(args.data, spec.value);
    if (!data.ok) return { errors: data.errors };
    const w = this.store.setWidget(instance, slot, spec.value, data.value, "agent");
    if (!w.ok) return { error: w.error, ...(w.detail ? { detail: w.detail } : {}) };
    this.limiter.record(instance, ["change"]);
    this.changed();
    return { slot, widget: { spec: w.widget.spec, data: w.widget.data, by: w.widget.by }, rev: w.rev };
  }

  /** remove_web_widget { slot? } (r4-4): its own widgets, from one slot or both; a person's placement stays (a change). */
  removeWidget(instance: string, args: { slot?: unknown }): ToolAnswer {
    let slots: AgentWidgetSlot[] = [...AGENT_WIDGET_SLOTS];
    if (args.slot !== undefined) { const slot = this.agentSlot(args.slot); if (typeof slot !== "string") return slot; slots = [slot]; }
    const refused = this.refusal(instance, ["change"]);
    if (refused) return refused;
    const placed = this.store.get(instance).placements.widgets;
    const kept = slots.filter(s => placed[s]?.by === "human");
    if (args.slot !== undefined && kept.length) return { error: "person_placed", message: `A person placed the widget in ${kept[0]}; only a person removes it.` };
    const mine = slots.filter(s => placed[s]?.by === "agent");
    if (!mine.length) return { removed: [], ...(kept.length ? { kept } : {}) };
    const w = this.store.removeWidgets(instance, mine, "agent");
    if (!w.ok) return { error: w.error, ...(w.detail ? { detail: w.detail } : {}) };
    this.limiter.record(instance, ["change"]);
    this.changed();
    return { removed: w.removed, ...(kept.length ? { kept } : {}), rev: w.rev };
  }

  private agentSlot(raw: unknown): AgentWidgetSlot | ToolAnswer {
    if (raw === "sidebar") return { error: "owner_slot", message: "The sidebar is a person's; place your widget in chat_header or details." };
    if (!(WIDGET_SLOTS as readonly unknown[]).includes(raw)) return { error: "slot", message: AGENT_WIDGET_SLOTS.join(" or ") };
    return raw as AgentWidgetSlot;
  }

  /**
   * set_web_ambient { preset, glyphs, … } (#2117): its own ambient, in the place its preset goes (one looping, one
   * click), placed or replaced (a change). One a person set is never replaced by the agent.
   */
  setAmbient(instance: string, args: Record<string, unknown>): ToolAnswer {
    const refused = this.refusal(instance, ["change"]);
    if (refused) return refused;
    const r = this.store.get(instance);
    const spec = checkAmbient(args, { glyphAsset: id => r.assets.some(a => a.id === id && a.slot === "glyph") });
    if (!spec.ok) return { errors: spec.errors };
    const kind = ambientKind(spec.value.preset);
    if (r.placements.ambient[kind]?.by === "human") return { error: "person_placed", message: `A person set the ${kind === "click" ? "click" : "looping"} ambient; only a person changes or clears it.` };
    const w = this.store.setAmbient(instance, spec.value, "agent");
    if (!w.ok) return { error: w.error, ...(w.detail ? { detail: w.detail } : {}) };
    this.limiter.record(instance, ["change"]);
    this.changed();
    return { kind: w.kind, ambient: { spec: w.ambient.spec, by: w.ambient.by }, rev: w.rev };
  }

  /** clear_web_ambient { which? } (#2117): its own ambients, one kind or both; a person's stays (a change). */
  clearAmbient(instance: string, args: { which?: unknown }): ToolAnswer {
    let kinds: AmbientKind[] = [...AMBIENT_KINDS];
    if (args.which !== undefined) {
      if (!(AMBIENT_KINDS as readonly unknown[]).includes(args.which)) return { error: "which", message: AMBIENT_KINDS.join(" or ") };
      kinds = [args.which as AmbientKind];
    }
    const refused = this.refusal(instance, ["change"]);
    if (refused) return refused;
    const placed = this.store.get(instance).placements.ambient;
    const kept = kinds.filter(k => placed[k]?.by === "human");
    if (args.which !== undefined && kept.length) return { error: "person_placed", message: `A person set the ${kept[0]} ambient; only a person clears it.` };
    const mine = kinds.filter(k => placed[k]?.by === "agent");
    if (!mine.length) return { removed: [], ...(kept.length ? { kept } : {}) };
    const w = this.store.clearAmbient(instance, mine, "agent");
    if (!w.ok) return { error: w.error, ...(w.detail ? { detail: w.detail } : {}) };
    this.limiter.record(instance, ["change"]);
    this.changed();
    return { removed: w.removed, ...(kept.length ? { kept } : {}), rev: w.rev };
  }

  /**
   * A person's ambient for an agent (General's set_web_settings, an admin session): a spec sets the place its preset
   * goes, null with `which` clears that one (both without). Not limited; the lock is not needed (it binds agents).
   */
  humanSetAmbient(instance: string, spec: unknown, which?: unknown): ToolAnswer {
    if (spec === null) {
      if (which !== undefined && !(AMBIENT_KINDS as readonly unknown[]).includes(which)) return { error: "which", status: 400, message: AMBIENT_KINDS.join(" or ") };
      const w = this.store.clearAmbient(instance, which === undefined ? AMBIENT_KINDS : [which as AmbientKind], "human");
      if (!w.ok) return { error: w.error, status: w.status };
      if (w.removed.length) this.changed();
      return { ok: true, removed: w.removed, rev: w.rev };
    }
    const r = this.store.get(instance);
    const checked = checkAmbient(spec, { glyphAsset: id => r.assets.some(a => a.id === id && a.slot === "glyph") });
    if (!checked.ok) return { error: "ambient", status: 400, message: ambientProblems(checked.errors) };
    const w = this.store.setAmbient(instance, checked.value, "human");
    if (!w.ok) return { error: w.error, status: w.status };
    this.changed();
    return { ok: true, kind: w.kind, ambient: { spec: w.ambient.spec, by: w.ambient.by }, rev: w.rev };
  }

  /** A person's removal of an agent's widget (Details, an admin session). Not limited; the lock is not needed. */
  humanRemoveWidget(instance: string, slot: unknown): ToolAnswer {
    if (!(AGENT_WIDGET_SLOTS as readonly unknown[]).includes(slot)) return { error: "slot", status: 400 };
    const w = this.store.removeWidgets(instance, [slot as AgentWidgetSlot], "human");
    if (!w.ok) return { error: w.error, status: w.status };
    if (w.removed.length) this.changed();                   // nothing placed there: nothing written, nothing announced
    return { ok: true, removed: w.removed, rev: w.rev };
  }

  /** An instance was removed: its counters and any upload in progress go. */
  forget(instance: string): void { this.uploads.delete(instance); this.limiter.forget(instance); }

  /** The tool dispatcher both doors share (typed IPC from the daemon, the agent endpoint for agend-agent). */
  handleTool(instance: string, tool: string, args: Record<string, unknown>): ToolAnswer {
    switch (tool) {
      case "get_web_theme": return this.getTheme(instance);
      case "set_web_theme": return this.setTheme(instance, args);
      case "set_web_theme_asset": return this.setAsset(instance, args);
      case "reset_web_theme": return this.resetTheme(instance);
      case "set_web_widget": return this.setWidget(instance, args);
      case "remove_web_widget": return this.removeWidget(instance, args);
      case "set_web_ambient": return this.setAmbient(instance, args);
      case "clear_web_ambient": return this.clearAmbient(instance, args);
      default: return { error: "unknown_tool" };
    }
  }
}
