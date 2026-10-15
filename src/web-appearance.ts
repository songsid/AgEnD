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
import { THEME_ASSET_LIMITS, THEME_ASSET_QUOTA, type ThemeStore } from "./web-theme-store.js";

export type ToolAnswer = Record<string, unknown>;
type WebConfigView = { themes?: { agent_edit?: boolean } } | undefined | null;

export class WebAppearance {
  readonly limiter: AppearanceLimiter;
  constructor(
    private readonly store: ThemeStore,
    private readonly webConfig: () => WebConfigView,
    private readonly changed: () => void = () => {},
    limiter?: AppearanceLimiter,
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
      limits: { ...this.limiter.remaining(instance), asset_bytes: { background: THEME_ASSET_LIMITS.background.maxBytes, avatar: THEME_ASSET_LIMITS.avatar.maxBytes }, asset_quota: THEME_ASSET_QUOTA },
    };
  }

  /** set_web_theme { set?, clear? }: all or nothing. `{}` is a no-op (and counts as nothing). */
  setTheme(instance: string, patch: unknown): ToolAnswer {
    const isNoop = !!patch && typeof patch === "object" && !Array.isArray(patch) && Object.keys(patch).length === 0;
    if (isNoop) return { theme: this.store.get(instance).theme, rev: this.store.rev() };
    const refused = this.refusal(instance, ["change"]);
    if (refused) return refused;
    const current = this.store.get(instance);
    const next = applyThemePatch(current.theme, patch, { assets: new Set(current.assets.map(a => a.id)) });
    if (!next.ok) return { errors: next.errors };
    const w = this.store.setTheme(instance, next.theme, "agent");
    if (!w.ok) return { error: w.error, ...(w.detail ? { detail: w.detail } : {}) };
    this.limiter.record(instance, ["change"]);
    this.changed();
    return { theme: w.theme, rev: w.rev };
  }

  /** set_web_theme_asset { slot, data_b64 }: the bytes the daemon or the CLI read on the agent's side. */
  setAsset(instance: string, args: { slot?: unknown; data_b64?: unknown }): ToolAnswer {
    const refused = this.refusal(instance, ["upload"]);
    if (refused) return refused;
    if (typeof args.data_b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.data_b64)) return { error: "data", message: "The picture's bytes are missing." };
    const bytes = Buffer.from(args.data_b64, "base64");
    const w = this.store.addAsset(instance, args.slot, bytes);
    if (!w.ok) return { error: w.error, ...(w.detail ? { detail: w.detail } : {}) };
    this.limiter.record(instance, ["upload"]);
    return { id: w.id };
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
