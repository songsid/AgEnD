/**
 * #1629 r4 §4 (r4-5): installed mods, and a person's import in two steps.
 *
 *   <dataDir>/web-mods.json                    { version: 1, rev, mods: { <id>: ModRecord } }   (0600, atomic)
 *   <dataDir>/web-mods/<id>.agendmod.json       each installed bundle, exactly as checked (its id is its content)
 *
 * Stage: a person's upload is checked whole (web-mod-bundle.ts) and kept **in memory** with the plan the page shows,
 * one per person, for 10 minutes (monotonic). A fleet restart forgets it: commit then answers unknown_stage, and the
 * person stages and reviews again. Effect entries are staged in the effect library at the same time (CW1), under the
 * mod's own holder.
 *
 * Commit applies exactly the staged plan's chosen parts — or nothing: effect library first, then the theme store (one
 * record write), the person's sidebar widget, their own CSS (as a trial they keep or revert on the page), then the
 * index. Any failure undoes what was done, in reverse. Pictures an import replaced are deleted only once all of it held.
 *
 * Uninstall removes the mod from the library: its file, its index entry and its effect claim (the library keeps an
 * effect still placed, or held by another mod or upload). What it applied stays applied — a look is the instance's (or
 * the person's) once imported; Reset, Lock and the person's own CSS controls work on it as on any other.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { MEDIA_MIME } from "./web-image-meta.js";
import { canonicalJson, type CheckedMod, checkModBundle, type EffectFiles, type ModContext, type ModProblem } from "./web-mod-bundle.js";
import type { ThemeStore } from "./web-theme-store.js";
import type { OwnerCssSnapshot } from "./web-owner-css-store.js";
import { AGENT_WIDGET_SLOTS, type AgentWidgetSlot } from "./web-widget.js";

export const MOD_STAGE_MS = 10 * 60 * 1000;
export const MODS_MAX_INSTALLED = 20;
export const MODS_MAX_BYTES = 64 * 1024 * 1024;
const MOD_ID = /^[0-9a-f]{32}$/;

/** Who an effect claim belongs to (CW1): a mod import is always a person's. */
export interface EffectPrincipal { kind: "agent" | "human"; id: string }
/**
 * The effect library (Sol's B2, CW1), as mods use it. Null while the fleet has none: then no bundle with effects is
 * accepted (the checker refuses it first).
 */
export interface ModEffectLibrary {
  stage(entries: readonly EffectFiles[], principal: EffectPrincipal, opts: { holder: string }): { ok: true; stageId: string; ids: string[] } | { ok: false; error: string };
  commit(stageId: string): { ok: true; ids: string[]; created: string[]; undo: () => boolean } | { ok: false; error: string };
  abort(stageId: string): void;
  releaseHolder(holder: string, principal: EffectPrincipal): { ok: true; released: string[]; undo: () => boolean } | { ok: false; error: string };
  /** A guarded, deferred collector: rechecks every claim and reference before deleting (never synchronously). */
  collectUnreferenced?(ids: readonly string[]): void;
}
/** A person's preferences, as the import writes their sidebar widget (web-prefs.ts). */
export interface ModPrefs {
  read(identity: string): { values: Record<string, unknown>; unreadable?: true };
  write(identity: string, patch: Map<string, unknown>): { ok: true } | { ok: false; status: number; error: string };
}
/** A person's own CSS (web-owner-css-store.ts), as the import adds its assets and tries its text. */
export interface ModOwnerCss {
  snapshot(person: string): OwnerCssSnapshot;
  restoreSnapshot(person: string, snap: OwnerCssSnapshot): { ok: boolean };
  addAsset(person: string, bytes: Uint8Array): { ok: true; id: string } | { ok: false; status: number; error: string; detail?: string };
  save(person: string, text: unknown): { ok: true; sha: string; previous: string | null; trial: string } | { ok: false; status: number; error: string; detail?: string };
}

export interface ModRecord {
  name: string; version: string; title: string;
  bytes: number;
  installedBy: string;
  /** Principal that owns this mod's effect holder. Older records use installedBy. */
  effectsBy?: string;
  installedAt: number;
  /** The instance the look went to, when it had one. */
  target?: string;
  /** What was applied: "theme", "identity", "widget:<slot>", "effects", "ownerCss". */
  parts: string[];
  /** The effect entries it carries, by path, and the library's ids for them (audit: which claims this commit created). */
  effects: Array<{ path: string; id: string }>;
  created: string[];
}
export type ModWrite<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; status: number; error: string; detail?: string; problems?: ModProblem[] };

