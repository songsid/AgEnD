/**
 * #1629 (first design §4, §6; r2 (a)–(c)): the agent's own theme tools — get_web_theme, set_web_theme,
 * set_web_theme_asset, reset_web_theme — and a person's reset and lock. None takes a target: the caller is the
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

  /** get_web_theme: the caller's theme and everything an agent needs to write a good one. */
  getTheme(instance: string): ToolAnswer {
    const r = this.store.get(instance);
    return {
      theme: r.theme, by: r.by, locked: r.locked, agent_edit: agentAppearanceEditAllowed(this.webConfig()),
      defaults: THEME_DEFAULTS,
      assets: r.assets.map(a => ({ id: a.id, slot: a.slot, bytes: a.bytes })),
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
   * in parts (web-asset-parts.ts). The switch, the lock and the limit are asked at the first part and again before the
   * picture is stored; only a stored picture counts as an upload.
   */
  setAsset(instance: string, args: { slot?: unknown; data_b64?: unknown; part?: unknown }): ToolAnswer {
    if (typeof args.data_b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.data_b64)) return { error: "data", message: "The picture's bytes are missing." };
    if (args.part !== undefined) return this.setAssetPart(instance, args.slot, args.data_b64, args.part);
    const refused = this.refusal(instance, ["upload"]);
    if (refused) return refused;
    return this.storeAsset(instance, args.slot, Buffer.from(args.data_b64, "base64"));
  }
  private storeAsset(instance: string, slot: unknown, bytes: Buffer): ToolAnswer {
    const w = this.store.addAsset(instance, slot, bytes);
    if (!w.ok) return { error: w.error, ...(w.detail ? { detail: w.detail } : {}) };
    this.limiter.record(instance, ["upload"]);
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
      const refused = this.refusal(instance, ["upload"]);
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
    const refused = this.refusal(instance, ["upload"]);
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

  /** An instance was removed: its counters and any upload in progress go. */
  forget(instance: string): void { this.uploads.delete(instance); this.limiter.forget(instance); }

  /** The tool dispatcher both doors share (typed IPC from the daemon, the agent endpoint for agend-agent). */
  handleTool(instance: string, tool: string, args: Record<string, unknown>): ToolAnswer {
    switch (tool) {
      case "get_web_theme": return this.getTheme(instance);
      case "set_web_theme": return this.setTheme(instance, args);
      case "set_web_theme_asset": return this.setAsset(instance, args);
      case "reset_web_theme": return this.resetTheme(instance);
      default: return { error: "unknown_tool" };
    }
  }
}
