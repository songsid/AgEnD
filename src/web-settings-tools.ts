/**
 * #2056: the General instance (and a coordinator or full profile) changes Settings → Web appearance for the user — every
 * setting the page can change that does not need the person's own browser or files. One implementation: each change goes
 * through exactly what the page's route calls (the same store, the same validation, the same announcement), never a
 * copy of it. Custom CSS keeps its safe-token rules (OwnerCssStore.save → checkOwnerCss): no bypass. A tool saves CSS on
 * trial, keeps or reverts that trial, switches to an earlier saved version, or turns it off — the page's own buttons, on
 * the store's own checks (the user's decision, 2026-10-18: General may keep it; #2056 first allowed only the trial). Only
 * a version the person's store holds can be put back: every one of them passed checkOwnerCss when it was saved.
 *
 * Whose settings: the host's (the prefs every viewer of this host shares), and a person's own — their custom CSS and
 * their effect slots — named by `person` (one of get_web_settings' people; default: the host operator).
 *
 * Not here, and why (the page is the only way): choosing a file from the person's computer (a mod file, an effect folder,
 * a CSS asset, a card picture), this browser's switches (custom CSS off on this device, effect playback pause), downloading
 * an export, and the card upload limits (fleet configuration, whose raises wait for an admin's confirmation).
 */
import { OPERATOR } from "./web-prefs.js";
import type { WebPrefsStore } from "./web-prefs.js";
import type { OwnerCssStore } from "./web-owner-css-store.js";
import type { ModStore } from "./web-mod-store.js";
import type { WebEffectService } from "./web-effect-service.js";
import { DEFAULT_PLACEMENTS } from "./web-identity-palette.js";

const OWNER_SLOTS = ["sidebar", "header", "page", "box", "cursor"] as const;
type OwnerSlot = typeof OWNER_SLOTS[number];

export interface WebSettingsDeps {
  prefs: WebPrefsStore;
  ownerCss: OwnerCssStore;
  mods: ModStore;
  effects: WebEffectService;
  /** The instances the page lists (fleet and ClassicBot rooms). */
  instances(): string[];
  /** A person's colour for one instance, as the Colour dialog reads it; and its write (the page's /api/profile path). */
  colour(instance: string): { color: string | null; show: string[] | null };
  setColour(instance: string, patch: { color?: unknown; show?: unknown }): { ok: true } | { ok: false; status: number; error: string; detail?: string };
  /** #2086: a person's banner focus for one instance (0 top … 100 bottom; null: none), and its write (Edit profile's). */
  bannerFocus(instance: string): number | null;
  setBannerFocus(instance: string, focus: unknown): { ok: true } | { ok: false; status: number; error: string; detail?: string };
  /** #2117: each chat's ambient ({ loop?, click? }: spec and who set it), and a person's write (the chat menu's route). */
  ambient(instance: string): Record<string, { spec: unknown; by: string }>;
  setAmbient(instance: string, spec: unknown, which?: unknown): Record<string, unknown>;
  /** The effects placed on each chat (the page's Effects card). */
  placements(instance: string): Array<{ id: string; params?: Record<string, unknown> }>;
  /** Every page re-reads after a change (the routes' `announce`). */
  announce(): void;
}

type Result = { ok: true; [k: string]: unknown } | { ok: false; error: string; detail?: string; problems?: unknown };
const failed = (error: string, detail?: string, problems?: unknown): Result => ({ ok: false, error, ...(detail ? { detail } : {}), ...(problems ? { problems } : {}) });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The host prefs a tool may set, by their plain names, and how the page stores each (its default is stored as unset). */
const HOST = {
  themes_shown: { key: "fx.show", store: (v: unknown) => (v === true ? null : v) },
  card_size: { key: "card.size", store: (v: unknown) => (v === "m" ? null : v) },
  card_sizes: { key: "card.sizeByInstance", store: (v: unknown) => (isObj(v) && !Object.keys(v).length ? null : v) },
  colour_places: { key: "color.show", store: (v: unknown) => (Array.isArray(v) && sameSet(v, DEFAULT_PLACEMENTS) ? null : v) },
  colours_off: { key: "color.off", store: (v: unknown) => (v === false ? null : v) },
  sidebar_widget: { key: "widget.sidebar", store: (v: unknown) => v },
} as const;
const sameSet = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && b.every((x) => a.includes(x));
/** What Restore defaults resets on the page (settings-appearance.js RestoreDefaultsCard), host prefs side. */
const RESTORED = ["fx.show", "card.size", "card.sizeByInstance", "widget.sidebar", "color.show", "color.off"] as const;