export interface ModPlanItem { part: string; [k: string]: unknown }
export interface ModPlan {
  mod: { id: string; name: string; version: string; title: string; description?: string; author?: string; requires?: string; bytes: number; installed: boolean; replaces?: { id: string; version: string } };
  items: ModPlanItem[];
  /** Whether a target instance must be chosen (a theme, identity, agent widgets or effect placements). */
  needs_target: boolean;
  warnings: string[];
}
export interface ModInclude {
  theme?: boolean; identity?: boolean; effects?: boolean; ownerCss?: boolean;
  widgets?: Partial<Record<"chat_header" | "details" | "sidebar", boolean>>;
  /** Replace the installed mod of the same name (a different version). */
  replace?: boolean;
}

interface Stage { id: string; person: string; mod: CheckedMod; text: string; plan: ModPlan; planHash: string; at: number; effects?: { stageId: string; ids: string[]; owner: string }; proposal?: string }
/** r4-5b: a mod an agent proposed (propose_web_mod), waiting for a person to review it — one per agent. */
export interface ModProposal { name: string; version: string; title: string; bytes: number; at: number; id: string }
type Index = { rev: number; mods: Map<string, ModRecord>; proposals: Map<string, ModProposal> } | "unreadable";

const sha32 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const modHolder = (id: string) => `mod:${id}`;

/** What the page shows before anything is applied: every part, in full (the owner CSS's text included). */
export function modPlan(mod: CheckedMod, installed: ReadonlyMap<string, ModRecord>): ModPlan {
  const items: ModPlanItem[] = [];
  const t = mod.theme;
  if (t) {
    const effectsById = (p: string) => mod.effects.find(e => e.path === p)?.summary.id ?? null;
    items.push({ part: "theme", theme: t.theme, pictures: t.pictures.map(p => ({ path: p.path, slot: p.slot, id: p.id, bytes: p.kept.length })),
      effects: t.effects.map(e => ({ effect: e.effect, id: effectsById(e.effect), params: e.params })) });
  }
  if (mod.identity) items.push({ part: "identity", ...mod.identity });
  for (const slot of ["chat_header", "details", "sidebar"] as const) {
    const w = mod.widgets[slot];
    if (w) items.push({ part: "widget", slot, spec: w.spec, data: w.data });
  }
  for (const e of mod.effects) items.push({ part: "effect", path: e.path, ...e.summary });
  if (mod.ownerCss) items.push({ part: "ownerCss", text: mod.ownerCss.text, assets: mod.ownerCss.assets.map(a => ({ path: a.path, id: a.id, kind: a.kind, bytes: a.kept.length })) });
  const same = [...installed].find(([, r]) => r.name === mod.manifest.name);
  const warnings: string[] = [];
  if (mod.ownerCss) warnings.push("owner_css_unchecked: Custom CSS from this file — read it before turning it on.");
  return {
    mod: {
      id: mod.id, name: mod.manifest.name, version: mod.manifest.version, title: mod.manifest.title,
      ...(mod.manifest.description ? { description: mod.manifest.description } : {}),
      ...(mod.manifest.author ? { author: mod.manifest.author } : {}),
      ...(mod.manifest.requires ? { requires: mod.manifest.requires.agend } : {}),
      bytes: mod.bytes, installed: installed.has(mod.id),
      ...(same && same[0] !== mod.id ? { replaces: { id: same[0], version: same[1].version } } : {}),
    },
    items,
    needs_target: !!(mod.theme || mod.identity || mod.widgets.chat_header || mod.widgets.details),
    warnings,
  };
}

export class ModStore {
  private index: Index | null = null;
  private readonly stages = new Map<string, Stage>();
  readonly path: string;
  constructor(private readonly dataDir: string, private readonly deps: {
    themes: ThemeStore;
    prefs: ModPrefs;
    ownerCss: ModOwnerCss | null;
    effects: ModEffectLibrary | null;
    context: () => ModContext;
    isKnownInstance: (name: string) => boolean;
    /** The preferences bucket the page reads (/ui/prefs: one, the operator's — web-prefs.ts). */
    prefsIdentity: string;
    clock?: () => number;
    now?: () => number;
  }) {
    this.path = join(dataDir, "web-mods.json");
  }
  private clock(): number { return (this.deps.clock ?? (() => performance.now()))(); }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private file(id: string): string { return join(this.dataDir, "web-mods", `${id}.agendmod.json`); }

