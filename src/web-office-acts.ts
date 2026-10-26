/**
 * #2578: an agent sees and directs its own character in Fleet → Org chart → Office — office_view (the stored offices
 * it is in: who is there, in what state, and the spots it may walk to) and office_set (walk to a seat, a waypoint or a
 * person; say a line; hold a pose; for a few seconds). Its own only: the caller is the instance its IPC connection or
 * agent token belongs to, never anything the call says. The `office` dashboard feature (dashboard-permissions.ts) is
 * off until a person switches it on; the fleet's sinks refuse both tools before they reach here.
 *
 * An act is kept in memory, one per instance (a new office_set replaces it; `clear` ends it; a fleet restart forgets
 * them all), and is live while `until` is ahead (wall clock, the page's): every change — set, clear, expiry — goes to
 * every page as the `office_acts` SSE event, and GET /ui/office-acts reads the same list. The page draws it until new
 * work begins (fleet-office.js actLive: the turn it was set in, and idle after it, keep it; working again after that, or
 * after acting while idle, ends it), its instance is called or asleep, or bedtime puts it to bed: an act never hides real
 * work.
 *
 * Spots come from the office's skin: a pack the host keeps (web-office-skins.ts), with the office's layout overrides on
 * it (applyOverrides — the page's own rule); a built-in style (pixel, studio) or a pack without stateZones draws desks,
 * with none: there the line and the pose show, and `go` is refused (nobody walks; review). A seat is "area:index", its
 * index in the area's seat list from 0, as office_view lists it.
 *
 * office_set is limited per instance (OfficeActLimiter: 6 a minute, 60 an hour, monotonic, memory only), like the
 * appearance limiter: checked before anything is validated, counted only once the act is in place; a refusal says when
 * the next call may come (cooldown_ms). office_view is not limited.
 */
import { applyOverrides, fitNight, fitSeatFor, type CheckedPack } from "./ui/fleet-office-pack.js";
import type { Office } from "./web-office-store.js";
import { OfficeSetArgs, OfficeViewArgs, validateArgs } from "./outbound-schemas.js";

export const OFFICE_ACT_LIMITS = { perMinute: 6, perHour: 60, say: 40, minSeconds: 5, maxSeconds: 120, defaultSeconds: 30 } as const;
export const OFFICE_POSES = ["idle", "working", "needs", "paused"] as const;
export type OfficePose = typeof OFFICE_POSES[number];
const MINUTE_MS = 60_000, HOUR_MS = 60 * MINUTE_MS;
// Control characters, line breaks, and the invisible and direction-changing ones (zero-width, bidi embeddings/isolates).
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

/** One instance's act: where it walks (a point, or a person the page finds), what it says, how it stands, and until when. */
export interface OfficeAct {
  instance: string; office: string; x?: number; y?: number; person?: string; say?: string; pose?: OfficePose;
  /** Wall-clock ms: when it was set, and when it ends. */
  since: number; until: number;
  /** The instance's dashboard state when it was set: set while idle, working is new work and ends it (actLive). */
  state: string;
}
export interface OfficeSpots {
  seats: Array<{ area: string; index: number; x: number; y: number }>;
  waypoints: Array<{ id: string; x: number; y: number }>;
  npcs: Array<{ id: string; label: string | null; x: number; y: number }>;
  door: { x: number; y: number } | null;
}
/** `walks`: a zones style, where characters walk; on desks (false) only say and pose show. */
export interface OfficeSeen { id: string; name: string; skin: string; walks: boolean; members: Array<{ name: string; display_name?: string; state: string }>; spots: OfficeSpots }
/** The chart an office's members are read against: every instance the dashboard lists, and fleet.yaml's teams. */
export interface OfficeChart { names: readonly string[]; teams: ReadonlyArray<{ name: string; members: readonly string[] }> }
export interface OfficeActsDeps {
  /** The stored offices (web-office-store.ts; none when its file is unreadable). */
  offices(): Office[];
  /** A pack the host keeps, checked, or null (a built-in style, or a pack since deleted). */
  pack(id: string): CheckedPack | null;
  chart(): OfficeChart;
  /**
   * A snapshot of the people, read once per call: an instance's dashboard state as the org chart shows it (fleet-org.js
   * orgState: needs, crashed, stuck, starting, queued, working, idle, paused, stopped, missing) and its display name.
   */
  people(): { stateOf(name: string): string; displayName(name: string): string | undefined };
  /** The live acts changed: every page hears it (`office_acts`). */
  changed(acts: OfficeAct[]): void;
}
export type OfficeAnswer = Record<string, unknown>;