export class WebSettingsTools {
  constructor(private readonly deps: WebSettingsDeps) {}

  /** The people whose own settings a tool may change: the host operator, and everyone who has signed in here. */
  people(): Array<{ person: string; name: string | null }> {
    return this.deps.prefs.people();
  }
  private person(raw: unknown): string | Result {
    if (raw === undefined || raw === OPERATOR) return OPERATOR;
    if (typeof raw !== "string" || !this.people().some((p) => p.person === raw)) return failed("unknown_person", "name one of get_web_settings' people");
    return raw;
  }

  /** Everything the page shows now, in plain words and as values. */
  read(rawPerson?: unknown): Result {
    const person = this.person(rawPerson);
    if (typeof person !== "string") return person;
    const host = this.deps.prefs.read(OPERATOR).values as Record<string, unknown>;
    const own = this.deps.prefs.readForViewer(person === OPERATOR ? OPERATOR : person).values as Record<string, unknown>;
    const places = (Array.isArray(host["color.show"]) ? host["color.show"] : [...DEFAULT_PLACEMENTS]) as string[];
    const cardSize = (host["card.size"] as string | undefined) ?? "m";
    const css = this.deps.ownerCss.state(person);
    const mods = this.deps.mods.list(), proposals = this.deps.mods.proposals();
    const agents = this.deps.instances().map((name) => ({ name, ...this.deps.colour(name), effects: this.deps.placements(name), ambient: this.deps.ambient(name) }));
    const slots = Object.fromEntries(OWNER_SLOTS.map((s) => [s, (own[`fx.${s}`] as string | undefined) ?? null]));
    const sizeWord = { s: "small", m: "medium", l: "large" } as Record<string, string>;
    const summary = [
      `Agents' themes, effects and widgets: ${host["fx.show"] === false ? "hidden (every chat looks the same)" : "shown"}.`,
      `Identity colours: ${host["color.off"] === true ? "turned off on this host" : `shown on ${places.length ? places.join(", ") : "nowhere"}${host["color.show"] === undefined ? " (the default)" : ""}`}.`,
      `Agents with a person's own colour: ${agents.filter((a) => a.color || a.show).map((a) => `${a.name} (${a.color ?? "their own colour"}${a.show ? `, on ${a.show.join(", ") || "nowhere"}` : ""})`).join("; ") || "none"}.`,
      `Identity cards: ${sizeWord[cardSize] ?? cardSize}${isObj(host["card.sizeByInstance"]) && Object.keys(host["card.sizeByInstance"]).length ? `, set apart: ${Object.entries(host["card.sizeByInstance"]).map(([n, s]) => `${n} ${sizeWord[s as string] ?? s}`).join(", ")}` : ""}.`,
      `Sidebar widget: ${isObj(host["widget.sidebar"]) ? `"${String((host["widget.sidebar"] as { spec?: { title?: unknown } }).spec?.title ?? "untitled")}"` : "none"}.`,
      `Custom CSS (${person === OPERATOR ? "the host operator" : person}): ${css.active ? `in force (version ${css.active.slice(0, 8)})` : "off"}${css.pending ? `, on trial (${Math.ceil(css.pending.remaining_ms / 1000)} s left): keep or revert it` : ""}; ${css.versions.length} saved version(s).`,
      `Mods installed: ${mods.mods.map((m) => `${m.name} ${m.version}`).join(", ") || "none"}; proposed by agents: ${proposals.map((p) => p.instance).join(", ") || "none"}.`,
      `Effects on chats: ${agents.filter((a) => a.effects.length).map((a) => `${a.name}: ${a.effects.map((e) => e.id.slice(0, 8)).join(", ")}`).join("; ") || "none"}.`,
      `Ambient effects: ${agents.filter((a) => Object.keys(a.ambient).length).map((a) => `${a.name}: ${Object.values(a.ambient).map((x) => `${(x.spec as { preset?: string }).preset} (set by ${x.by === "human" ? "a person" : "the agent"})`).join(", ")}`).join("; ") || "none"}.`,
      `Effect slots (${person === OPERATOR ? "the host operator" : person}): ${OWNER_SLOTS.filter((s) => slots[s]).map((s) => `${s} ${(slots[s] as string).slice(0, 8)}`).join(", ") || "none"}.`,
    ];
    return {
      ok: true, summary, person, people: this.people(),
      host: { themes_shown: host["fx.show"] !== false, card_size: cardSize, card_sizes: host["card.sizeByInstance"] ?? {}, colour_places: places,
        colour_places_default: host["color.show"] === undefined, colours_off: host["color.off"] === true, sidebar_widget: host["widget.sidebar"] ?? null },
      agents,
      custom_css: { active: css.active, on_trial: css.pending !== null, trial: css.pending?.id ?? null, versions: css.versions.map((v) => ({ sha: v.sha, bytes: v.bytes })) },
      mods: { installed: mods.mods, proposals },
      effect_slots: slots,
      page_only: ["choosing a file from the person's computer (a mod file, an effect folder, a CSS asset, a card picture)",
        "this browser's switches (custom CSS off on this device; pausing effect playback)",
        "downloading an export", "the card upload limits"],
    };
  }