  private load(): Index {
    if (this.index) return this.index;
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (err) { return (this.index = (err as NodeJS.ErrnoException).code === "ENOENT" ? { rev: 0, mods: new Map(), proposals: new Map() } : "unreadable"); }
    try {
      const doc = JSON.parse(text) as { version?: unknown; rev?: unknown; mods?: unknown; proposals?: unknown };
      if (doc.version !== 1 || !Number.isSafeInteger(doc.rev) || !isObj(doc.mods)) return (this.index = "unreadable");
      const mods = new Map<string, ModRecord>();
      for (const [id, r] of Object.entries(doc.mods)) if (MOD_ID.test(id) && isObj(r) && typeof r.name === "string") mods.set(id, r as unknown as ModRecord);
      const proposals = new Map<string, ModProposal>();
      if (isObj(doc.proposals)) for (const [name, r] of Object.entries(doc.proposals)) if (isObj(r) && typeof r.id === "string" && MOD_ID.test(r.id)) proposals.set(name, r as unknown as ModProposal);
      return (this.index = { rev: doc.rev as number, mods, proposals });
    } catch { return (this.index = "unreadable"); }
  }
  private save(mods: Map<string, ModRecord>, proposals: Map<string, ModProposal>, rev: number): void {
    const own = <T>(m: Map<string, T>) => { const out: Record<string, T> = Object.create(null); for (const [k, v] of m) Object.defineProperty(out, k, { value: v, enumerable: true }); return out; };
    atomicWriteFileSync(this.path, JSON.stringify({ version: 1, rev, mods: own(mods), proposals: own(proposals) }, null, 2) + "\n", { mode: 0o600 });
  }
  /** Write the index (disk first, then memory). `proposals`: unchanged unless given. */
  private commitIndex(mods: Map<string, ModRecord>, proposals?: Map<string, ModProposal>): ModWrite<{ rev: number }> {
    const idx = this.load();
    if (idx === "unreadable") return { ok: false, status: 503, error: "mods_unreadable" };
    const rev = idx.rev + 1;
    const props = proposals ?? idx.proposals;
    try { this.save(mods, props, rev); } catch (err) { return { ok: false, status: 503, error: "mods_write_failed", detail: (err as Error).message }; }
    this.index = { rev, mods, proposals: props };
    return { ok: true, rev };
  }
  private proposalFile(instance: string): string { return join(this.dataDir, "web-mods", "proposals", `${sha32(`instance\0${instance}`)}.agendmod.json`); }

  /**
   * r4-5b: keep an agent's proposed mod (checked already, and never carrying custom CSS — the caller refuses that by
   * the path the bytes came in by) until a person reviews or dismisses it. One per agent: a new one replaces it.
   */
  propose(instance: string, text: string, mod: CheckedMod): ModWrite<{ proposal: ModProposal }> {
    const idx = this.load();
    if (idx === "unreadable") return { ok: false, status: 503, error: "mods_unreadable" };
    const file = this.proposalFile(instance);
    // The proposal it replaces is kept until the index names the new one: a failed index write puts it back.
    let before: string | null = null;
    try { before = readFileSync(file, "utf8"); } catch { /* none */ }
    try { mkdirSync(join(this.dataDir, "web-mods", "proposals"), { recursive: true, mode: 0o700 }); atomicWriteFileSync(file, text, { mode: 0o600 }); }
    catch (err) { return { ok: false, status: 503, error: "mods_write_failed", detail: (err as Error).message }; }
    const proposal: ModProposal = { id: mod.id, name: mod.manifest.name, version: mod.manifest.version, title: mod.manifest.title, bytes: mod.bytes, at: this.now() };
    const proposals = new Map(idx.proposals); proposals.set(instance, proposal);
    const w = this.commitIndex(idx.mods, proposals);
    if (!w.ok) {
      try { if (before === null) unlinkSync(file); else atomicWriteFileSync(file, before, { mode: 0o600 }); } catch { /* best effort */ }
      return w;
    }
    return { ok: true, proposal };
  }
  /** Proposals waiting for a person, by agent. */
  proposals(): Array<ModProposal & { instance: string }> {
    const idx = this.load();
    return idx === "unreadable" ? [] : [...idx.proposals].map(([instance, p]) => ({ instance, ...p }));
  }
  /** A person opens an agent's proposal into the usual review: staged as theirs, its plan shown in full. */
  stageProposal(person: string, instance: unknown): ModWrite<{ stage: string; plan: ModPlan; plan_hash: string }> {
    const idx = this.load();
    if (idx === "unreadable") return { ok: false, status: 503, error: "mods_unreadable" };
    if (typeof instance !== "string" || !idx.proposals.has(instance)) return { ok: false, status: 404, error: "no_such_proposal" };
    let text: string;
    try { text = readFileSync(this.proposalFile(instance), "utf8"); } catch { return { ok: false, status: 404, error: "no_such_proposal" }; }
    return this.stage(person, text, { proposal: instance });
  }
  /** A person dismisses an agent's proposal. */
  dismiss(instance: unknown): ModWrite {
    const idx = this.load();
    if (idx === "unreadable") return { ok: false, status: 503, error: "mods_unreadable" };
    if (typeof instance !== "string" || !idx.proposals.has(instance)) return { ok: false, status: 404, error: "no_such_proposal" };
    const proposals = new Map(idx.proposals); proposals.delete(instance);
    const w = this.commitIndex(idx.mods, proposals);
    if (!w.ok) return w;
    try { unlinkSync(this.proposalFile(instance)); } catch { /* already gone */ }
    return { ok: true };
  }