/**
 * A stored office's members, as the page reads them (fleet-office-model.js membersOf): instance names, or `team:<name>`
 * for a team's members; none means everyone the dashboard lists. A name the chart does not have is left out.
 */
export function officeMembers(office: Pick<Office, "members">, chart: OfficeChart): string[] {
  const listed = new Set([...chart.names, ...chart.teams.flatMap(t => t.members)]);
  if (!office.members.length) return [...listed];
  const out: string[] = [];
  for (const m of office.members) {
    const team = m.startsWith("team:") ? chart.teams.find(t => t.name === m.slice(5)) : undefined;
    for (const n of team ? team.members : listed.has(m) ? [m] : []) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Whether an office's style walks its people (a pack with stateZones, as the page's `zones`); else it draws desks. */
export const officeWalks = (pack: CheckedPack | null): boolean => !!pack?.stateZones;

/** The spots of an office's skin: a kept zones pack's, with the office's overrides on it; a desks style's are none. */
export function officeSpots(office: Pick<Office, "skin" | "overrides">, pack: CheckedPack | null): OfficeSpots {
  if (!pack || !officeWalks(pack)) return { seats: [], waypoints: [], npcs: [], door: null };
  const applied = applyOverrides(pack, fitSeatFor(pack, fitNight(pack, office.overrides ?? null)));   // #2665/#2691: a night place or seat the pack lost: left out
  const p = applied.ok ? applied.pack : pack;
  return {
    seats: Object.values(p.areas).flatMap(a => a.seats.map((s, index) => ({ area: a.name, index, x: s.x, y: s.y }))),
    waypoints: p.waypoints.map(w => ({ id: w.id, x: w.x, y: w.y })),
    npcs: p.furniture.map(f => ({ id: f.id, label: f.label ?? null, x: f.x, y: f.y })),
    door: { x: p.door.x, y: p.door.y },
  };
}

/** How often one instance may call office_set: 6 a minute and 60 an hour, accepted calls only (monotonic clock). */
export class OfficeActLimiter {
  private readonly calls = new Map<string, number[]>();
  constructor(private readonly now: () => number = () => performance.now(), private readonly limits: { perMinute: number; perHour: number } = OFFICE_ACT_LIMITS) {}
  private recent(instance: string, now: number): number[] {
    const kept = (this.calls.get(instance) ?? []).filter(t => now - t < HOUR_MS);
    if (kept.length) this.calls.set(instance, kept); else this.calls.delete(instance);
    return kept;
  }
  /** Ms until `instance` may call again (0: now). Changes nothing. */
  waitMs(instance: string): number {
    const now = this.now(), kept = this.recent(instance, now), waits = [0];
    const minute = kept.filter(t => now - t < MINUTE_MS);
    if (minute.length >= this.limits.perMinute) waits.push(MINUTE_MS - (now - minute[minute.length - this.limits.perMinute]!));
    if (kept.length >= this.limits.perHour) waits.push(HOUR_MS - (now - kept[kept.length - this.limits.perHour]!));
    return Math.max(0, Math.ceil(Math.max(...waits)));
  }
  /** Count an accepted call. */
  record(instance: string): void { const now = this.now(); this.calls.set(instance, [...this.recent(instance, now), now]); }
  forget(instance: string): void { this.calls.delete(instance); }
}

const refuse = (error: string, message: string, extra: Record<string, unknown> = {}): OfficeAnswer => ({ error, message, ...extra });

export class OfficeActs {
  readonly limiter: OfficeActLimiter;
  private readonly acts = new Map<string, OfficeAct>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The wall clock an act's since / until are on (the page's). */
  private readonly now: () => number;
  constructor(private readonly deps: OfficeActsDeps, opts: { limiter?: OfficeActLimiter; now?: () => number } = {}) {
    this.limiter = opts.limiter ?? new OfficeActLimiter();
    this.now = opts.now ?? (() => Date.now());
  }

  /** Drop the acts that ended; true when one did. */
  private prune(): boolean {
    const now = this.now();
    let dropped = false;
    for (const [name, act] of this.acts) if (act.until <= now) { this.acts.delete(name); dropped = true; }
    return dropped;
  }
  /** One timer, for the next act to end: it is dropped then and every page hears it. */
  private schedule(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.acts.size) return;
    const next = Math.min(...[...this.acts.values()].map(a => a.until));
    this.timer = setTimeout(() => { this.timer = null; if (this.prune()) this.announce(); else this.schedule(); }, Math.max(0, next - this.now()) + 5);
    this.timer.unref?.();
  }
  private announce(): void {
    this.schedule();
    try { this.deps.changed(this.live()); } catch { /* a page reads GET /ui/office-acts on opening */ }
  }

  /** The live acts (until ahead), the most recently set last: GET /ui/office-acts and the `office_acts` event. */
  live(): OfficeAct[] {
    if (this.prune()) queueMicrotask(() => this.announce());
    return [...this.acts.values()].map(a => ({ ...a }));
  }
  /** This instance's live act, or null. */
  actOf(instance: string): OfficeAct | null {
    const a = this.acts.get(instance);
    return a && a.until > this.now() ? { ...a } : null;
  }

  /** The stored offices `instance` is a member of, in their stored order. */
  private officesOf(instance: string): Office[] {
    const chart = this.deps.chart();
    return this.deps.offices().filter(o => officeMembers(o, chart).includes(instance));
  }
  private seen(o: Office, people: ReturnType<OfficeActsDeps["people"]>): OfficeSeen {
    const members = officeMembers(o, this.deps.chart()).map(name => {
      const display = people.displayName(name);
      return { name, ...(display ? { display_name: display } : {}), state: people.stateOf(name) };
    });
    const pack = this.deps.pack(o.skin);
    return { id: o.id, name: o.name, skin: o.skin, walks: officeWalks(pack), members, spots: officeSpots(o, pack) };
  }
  /** The office a call names, or the only one it is in; else a refusal naming them. */
  private pick(wanted: string | undefined, mine: Office[]): { office: Office } | { refused: OfficeAnswer } {
    if (!mine.length) return { refused: refuse("no_office", "You are in no stored office (Fleet → Org chart → Office): a person adds you to one first.") };
    const ids = mine.map(o => `${o.id} (${o.name})`).join(", ");
    if (wanted !== undefined) {
      const o = mine.find(m => m.id === wanted);
      return o ? { office: o } : { refused: refuse("office", `You are not in an office "${wanted}". Yours: ${ids}.`) };
    }
    if (mine.length > 1) return { refused: refuse("office_required", `You are in ${mine.length} offices; name one with office: ${ids}.`) };
    return { office: mine[0]! };
  }

  /** office_view { office? }: the offices it is in, its act and when office_set may be called again. */
  view(instance: string, raw: Record<string, unknown>): OfficeAnswer {
    const v = validateArgs(OfficeViewArgs, raw ?? {}, "office_view");
    if (!v.ok) return refuse("invalid", v.error);
    let shown = this.officesOf(instance);
    if (v.data.office !== undefined) {
      const one = this.pick(v.data.office, shown);
      if ("refused" in one) return one.refused;
      shown = [one.office];
    }
    const people = this.deps.people();
    return { offices: shown.map(o => this.seen(o, people)), act: this.actOf(instance), cooldown_ms: this.limiter.waitMs(instance) };
  }

  /** office_set { office?, go?, say?, pose?, seconds?, clear? }: its own act, placed (replacing one), or cleared. */
  set(instance: string, raw: Record<string, unknown>): OfficeAnswer {
    const wait = this.limiter.waitMs(instance);
    if (wait > 0) return refuse("rate_limited", `Too many office_set calls (at most ${OFFICE_ACT_LIMITS.perMinute} a minute, ${OFFICE_ACT_LIMITS.perHour} an hour); try again in ${Math.ceil(wait / 1000)} s.`, { cooldown_ms: wait });
    const v = validateArgs(OfficeSetArgs, raw ?? {}, "office_set");
    if (!v.ok) return refuse("invalid", v.error);
    const a = v.data;
    const targets = a.go ? (["seat", "waypoint", "person"] as const).filter(k => a.go![k] !== undefined) : [];
    if (a.go && targets.length !== 1) return refuse("go", "go: exactly one of seat, waypoint or person.");
    if (a.clear !== undefined && a.clear !== true) return refuse("clear", "clear: true, or leave it out.");
    if (a.clear && (a.go || a.say !== undefined || a.pose || a.seconds !== undefined)) return refuse("clear", "clear: true goes alone.");
    if (!a.clear && !a.go && a.say === undefined && !a.pose) return refuse("nothing", "Nothing to do: give go, say or pose (or clear: true).");
    let say: string | undefined;
    if (a.say !== undefined) {
      say = a.say.trim();
      if (!say || [...say].length > OFFICE_ACT_LIMITS.say || CONTROL.test(say)) return refuse("say", `say: 1–${OFFICE_ACT_LIMITS.say} characters on one line, no control characters.`);
    }
    if (a.seconds !== undefined && (!Number.isFinite(a.seconds) || a.seconds < OFFICE_ACT_LIMITS.minSeconds || a.seconds > OFFICE_ACT_LIMITS.maxSeconds)) {
      return refuse("seconds", `seconds: ${OFFICE_ACT_LIMITS.minSeconds} to ${OFFICE_ACT_LIMITS.maxSeconds}.`);
    }
    const mine = this.officesOf(instance);
    if (a.clear) {
      // Ending its own act needs nothing else: not an office named, not even being in one still (it may have been taken
      // out of every office since it acted).
      const had = this.acts.delete(instance);
      this.limiter.record(instance);
      if (had) this.announce();
      return { cleared: had, act: null, cooldown_ms: this.limiter.waitMs(instance) };
    }
    const picked = this.pick(a.office, mine);
    if ("refused" in picked) return picked.refused;
    const o = picked.office;
    let point: { x: number; y: number } | undefined, person: string | undefined;
    if (a.go) {
      const pack = this.deps.pack(o.skin);
      // A desks style (a built-in one, or a pack without stateZones) walks nobody: refused, not accepted to do nothing (review).
      if (!officeWalks(pack)) return refuse("go", `go: ${o.id} is drawn as desks (its style "${o.skin}"): nobody walks there. say and pose still show.`);
      const spots = officeSpots(o, pack);
      if (a.go.seat !== undefined) {
        const m = /^([A-Za-z0-9_-]{1,40}):(\d{1,3})$/.exec(a.go.seat), seat = m ? spots.seats.find(s => s.area === m[1] && s.index === Number(m[2])) : undefined;
        if (!seat) return refuse("seat", spots.seats.length ? `go.seat: "${a.go.seat}" is not a seat of ${o.id}; office_view lists them as "area:index".` : `go.seat: ${o.id} has no seats to walk to (its style "${o.skin}" has none).`);
        point = { x: seat.x, y: seat.y };
      } else if (a.go.waypoint !== undefined) {
        const w = spots.waypoints.find(p => p.id === a.go!.waypoint);
        if (!w) return refuse("waypoint", spots.waypoints.length ? `go.waypoint: "${a.go.waypoint}" is not a waypoint of ${o.id}; office_view lists them.` : `go.waypoint: ${o.id} has no waypoints.`);
        point = { x: w.x, y: w.y };
      } else {
        const who = a.go.person!;
        if (who === instance) return refuse("person", "go.person: someone other than you.");
        if (!officeMembers(o, this.deps.chart()).includes(who)) return refuse("person", `go.person: "${who}" is not in ${o.id}; office_view lists its members.`);
        person = who;
      }
    }
    const since = this.now(), seconds = a.seconds ?? OFFICE_ACT_LIMITS.defaultSeconds;
    const act: OfficeAct = { instance, office: o.id, ...(point ?? {}), ...(person ? { person } : {}), ...(say ? { say } : {}), ...(a.pose ? { pose: a.pose } : {}),
      since, until: since + Math.round(seconds * 1000), state: this.deps.people().stateOf(instance) };
    this.acts.delete(instance);                                     // the newest last
    this.acts.set(instance, act);
    this.limiter.record(instance);
    this.announce();
    return { act: { ...act }, cooldown_ms: this.limiter.waitMs(instance) };
  }

  /** An instance was removed: its act and its counters go. */
  forget(instance: string): void { this.limiter.forget(instance); if (this.acts.delete(instance)) this.announce(); }
  /** Stop the expiry timer (the fleet stopping; a test). */
  close(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  /** The dispatcher both doors share (typed IPC from the daemon, the agent endpoint for agend-agent). */
  handle(instance: string, tool: string, args: Record<string, unknown>): OfficeAnswer {
    if (tool === "office_view") return this.view(instance, args);
    if (tool === "office_set") return this.set(instance, args);
    return { error: "unknown_tool" };
  }
}