  /** One change, as the page makes it. */
  change(rawPerson: unknown, change: unknown): Result {
    const person = this.person(rawPerson);
    if (typeof person !== "string") return person;
    if (!isObj(change) || typeof change.what !== "string") return failed("change", "an object with `what`");
    switch (change.what) {
      case "host": return this.host(change.set);
      case "agent_colour": return this.agentColour(change);
      case "banner_focus": return this.bannerFocus(change);
      case "custom_css": return this.css(person, change);
      case "mod": return this.mod(person, change);
      case "effect": return this.effect(person, change);
      case "effect_slot": return this.slot(person, change);
      case "ambient": return this.ambient(change);
      case "restore_defaults": return this.restore(person);
      default: return failed("change", `unknown \`what\`: ${change.what}`);
    }
  }

  /** The page's /ui/prefs write, for these keys, with its validation (parsePatch) and its announcement. */
  private writePrefs(person: string, set: Record<string, unknown>): Result {
    const parsed = this.deps.prefs.parsePatch(set);
    if (!parsed.ok) return failed("prefs", parsed.error);
    const before = this.deps.prefs.readForViewer(person).values;
    const written = this.deps.prefs.writeForViewer(person, parsed.patch, {
      validateEffect: (p, key, id) => this.deps.effects.validateOwnerSelection(p, key, id),
    });
    if (!written.ok) return failed(written.error);
    const dropped = written.changed.filter((k) => k.startsWith("fx.") && k !== "fx.show")
      .flatMap((k) => typeof before[k] === "string" && before[k] !== written.view.values[k] ? [before[k] as string] : []);
    if (dropped.length) this.deps.effects.collectOwnerReplaced(dropped);
    if (written.changed.length) this.deps.announce();
    return { ok: true, changed: written.changed };
  }