  /** The context bundles are checked in (the effect runtime's checker, when the fleet has one): the agent's side uses it too. */
  checkContext(): ModContext { return this.deps.context(); }

  /** Installed mods, for the page. */
  list(): { rev: number; mods: Array<ModRecord & { id: string }>; unreadable?: true } {
    const idx = this.load();
    if (idx === "unreadable") return { rev: 0, mods: [], unreadable: true };
    return { rev: idx.rev, mods: [...idx.mods].map(([id, r]) => ({ id, ...r })) };
  }
  /** An installed bundle's file, exactly as it was checked (for export of an installed mod). */
  bundleText(id: string): string | null {
    const idx = this.load();
    if (!MOD_ID.test(id) || idx === "unreadable" || !idx.mods.has(id)) return null;
    try { return readFileSync(this.file(id), "utf8"); } catch { return null; }
  }
  /**
   * The effects an installed bundle's file carries, as library content ids — what downloading that file hands over,
   * whether or not its import installed them (an import that left effects out still keeps the whole file). "unknown":
   * the file no longer checks here and lists effects, so what they are can't be said; null: no such mod.
   */
  bundleEffects(id: string): string[] | "unknown" | null {
    const text = this.bundleText(id);
    if (text === null) return null;
    // An installed file, read again: #2017's placement rule is for new imports — a mod installed before it still checks.
    const checked = checkModBundle(text, { ...this.deps.context(), placementRegions: false });
    if (checked.ok) return checked.mod.effects.map(e => e.summary.id);
    try {
      const listed = (JSON.parse(text) as { manifest?: { contents?: { effects?: unknown } } })?.manifest?.contents?.effects;
      if (listed === undefined || (Array.isArray(listed) && listed.length === 0)) return [];
    } catch { /* unknown */ }
    return "unknown";
  }

  /** Stages left idle past their time go (their effect stage is aborted). */
  private sweep(): void {
    const now = this.clock();
    for (const [person, s] of this.stages) if (now - s.at > MOD_STAGE_MS || now < s.at) this.drop(person);
  }
  private drop(person: string): void {
    const s = this.stages.get(person);
    if (!s) return;
    if (s.effects) this.deps.effects?.abort(s.effects.stageId);
    this.stages.delete(person);
  }
  /** The person's staged import (its plan), if one is still current. */
  staged(person: string): { stage: string; plan: ModPlan; plan_hash: string; expires_in_s: number } | null {
    this.sweep();
    const s = this.stages.get(person);
    return s ? { stage: s.id, plan: s.plan, plan_hash: s.planHash, expires_in_s: Math.max(0, Math.ceil((MOD_STAGE_MS - (this.clock() - s.at)) / 1000)) } : null;
  }
  /** #2064 review: where the person's open review came from — an agent's proposal (its instance) or a file (null). */
  stageOrigin(person: string): { stage: string; proposal: string | null } | null {
    this.sweep();
    const s = this.stages.get(person);
    return s ? { stage: s.id, proposal: s.proposal ?? null } : null;
  }
  /** A picture of this person's staged mod (its theme's), so the plan can show it before anything is applied. */
  stagedPicture(person: string, id: string): { bytes: Uint8Array; mime: string } | null {
    this.sweep();
    const p = this.stages.get(person)?.mod.theme?.pictures.find(x => x.id === id);
    return p ? { bytes: p.kept, mime: MEDIA_MIME[p.kind] } : null;
  }
  abort(person: string, stage: unknown): ModWrite {
    const s = this.stages.get(person);
    if (!s || s.id !== stage) return { ok: false, status: 404, error: "unknown_stage" };
    this.drop(person);
    return { ok: true };
  }

  /**
   * Step 1: check the uploaded file whole and keep it, with its plan, for this person (one stage each: a new one
   * replaces theirs). Nothing is applied.
   */
  stage(person: string, text: string, from: { proposal?: string } = {}): ModWrite<{ stage: string; plan: ModPlan; plan_hash: string }> {
    this.sweep();
    const idx = this.load();
    if (idx === "unreadable") return { ok: false, status: 503, error: "mods_unreadable" };
    const checked = checkModBundle(text, this.deps.context());
    if (!checked.ok) return { ok: false, status: 400, error: "mod_invalid", problems: checked.problems };
    const mod = checked.mod;
    // Provenance is the path the bytes came in by: what an agent proposed never carries custom CSS (r4 §4).
    if (from.proposal !== undefined && mod.ownerCss) return { ok: false, status: 400, error: "owner_css_not_from_agent" };
    const plan = modPlan(mod, idx.mods);
    if (!plan.mod.installed && !plan.mod.replaces) {
      if (idx.mods.size >= MODS_MAX_INSTALLED) return { ok: false, status: 409, error: "mods_quota", detail: `at most ${MODS_MAX_INSTALLED} installed` };
      const total = [...idx.mods.values()].reduce((n, r) => n + r.bytes, 0);
      if (total + mod.bytes > MODS_MAX_BYTES) return { ok: false, status: 409, error: "mods_quota", detail: `at most ${MODS_MAX_BYTES / 1024 / 1024} MiB installed` };
    }
    this.drop(person);
    let effects: Stage["effects"];
    if (mod.effects.length) {
      if (!this.deps.effects) return { ok: false, status: 400, error: "effects_unavailable" };
      // The installed mod has one effect-holder principal. Reapplying its immutable bytes must not acquire an
      // untracked claim for the next person. A mod whose effects were never selected gets its owner when selected.
      const installed = idx.mods.get(mod.id);
      const owner = installed?.effects.length ? installed.effectsBy ?? installed.installedBy : person;
      const r = this.deps.effects.stage(mod.effects.map(e => e.files), { kind: "human", id: owner }, { holder: modHolder(mod.id) });
      if (!r.ok) return { ok: false, status: 409, error: "effects_refused", detail: r.error };
      effects = { stageId: r.stageId, ids: r.ids, owner };
    }
    const planHash = sha32(canonicalJson(plan));
    const s: Stage = { id: randomBytes(16).toString("hex"), person, mod, text, plan, planHash, at: this.clock(), ...(effects ? { effects } : {}), ...(from.proposal !== undefined ? { proposal: from.proposal } : {}) };
    this.stages.set(person, s);
    return { ok: true, stage: s.id, plan, plan_hash: planHash };
  }