  private host(set: unknown): Result {
    if (!isObj(set) || !Object.keys(set).length) return failed("host", `set one or more of: ${Object.keys(HOST).join(", ")}`);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(set)) {
      const spec = (HOST as Record<string, { key: string; store: (v: unknown) => unknown }>)[k];
      if (!spec || !Object.hasOwn(HOST, k)) return failed("host", `unknown setting: ${k} (known: ${Object.keys(HOST).join(", ")})`);
      patch[spec.key] = v === null ? null : spec.store(v);
    }
    return this.writePrefs(OPERATOR, patch);
  }

  /** #2086: which part of an agent's cropped banner stays in view — the person's choice, as Edit profile sets it. */
  private bannerFocus(c: Record<string, unknown>): Result {
    if (typeof c.instance !== "string" || !this.deps.instances().includes(c.instance)) return failed("unknown_instance");
    if (!Object.hasOwn(c, "focus")) return failed("banner_focus", "focus: 0 (top) … 100 (bottom), or null to follow the agent's");
    const w = this.deps.setBannerFocus(c.instance, c.focus);
    return w.ok ? { ok: true, instance: c.instance, focus: this.deps.bannerFocus(c.instance) } : failed(w.error, w.detail);
  }

  private agentColour(c: Record<string, unknown>): Result {
    if (typeof c.instance !== "string" || !this.deps.instances().includes(c.instance)) return failed("unknown_instance");
    const patch: { color?: unknown; show?: unknown } = {};
    if (Object.hasOwn(c, "colour")) patch.color = c.colour;
    if (Object.hasOwn(c, "places")) patch.show = c.places;
    if (!Object.keys(patch).length) return failed("agent_colour", "set colour and/or places (null resets each)");
    const w = this.deps.setColour(c.instance, patch);
    return w.ok ? { ok: true, instance: c.instance, ...this.deps.colour(c.instance) } : failed(w.error, w.detail);
  }

  private css(person: string, c: Record<string, unknown>): Result {
    const store = this.deps.ownerCss, done = (r: { ok: boolean; status?: number; error?: string; detail?: string }, body: Record<string, unknown>): Result => {
      if (!r.ok) return failed(r.error ?? "custom_css", r.detail);
      this.deps.announce();
      return { ok: true, ...body };
    };
    switch (c.action) {
      // #2198: an agent's save waits for the person's page; the 20 s keep window starts when it is on their screen.
      case "save": { const r = store.save(person, c.text, { by: "agent" }); return r.ok ? done(r, { on_trial: true, trial: r.trial, previous: r.previous, note: "on trial: it waits until they open the dashboard (up to 10 minutes), then goes back by itself 20 s after it is on their screen unless kept — by them there, or by you (keep with this trial) when they say so. Kept too late, it is put back in force (as use of this version)." }) : done(r, {}); }
      case "keep": {
        // #2198 follow-up: keep names its trial, so a newer one the person saved on their page meanwhile is never kept instead.
        const r = store.keepForAgent(person, c.trial);
        if (r.ok) return done(r, { active: r.active, ...(r.restored ? { note: "it had gone back: this version is in force again (as use)" } : {}) });
        if (r.error === "trial") return failed("trial", "keep needs trial: the id save returned (or get_web_settings' custom_css.trial for the one on trial now)");
        if (r.error === "trial_mismatch") return failed("trial_mismatch", "a different trial is on now (saved since, on their page or by another save): not kept. Ask them which they want; keep that one with its id from get_web_settings' custom_css.trial, or put yours back with use");
        return r.error === "not_on_trial" ? failed("not_on_trial", "that trial is no longer on and did not just go back: put a saved one back with use (version from get_web_settings' custom_css.versions)") : done(r, {});
      }
      case "revert": { const r = store.revertTrial(person, store.state(person).pending?.id); return r.ok ? done(r, { active: r.active }) : done(r, {}); }
      case "off": { const r = store.restore(person, null); return r.ok ? done(r, { active: r.active }) : done(r, {}); }
      case "use": { const r = store.restore(person, c.version); return r.ok ? done(r, { active: r.active }) : done(r, {}); }
      default: return failed("custom_css", "action: save (with text: on trial), keep (with trial: the id save returned), revert (the trial), use (with version: an earlier saved one) or off");
    }
  }

  private mod(person: string, c: Record<string, unknown>): Result {
    const mods = this.deps.mods;
    const out = (r: { ok: boolean; error?: string; detail?: string; problems?: unknown }, body: () => Record<string, unknown>): Result =>
      r.ok ? { ok: true, ...body() } : failed(r.error ?? "mod", r.detail, r.problems);
    switch (c.action) {
      case "review": {
        // A person has one review open at a time: opening another would drop theirs (a file they are looking at on the page).
        const open = mods.stageOrigin(person);
        if (open) {
          return failed("mod_review_open", open.proposal === null
            ? "the person has a mod file open for review on the page; ask them to install or cancel it first"
            : `a review of ${open.proposal}'s proposal is already open (yours, or the person's on the page); cancel yours with its stage, or ask them to finish`);
        }
        const r = mods.stageProposal(person, c.instance);
        return out(r, () => r.ok ? { stage: r.stage, plan: r.plan, plan_hash: r.plan_hash, note: "install it with the parts to apply (custom CSS is never ticked for you)" } : {});
      }
      case "install": {
        // Only an agent's proposal: a mod the person imported from a file is theirs to install on the page.
        const open = mods.stageOrigin(person);
        if (open && open.stage === c.stage && open.proposal === null) return failed("mod_not_from_an_agent", "a mod the person imported from a file is installed on the page, by them");
        const r = mods.commit(person, { stage: c.stage, plan_hash: c.plan_hash, include: c.include, target: c.target });
        if (r.ok) this.deps.announce();
        return out(r, () => r.ok ? { id: r.id, applied: r.applied, ...(r.css ? { css: r.css } : {}) } : {});
      }
      case "cancel": { const r = mods.abort(person, c.stage); return out(r, () => ({})); }
      case "dismiss": { const r = mods.dismiss(c.instance); return out(r, () => ({})); }
      case "uninstall": { const r = mods.uninstall(c.id); return out(r, () => r.ok ? { released: r.released } : {}); }
      default: return failed("mod", "action: review (instance), install (stage, plan_hash, include, target), cancel (stage), dismiss (instance) or uninstall (id)");
    }
  }

  private effect(person: string, c: Record<string, unknown>): Result {
    const args = { instance: c.instance, id: c.id, ...(c.params !== undefined ? { params: c.params } : {}) };
    const r = c.action === "apply" ? this.deps.effects.apply(person, args) : c.action === "remove" ? this.deps.effects.remove(person, { instance: c.instance, ...(c.id !== undefined ? { id: c.id } : {}) }) : null;
    if (!r) return failed("effect", "action: apply (instance, id, params?) or remove (instance, id?)");
    return isObj(r) && typeof r.error === "string" ? failed(r.error, typeof r.detail === "string" ? r.detail : undefined) : { ok: true, ...(r as Record<string, unknown>) };
  }

  /** #2117: a person's ambient for an agent — the chat menu's write (a person's wins over the agent's, and binds it). */
  private ambient(c: Record<string, unknown>): Result {
    if (typeof c.instance !== "string" || !this.deps.instances().includes(c.instance)) return failed("unknown_instance");
    if (!Object.hasOwn(c, "ambient")) return failed("ambient", "ambient: a spec (as set_web_ambient's), or null to clear (which: loop | click, default both)");
    const r = this.deps.setAmbient(c.instance, c.ambient, c.which);
    if (typeof r.error === "string") return failed(r.error, typeof r.message === "string" ? r.message : undefined);
    return { ok: true, instance: c.instance, ...r, now: this.deps.ambient(c.instance) };
  }

  private slot(person: string, c: Record<string, unknown>): Result {
    if (typeof c.slot !== "string" || !(OWNER_SLOTS as readonly string[]).includes(c.slot)) return failed("effect_slot", `slot: ${OWNER_SLOTS.join(", ")}`);
    if (c.id !== null && typeof c.id !== "string") return failed("effect_slot", "id: an effect id, or null to clear");
    return this.writePrefs(person, { [`fx.${c.slot as OwnerSlot}`]: c.id });
  }

  /** The page's Restore defaults: the host prefs back to their defaults, and this person's custom CSS off. */
  private restore(person: string): Result {
    const prefs = this.writePrefs(OPERATOR, Object.fromEntries(RESTORED.map((k) => [k, null])));
    if (!prefs.ok) return prefs;
    const css = this.deps.ownerCss.state(person).active ? this.deps.ownerCss.restore(person, null) : { ok: true as const };
    if (!css.ok) return failed("restore_css", "the settings were restored, but custom CSS could not be turned off");
    this.deps.announce();
    return { ok: true, changed: prefs.changed, custom_css: "off", note: "a browser's own switch (custom CSS off on this device) is the person's to change on the page" };
  }
}