  /**
   * Step 2: apply exactly the staged plan's chosen parts, atomically. `person`: the signed-in session's person (their
   * own CSS goes to them); the sidebar widget is a preference of the page's one bucket. A changed plan hash is 409; an
   * unknown or expired stage is 404.
   */
  commit(person: string, body: { stage?: unknown; plan_hash?: unknown; include?: unknown; target?: unknown }): ModWrite<{ id: string; applied: string[]; css?: { trial: string; sha: string; previous: string | null } }> {
    this.sweep();
    const s = this.stages.get(person);
    if (!s || s.id !== body.stage) return { ok: false, status: 404, error: "unknown_stage" };
    if (body.plan_hash !== s.planHash) return { ok: false, status: 409, error: "plan_changed" };
    const include = parseInclude(body.include);
    if (!include) return { ok: false, status: 400, error: "include", detail: "{ theme?, identity?, effects?, ownerCss?, widgets?: { chat_header?, details?, sidebar? }, replace? } of booleans" };
    const mod = s.mod;
    const want = {
      theme: !!(include.theme && mod.theme), identity: !!(include.identity && mod.identity), effects: !!(include.effects && mod.effects.length),
      ownerCss: !!(include.ownerCss && mod.ownerCss),
      widgets: AGENT_WIDGET_SLOTS.filter(slot => include.widgets?.[slot] && mod.widgets[slot]),
      sidebar: !!(include.widgets?.sidebar && mod.widgets.sidebar),
    };
    // Effect placements ride with the theme, and need the effects installed.
    if (want.theme && mod.theme?.effects.length && !want.effects) return { ok: false, status: 400, error: "include", detail: "the theme places this mod's effects: include effects too" };
    const toInstance = want.theme || want.identity || want.widgets.length > 0;
    let target: string | undefined;
    if (toInstance) {
      if (typeof body.target !== "string" || !this.deps.isKnownInstance(body.target)) return { ok: false, status: 400, error: "target", detail: "an instance of this fleet" };
      target = body.target;
    }
    if (want.ownerCss && !this.deps.ownerCss) return { ok: false, status: 404, error: "owner_css_unavailable" };
    if (!toInstance && !want.effects && !want.ownerCss && !want.sidebar) return { ok: false, status: 400, error: "include", detail: "nothing chosen" };
    const idx = this.load();
    if (idx === "unreadable") return { ok: false, status: 503, error: "mods_unreadable" };
    const replaces = s.plan.mod.replaces;
    // What was installed may have moved since this plan was staged (another person's import, an uninstall): the plan
    // — and so the consent — is for the state it showed. Checked again here, before anything is changed.
    const sameName = [...idx.mods].find(([id, r]) => r.name === mod.manifest.name && id !== mod.id);
    if ((sameName?.[0] ?? null) !== (replaces?.id ?? null) || idx.mods.has(mod.id) !== s.plan.mod.installed) {
      return { ok: false, status: 409, error: "plan_changed", detail: "the installed mods changed since this file was checked: import it again" };
    }
    const installed = idx.mods.get(mod.id);
    const effectOwner = installed?.effects.length ? installed.effectsBy ?? installed.installedBy : person;
    if (want.effects && s.effects?.owner !== effectOwner) {
      return { ok: false, status: 409, error: "plan_changed", detail: "the effect claim owner changed: import it again" };
    }
    if (replaces && !include.replace) return { ok: false, status: 409, error: "replaces", detail: `version ${replaces.version} of ${mod.manifest.name} is installed: confirm replace` };
    if (!idx.mods.has(mod.id)) {
      const others = [...idx.mods].filter(([id]) => id !== replaces?.id).map(([, r]) => r);
      if (others.length + 1 > MODS_MAX_INSTALLED) return { ok: false, status: 409, error: "mods_quota", detail: `at most ${MODS_MAX_INSTALLED} installed` };
      if (others.reduce((n, r) => n + r.bytes, 0) + mod.bytes > MODS_MAX_BYTES) return { ok: false, status: 409, error: "mods_quota", detail: `at most ${MODS_MAX_BYTES / 1024 / 1024} MiB installed` };
    }

    const undo: Array<() => void> = [];
    const rollback = (status: number, error: string, detail?: string): ModWrite<never> => {
      for (const u of undo.reverse()) { try { u(); } catch { /* best effort: each step undoes its own */ } }
      return { ok: false, status, error, ...(detail ? { detail } : {}) };
    };
    // Everything below either completes or is undone: a participant that throws (a real filesystem failure) is caught
    // here, inside the rollback boundary, as one that answers with an error.
    try {
      const applied: string[] = [];
      let created: string[] = [];
      let effectIds = new Map<string, string>();
      if (want.effects && s.effects && this.deps.effects) {
        const r = this.deps.effects.commit(s.effects.stageId);
        if (!r.ok) return rollback(409, "effects_refused", r.error);
        undo.push(() => { r.undo(); });
        created = r.created;
        effectIds = new Map(mod.effects.map((e, i) => [e.path, r.ids[i]!]));
        applied.push("effects");
      }
      let finalize: (() => void) | null = null;
      if (target) {
        const t = mod.theme;
        const w = this.deps.themes.applyLook(target, {
          ...(want.theme && t ? { theme: t.theme } : {}),
          ...(want.identity && mod.identity ? { identity: mod.identity } : {}),
          pictures: want.theme && t ? t.pictures.map(p => ({ slot: p.slot, id: p.id, kind: p.kind, kept: p.kept })) : [],
          widgets: Object.fromEntries(want.widgets.map(slot => [slot, mod.widgets[slot]!])),
          ...(want.theme && t && t.effects.length ? { effects: t.effects.map(e => ({ id: effectIds.get(e.effect)!, params: e.params })) } : {}),
        }, "human");
        if (!w.ok) return rollback(w.status, w.error, w.detail);
        undo.push(() => { w.undo(); });
        finalize = w.finalize;
        if (want.theme) applied.push("theme");
        if (want.identity) applied.push("identity");
        for (const slot of want.widgets) applied.push(`widget:${slot}`);
      }
      if (want.sidebar) {
        const who = this.deps.prefsIdentity;
        const before = this.deps.prefs.read(who);
        if (before.unreadable) return rollback(503, "prefs_unreadable");
        const had = Object.hasOwn(before.values, "widget.sidebar") ? before.values["widget.sidebar"] : null;
        const w = this.deps.prefs.write(who, new Map([["widget.sidebar", mod.widgets.sidebar]]));
        if (!w.ok) return rollback(w.status, w.error);
        undo.push(() => { this.deps.prefs.write(who, new Map([["widget.sidebar", had]])); });
        applied.push("widget:sidebar");
      }
      let css: { trial: string; sha: string; previous: string | null } | undefined;
      if (want.ownerCss && mod.ownerCss && this.deps.ownerCss) {
        const store = this.deps.ownerCss;
        // Undo puts back exactly what was there — the version in force, a trial already running, history and assets —
        // never just "revert the trial this import started" (#1897 review).
        const snap = store.snapshot(person);
        undo.push(() => { store.restoreSnapshot(person, snap); });
        for (const a of mod.ownerCss.assets) {
          const r = store.addAsset(person, a.kept);
          if (!r.ok) return rollback(r.status, r.error, r.detail);
          if (r.id !== a.id) return rollback(500, "owner_css_asset_id", `${a.path}: ${r.id} ≠ ${a.id}`);
        }
        const saved = store.save(person, mod.ownerCss.text);
        if (!saved.ok) return rollback(saved.status, saved.error, saved.detail);
        css = { trial: saved.trial, sha: saved.sha, previous: saved.previous };
        applied.push("ownerCss");
      }

      // The index: this mod in, the one it replaces out. The old mod's effect claim is released LAST (below): one library
      // write per rollback chain, so the new commit's undo always meets the exact state it left (CW1, agreed with Sol).
      const mods = new Map(idx.mods);
      const old = replaces ? mods.get(replaces.id) : undefined;
      if (replaces) mods.delete(replaces.id);
      const prev = mods.get(mod.id);
      mods.set(mod.id, {
        name: mod.manifest.name, version: mod.manifest.version, title: mod.manifest.title, bytes: mod.bytes,
        installedBy: prev?.installedBy ?? person, installedAt: prev?.installedAt ?? this.now(),
        ...(want.effects ? { effectsBy: effectOwner } : prev?.effectsBy ? { effectsBy: prev.effectsBy } : {}),
        ...(target ? { target } : prev?.target ? { target: prev.target } : {}),
        parts: [...new Set([...(prev?.parts ?? []), ...applied])],
        effects: mod.effects.map(e => ({ path: e.path, id: effectIds.get(e.path) ?? prev?.effects.find(x => x.path === e.path)?.id ?? "" })).filter(e => e.id),
        created: [...new Set([...(prev?.created ?? []), ...created])],
      });
      try {
        mkdirSync(join(this.dataDir, "web-mods"), { recursive: true, mode: 0o700 });
        if (!prev) atomicWriteFileSync(this.file(mod.id), s.text, { mode: 0o600 });
      } catch (err) { return rollback(503, "mods_write_failed", (err as Error).message); }
      if (!prev) undo.push(() => { try { unlinkSync(this.file(mod.id)); } catch { /* none */ } });
      // A reviewed proposal is done once installed (the same write).
      let proposals: Map<string, ModProposal> | undefined;
      if (s.proposal !== undefined && idx.proposals.get(s.proposal)?.id === mod.id) { proposals = new Map(idx.proposals); proposals.delete(s.proposal); }
      const w = this.commitIndex(mods, proposals);
      if (!w.ok) return rollback(w.status, w.error, w.detail);
      undo.push(() => { this.commitIndex(idx.mods, idx.proposals); });
      // The last fallible step: the replaced mod's effect claim. Refused: every store above is restored first, then the
      // new library commit is undone (rollback runs in reverse). Released: nothing fallible follows.
      let releasedOld: string[] = [];
      if (replaces && old && old.effects.length && this.deps.effects) {
        const r = this.deps.effects.releaseHolder(modHolder(replaces.id), { kind: "human", id: old.effectsBy ?? old.installedBy });
        if (!r.ok) return rollback(409, "effects_release_refused", r.error);
        releasedOld = r.released;
      }
      if (proposals) { try { unlinkSync(this.proposalFile(s.proposal!)); } catch { /* already gone */ } }
      // Held: what the import replaced may go now, and the stage is done.
      finalize?.();
      if (replaces) { try { unlinkSync(this.file(replaces.id)); } catch { /* already gone */ } }
      if (releasedOld.length) this.deps.effects?.collectUnreferenced?.(releasedOld);
      if (s.effects && !want.effects) this.deps.effects?.abort(s.effects.stageId);   // staged, not chosen: let it go
      this.stages.delete(person);
      return { ok: true, id: mod.id, applied, ...(css ? { css } : {}) };
    } catch (err) { return rollback(503, "mod_apply_failed", (err as Error).message); }
  }

  /** Remove an installed mod from the library: its effect claim, its file and its entry. What it applied stays. */
  uninstall(id: unknown): ModWrite<{ released: string[] }> {
    const idx = this.load();
    if (idx === "unreadable") return { ok: false, status: 503, error: "mods_unreadable" };
    if (typeof id !== "string" || !idx.mods.has(id)) return { ok: false, status: 404, error: "no_such_mod" };
    const rec = idx.mods.get(id)!;
    let released: string[] = [];
    let undo: (() => boolean) | null = null;
    if (rec.effects.length) {
      if (!this.deps.effects) return { ok: false, status: 503, error: "effects_unavailable" };
      const r = this.deps.effects.releaseHolder(modHolder(id), { kind: "human", id: rec.effectsBy ?? rec.installedBy });
      if (!r.ok) return { ok: false, status: 409, error: "effects_release_refused", detail: r.error };
      released = r.released; undo = r.undo;
    }
    const mods = new Map(idx.mods);
    mods.delete(id);
    const w = this.commitIndex(mods);
    if (!w.ok) { undo?.(); return w; }
    try { unlinkSync(this.file(id)); } catch { /* already gone */ }
    if (released.length) this.deps.effects?.collectUnreferenced?.(released);
    return { ok: true, released };
  }

  /** An instance was removed: its name leaves the records that named it as their target. */
  forgetInstance(name: string): void {
    const idx = this.load();
    if (idx === "unreadable" || (![...idx.mods.values()].some(r => r.target === name) && !idx.proposals.has(name))) return;
    const mods = new Map([...idx.mods].map(([id, r]) => { if (r.target !== name) return [id, r]; const { target: _t, ...rest } = r; void _t; return [id, rest as ModRecord]; }));
    const proposals = new Map(idx.proposals); proposals.delete(name);
    if (this.commitIndex(mods, proposals).ok) { try { unlinkSync(this.proposalFile(name)); } catch { /* none */ } }
  }
  /** Tests: the folder bundles live in. */
  get folder(): string { return join(this.dataDir, "web-mods"); }
  /** Every installed bundle's file is removed with the index (tests and a reset). */
  clear(): void { try { rmSync(this.folder, { recursive: true, force: true }); } catch { /* none */ } }
}

function parseInclude(raw: unknown): ModInclude | null {
  if (!isObj(raw)) return null;
  const out: ModInclude = {};
  for (const [k, v] of Object.entries(raw)) {
    if (["theme", "identity", "effects", "ownerCss", "replace"].includes(k)) { if (typeof v !== "boolean") return null; (out as Record<string, unknown>)[k] = v; continue; }
    if (k !== "widgets" || !isObj(v)) return null;
    const w: NonNullable<ModInclude["widgets"]> = {};
    for (const [slot, on] of Object.entries(v)) {
      if (!["chat_header", "details", "sidebar"].includes(slot) || typeof on !== "boolean") return null;
      w[slot as AgentWidgetSlot | "sidebar"] = on;
    }
    out.widgets = w;
  }
  return out;
}
