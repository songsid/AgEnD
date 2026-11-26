/**
 * M-3770 slice 2.1b (design update-transaction §3.1–3.3): what an attempt may act on, and what each stage expects to
 * find there.
 *
 * - **Ownership** (§3.1) is invariant for the whole attempt: the uid, the home, the npm prefix and package path (the
 *   path, not its contents), and the service unit with its fragment. It is proven when the attempt opens, under the
 *   locks, and re-proven before every mutation. A mismatch, or an ownership that can't be proven, never authorizes a
 *   mutation: before anything is installed the attempt is abandoned; from `installing` on, it goes to manual-recovery.
 * - **Expected artifact tuples** (§3.2): `expected.old` at open, `expected.new` after the install verifies, and the
 *   forward-install `intent` journaled before npm runs. Each stage compares the live tuple with the one it expects;
 *   anything else goes to manual-recovery.
 * - **Fleet generations** (§3.3): stopping a fleet requires it to be the recorded generation the stage expects.
 *
 * These live in the attempt record's fields that update-journal.ts keeps opaque; every reader here validates their
 * shape, and a malformed one is "can't be proven" — never a pass. All I/O goes through `OwnershipDeps`.
 */
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { substep, type Artifact, type AttemptRecord, type FleetGeneration, type JournalIo, defaultJournalIo, type Stage } from "./update-journal.js";

export const PACKAGE_NAME = "@songsid/agend";
export const BIN_NAMES = ["agend", "agend-agent"] as const;
export type BinName = (typeof BIN_NAMES)[number];

export interface OwnedService { kind: "systemd" | "launchd"; unit: string; fragmentPath: string }

/** §3.1: every path a realpath, proven at open and before each mutation. */
export interface Ownership {
  uid: number;
  home: string;
  prefix: string;
  /**
   * `<root>/@songsid/agend`: the path, not its contents (they change across the attempt). Its ancestors are resolved
   * (Prism #4502 2): a symlinked `node_modules` or scope directory that moves changes this path, so re-proof sees it.
   */
  packagePath: string;
  /** Where the bin links live, their directory resolved the same way. */
  binLinks: Record<BinName, string>;
  service: OwnedService | null;
}

/** §3.2: what a stage expects to find installed and wired. */
export interface ArtifactTuple {
  version: string;
  integrity: string | null;
  /** The realpath each bin link resolves to; null when the link is absent. */
  bins: Record<BinName, string | null>;
  /** The realpath of `<packagePath>/dist/cli.js`. */
  entry: string;
  /** The realpath of the Node the entry runs on. */
  interpreter: string;
  /** The service's ExecStart / ProgramArguments, argv exactly; null when the attempt owns no service. */
  execStart: string[] | null;
}

/** §3.2 rev 3: journaled (stage `installing`, substep `intent`) before npm runs, with the preimage already verified. */
export interface InstallIntent {
  preimage: { dir: string; manifestSha256: string };
  destination: { packagePath: string; binLinks: string[] };
  target: Artifact;
  command: string[];
}

export interface OwnershipDeps {
  uid(): number;
  /** The realpath of `path`, or null when it (or its target) is absent or unreadable. */
  realpath(path: string): string | null;
  /** Does `path` itself exist (a dangling link counts)? */
  lexists(path: string): boolean;
  /** A symlink's target as an absolute path (resolved against the link's directory, not followed); null if not a link. */
  linkTarget(path: string): string | null;
  /** The uid owning `path` (followed), or null. */
  ownerUid(path: string): number | null;
  readFile(path: string): string | null;
  /**
   * The realpath of the Node this install runs on, proven independently of the package's own files (the service
   * definition's PATH or explicit interpreter, as service-activation proves it), or null. A half-written package must
   * not lose this proof (Prism #4502 3).
   */
  interpreterFor(ownership: Ownership): string | null;
  /** The service's effective ExecStart / ProgramArguments, or null when it can't be read. */
  execStart(service: OwnedService): string[] | null;
  platform: NodeJS.Platform;
}

const fsRealpath = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };

/**
 * The filesystem half of the deps. `interpreterFor` and `execStart` come from the caller: the Node an install runs on
 * and what the service manager has loaded are proven where the update already proves them (service-activation.ts).
 */
export const fsOwnershipDeps = (rest: Pick<OwnershipDeps, "interpreterFor" | "execStart">): OwnershipDeps => ({
  uid: () => (typeof process.getuid === "function" ? process.getuid() : 0),
  realpath: fsRealpath,
  lexists: path => { try { lstatSync(path); return true; } catch { return false; } },
  linkTarget: path => { try { return resolve(dirname(path), readlinkSync(path)); } catch { return null; } },
  ownerUid: path => { try { return statSync(path).uid; } catch { return null; } },
  readFile: path => { try { return readFileSync(path, "utf8"); } catch { return null; } },
  platform: process.platform,
  ...rest,
});

/** npm's global layout: POSIX `<prefix>/lib/node_modules`, Windows `<prefix>/node_modules`. */
export const nodeModulesOf = (prefix: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");
export const binLinkOf = (prefix: string, name: BinName, platform: NodeJS.Platform): string =>
  platform === "win32" ? join(prefix, name) : join(prefix, "bin", name);

export type Proven<T> = { ok: true; value: T } | { ok: false; reason: string };

/** §3.1: prove the ownership the attempt will act on. Every part must resolve; home and prefix must be this uid's. */
export function proveOwnership(input: { home: string; prefix: string; service: OwnedService | null }, deps: OwnershipDeps): Proven<Ownership> {
  const uid = deps.uid();
  const home = deps.realpath(input.home);
  if (!home) return { ok: false, reason: `the home ${input.home} can't be resolved` };
  const prefix = deps.realpath(input.prefix);
  if (!prefix) return { ok: false, reason: `the npm prefix ${input.prefix} can't be resolved` };
  for (const [what, path] of [["home", home], ["npm prefix", prefix]] as const) {
    const owner = deps.ownerUid(path);
    if (owner === null) return { ok: false, reason: `the ${what} ${path}'s owner can't be read` };
    if (uid !== 0 && owner !== uid) return { ok: false, reason: `the ${what} ${path} belongs to uid ${owner}, not this user (${uid})` };
  }
  // The package path is a location under the prefix; whether its contents are there is the tuple's question. Its
  // ancestors are resolved: node_modules must exist; the scope directory may be absent (npm creates it), but never a
  // dangling link.
  const root = deps.realpath(nodeModulesOf(prefix, deps.platform));
  if (!root) return { ok: false, reason: `the npm prefix's ${nodeModulesOf(prefix, deps.platform)} can't be resolved` };
  const scopeLexical = join(root, PACKAGE_NAME.split("/")[0]!);
  const scope = deps.realpath(scopeLexical) ?? (deps.lexists(scopeLexical) ? null : scopeLexical);
  if (!scope) return { ok: false, reason: `${scopeLexical} is a link that resolves to nothing` };
  const packagePath = join(scope, PACKAGE_NAME.split("/")[1]!);
  const binDir = deps.realpath(dirname(binLinkOf(prefix, "agend", deps.platform)));
  if (!binDir) return { ok: false, reason: `the npm prefix's bin directory ${dirname(binLinkOf(prefix, "agend", deps.platform))} can't be resolved` };
  const binLinks = Object.fromEntries(BIN_NAMES.map(name => [name, join(binDir, basename(binLinkOf(prefix, name, deps.platform)))])) as Record<BinName, string>;
  let service: OwnedService | null = null;
  if (input.service) {
    const fragmentPath = deps.realpath(input.service.fragmentPath);
    if (!fragmentPath) return { ok: false, reason: `the service ${input.service.unit}'s definition ${input.service.fragmentPath} can't be resolved` };
    service = { kind: input.service.kind, unit: input.service.unit, fragmentPath };
  }
  return { ok: true, value: { uid, home, prefix, packagePath, binLinks, service } };
}

/** The fields where two ownerships differ (empty: the same). */
export function ownershipDiff(a: Ownership, b: Ownership): string[] {
  const diff: string[] = [];
  for (const key of ["uid", "home", "prefix", "packagePath"] as const) if (a[key] !== b[key]) diff.push(key);
  for (const name of BIN_NAMES) if (a.binLinks[name] !== b.binLinks[name]) diff.push(`binLinks.${name}`);
  const sa = a.service, sb = b.service;
  if ((sa === null) !== (sb === null)) diff.push("service");
  else if (sa && sb) for (const key of ["kind", "unit", "fragmentPath"] as const) if (sa[key] !== sb[key]) diff.push(`service.${key}`);
  return diff;
}

/** A tuple's live read: complete, or partial (what could be resolved, for the `installing` intent check). */
export type TupleRead =
  | { state: "complete"; tuple: ArtifactTuple }
  | { state: "partial"; reason: string; paths: string[]; interpreter: string | null; execStart: string[] | null };

/** The installed package's integrity, from npm's hidden lockfile (`<root>/.package-lock.json`); null when it records none. */
function integrityOf(ownership: Ownership, deps: OwnershipDeps): string | null {
  const text = deps.readFile(join(nodeModulesOf(ownership.prefix, deps.platform), ".package-lock.json"));
  if (!text) return null;
  try {
    const lock = JSON.parse(text) as { packages?: Record<string, { integrity?: unknown }> };
    const entry = lock.packages?.[`node_modules/${PACKAGE_NAME}`];
    return typeof entry?.integrity === "string" && entry.integrity ? entry.integrity : null;
  } catch { return null; }
}

/** §3.2: read the live tuple at the ownership's locations. */
export function readArtifactTuple(ownership: Ownership, deps: OwnershipDeps): TupleRead {
  const paths: string[] = [];
  const bins = {} as Record<BinName, string | null>;
  let dangling: string | null = null;
  for (const name of BIN_NAMES) {
    const link = ownership.binLinks[name];
    const real = deps.realpath(link);
    bins[name] = real;
    if (real) paths.push(real);
    else if (deps.lexists(link)) {
      dangling ??= link;
      const target = deps.linkTarget(link);
      paths.push(target ?? link);                       // a dangling link's own target must stay inside the destination too
    }
  }
  const entry = deps.realpath(join(ownership.packagePath, "dist", "cli.js"));
  if (entry) paths.push(entry);
  const interpreter = deps.interpreterFor(ownership);
  const execStart = ownership.service ? deps.execStart(ownership.service) : null;
  const partial = (reason: string): TupleRead => ({ state: "partial", reason, paths, interpreter, execStart });
  if (ownership.service && !execStart) return partial(`the service ${ownership.service.unit}'s ExecStart can't be read`);
  let manifest: { name?: unknown; version?: unknown } | null = null;
  try { manifest = JSON.parse(deps.readFile(join(ownership.packagePath, "package.json")) ?? "null"); } catch { manifest = null; }
  if (!manifest || manifest.name !== PACKAGE_NAME || typeof manifest.version !== "string" || !manifest.version) return partial("the package's manifest is missing or unreadable");
  if (!entry) return partial("the package has no dist/cli.js");
  if (!interpreter) return partial("the Node the package runs on can't be resolved");
  if (dangling) return partial(`the bin link ${dangling} resolves to nothing`);
  if (!bins.agend) return partial("the agend bin link is absent");
  return { state: "complete", tuple: { version: manifest.version, integrity: integrityOf(ownership, deps), bins, entry, interpreter, execStart } };
}

const sameArgv = (a: string[] | null, b: string[] | null) => (a === null || b === null ? a === b : a.length === b.length && a.every((x, i) => x === b[i]));

/** The fields where two tuples differ (empty: the same). */
export function tupleDiff(a: ArtifactTuple, b: ArtifactTuple): string[] {
  const diff: string[] = [];
  for (const key of ["version", "integrity", "entry", "interpreter"] as const) if (a[key] !== b[key]) diff.push(key);
  for (const name of BIN_NAMES) if (a.bins[name] !== b.bins[name]) diff.push(`bins.${name}`);
  if (!sameArgv(a.execStart, b.execStart)) diff.push("execStart");
  return diff;
}

// ── The journaled fields ─────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const strOrNull = (v: unknown) => v === null || nonEmpty(v);
const argvOrNull = (v: unknown) => v === null || (Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "string"));

function validOwnership(v: unknown): v is Ownership {
  if (!isObj(v) || !Number.isSafeInteger(v.uid) || (v.uid as number) < 0 || !nonEmpty(v.home) || !nonEmpty(v.prefix) || !nonEmpty(v.packagePath)) return false;
  const links = v.binLinks;
  if (!isObj(links) || !BIN_NAMES.every(name => nonEmpty(links[name])) || Object.keys(links).length !== BIN_NAMES.length) return false;
  if (v.service === null) return true;
  const s = v.service;
  return isObj(s) && (s.kind === "systemd" || s.kind === "launchd") && nonEmpty(s.unit) && nonEmpty(s.fragmentPath);
}

function validTuple(v: unknown): v is ArtifactTuple {
  if (!isObj(v) || !nonEmpty(v.version) || !strOrNull(v.integrity) || !nonEmpty(v.entry) || !nonEmpty(v.interpreter) || !argvOrNull(v.execStart)) return false;
  const bins = v.bins;
  return isObj(bins) && BIN_NAMES.every(name => strOrNull(bins[name])) && Object.keys(bins).every(k => (BIN_NAMES as readonly string[]).includes(k));
}

function validIntent(v: unknown): v is InstallIntent {
  if (!isObj(v) || !isObj(v.preimage) || !nonEmpty(v.preimage.dir) || !/^[0-9a-f]{64}$/.test(String(v.preimage.manifestSha256))) return false;
  const d = v.destination, t = v.target;
  if (!isObj(d) || !nonEmpty(d.packagePath) || !Array.isArray(d.binLinks) || !d.binLinks.every(nonEmpty)) return false;
  if (!isObj(t) || !nonEmpty(t.name) || !nonEmpty(t.version) || !strOrNull(t.integrity)) return false;
  return Array.isArray(v.command) && v.command.length > 0 && v.command.every(x => typeof x === "string");
}

export interface Identity { ownership: Ownership; expected: { old: ArtifactTuple; new?: ArtifactTuple }; intent?: InstallIntent }

/** The attempt's journaled identity, validated; null when any part is missing or malformed (never proven). */
export function identityOf(attempt: AttemptRecord): Identity | null {
  const expected = attempt.expected;
  if (!validOwnership(attempt.ownership) || !isObj(expected) || !validTuple(expected.old)) return null;
  if (expected.new !== undefined && !validTuple(expected.new)) return null;
  if (attempt.intent !== undefined && !validIntent(attempt.intent)) return null;
  return { ownership: attempt.ownership, expected: { old: expected.old, ...(expected.new ? { new: expected.new } : {}) }, ...(attempt.intent ? { intent: attempt.intent as InstallIntent } : {}) };
}

/**
 * The record fields an attempt opens with (`openAttempt`'s `extra`): the proven ownership, `expected.old`, and the
 * running fleet as generation `old` (its pid and nonce from fleet.lock), when there is one.
 */
export function openingIdentity(ownership: Ownership, old: ArtifactTuple, oldFleet: { pid: number; nonce: string } | null, at: Date): Record<string, unknown> {
  if (!validOwnership(ownership) || !validTuple(old)) throw new Error("the opening identity is malformed");
  const fleets: FleetGeneration[] = oldFleet ? [{ gen: "old", nonce: oldFleet.nonce, pid: oldFleet.pid, plannedAt: at.toISOString(), consumed: true }] : [];
  return { ownership, expected: { old }, fleets };
}

/** §3.2: before npm runs — stage `installing`, substep `intent`. The caller has verified the preimage. */
export function recordInstallIntent(home: string, attempt: AttemptRecord, intent: InstallIntent, io: JournalIo = defaultJournalIo): AttemptRecord {
  if (attempt.stage !== "installing") throw new Error(`attempt ${attempt.id}: the install intent is written in installing, not ${attempt.stage}`);
  if (attempt.intent !== undefined) throw new Error(`attempt ${attempt.id} already has an install intent`);
  if (!validIntent(intent)) throw new Error("the install intent is malformed");
  return substep(home, { ...attempt, intent }, "intent", io);
}

/** §3.2: after the install verifies — `expected.new`, once. */
export function recordExpectedNew(home: string, attempt: AttemptRecord, tuple: ArtifactTuple, io: JournalIo = defaultJournalIo): AttemptRecord {
  const id = identityOf(attempt);
  if (!id) throw new Error(`attempt ${attempt.id}'s identity is missing or malformed`);
  if (attempt.stage !== "installing") throw new Error(`attempt ${attempt.id}: expected.new is written in installing, not ${attempt.stage}`);
  if (id.expected.new) throw new Error(`attempt ${attempt.id} already has expected.new`);
  if (!validTuple(tuple)) throw new Error("the new tuple is malformed");
  return substep(home, { ...attempt, expected: { ...id.expected, new: tuple } }, "expected-new", io);
}

// ── §3.1–3.2: the per-stage check before a mutation ────────────────────────────────────────────────────────────

/** Stages before anything is installed: a failed proof abandons there. From `installing` on: manual-recovery. */
const BEFORE_INSTALL: ReadonlySet<Stage> = new Set<Stage>(["opened", "barrier", "stopping", "abandoning", "snapshotted"]);

export type StageCheck =
  | { ok: true; found: "old" | "new" | "partial" }
  | { ok: false; to: "abandon" | "manual-recovery"; reason: string };

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * Re-prove ownership and compare the live tuple with what `attempt.stage` expects (§3.2's table). `found: "partial"`
 * (only while installing, inside the intent's destination) authorizes exactly one thing: a restore from the preimage.
 * `rolling-back` takes `restoreSays` — what the restore's journaled substeps say is current (2.3).
 */
export function checkStage(attempt: AttemptRecord, live: { ownership: Proven<Ownership>; tuple: TupleRead }, restoreSays?: "old" | "new" | "partial"): StageCheck {
  const stage = attempt.stage;
  const fail = (reason: string): StageCheck => ({ ok: false, to: BEFORE_INSTALL.has(stage) ? "abandon" : "manual-recovery", reason });
  const id = identityOf(attempt);
  if (!id) return fail("the attempt's recorded ownership or expected tuples are missing or malformed");
  if (!live.ownership.ok) return fail(`ownership can't be proven: ${live.ownership.reason}`);
  const diff = ownershipDiff(id.ownership, live.ownership.value);
  if (diff.length) return fail(`ownership changed (${diff.join(", ")})`);

  const matches = (want: ArtifactTuple | undefined) => (want && live.tuple.state === "complete" && tupleDiff(want, live.tuple.tuple).length === 0);
  const found: "old" | "new" | null = matches(id.expected.old) ? "old" : matches(id.expected.new) ? "new" : null;
  const what = live.tuple.state === "complete" ? `found ${live.tuple.tuple.version}` : `found a partial package (${live.tuple.reason})`;

  if (BEFORE_INSTALL.has(stage)) return found === "old" ? { ok: true, found } : fail(`the install no longer matches expected.old (${what})`);
  if (stage === "trial" || stage === "proving" || stage === "committing") {
    if (!id.expected.new) return fail(`${stage} without expected.new`);
    return found === "new" ? { ok: true, found } : fail(`the install no longer matches expected.new (${what})`);
  }
  if (stage === "installing") {
    if (found) return { ok: true, found };
    return partialWithinIntent(id, live.tuple) ?? { ok: true, found: "partial" };
  }
  if (stage === "rolling-back") {
    if (!restoreSays) return fail("rolling-back without the restore's current state");
    if (restoreSays === "partial") return partialWithinIntent(id, live.tuple) ?? { ok: true, found: "partial" };
    return found === restoreSays ? { ok: true, found } : fail(`the restore says ${restoreSays} is current, but ${what}`);
  }
  return fail(`no mutation is allowed in ${stage}`);
}

/** null when a non-matching install stays inside the intent's destination with the service and Node unchanged. */
function partialWithinIntent(id: Identity, tuple: TupleRead): StageCheck | null {
  const fail = (reason: string): StageCheck => ({ ok: false, to: "manual-recovery", reason });
  if (!id.intent) return fail("the install changed with no install intent journaled");
  const dest = id.intent.destination;
  if (dest.packagePath !== id.ownership.packagePath) return fail("the install intent's destination is not the owned package path");
  const owned = BIN_NAMES.map(name => id.ownership.binLinks[name]).sort();
  const named = [...dest.binLinks].sort();
  if (owned.length !== named.length || owned.some((p, i) => p !== named[i])) return fail("the install intent's bin links are not the owned ones");
  const paths = tuple.state === "complete" ? [...Object.values(tuple.tuple.bins).filter((p): p is string => p !== null), tuple.tuple.entry] : tuple.paths;
  const outside = paths.find(p => !inside(p, dest.packagePath));
  if (outside) return fail(`the install reaches ${outside}, outside the intent's destination ${dest.packagePath}`);
  const interpreter = tuple.state === "complete" ? tuple.tuple.interpreter : tuple.interpreter;
  if (interpreter === null) return fail("the Node the install runs on can't be proven");
  if (interpreter !== id.expected.old.interpreter) return fail(`the Node changed (${interpreter})`);
  // The service definition must still be the attempt's own: an unreadable or changed ExecStart fails closed.
  const execStart = tuple.state === "complete" ? tuple.tuple.execStart : tuple.execStart;
  if (!sameArgv(execStart, id.expected.old.execStart)) return fail("the service's ExecStart changed or can't be read");
  return null;
}

// ── §3.3: which fleet may be stopped ───────────────────────────────────────────────────────────────────────────

export type StopTarget = { ok: true; generation: FleetGeneration } | { ok: false; reason: string };

/**
 * §3.3: a fleet may be stopped only when it is the recorded generation the stage expects — `old` before the snapshot,
 * `trial` on rollback — identified by the fleet.lock record (pid + nonce) and, with a service, its MainPID. An
 * unrecorded holder, or a MainPID that matches no generation, is never stopped (the caller goes to manual-recovery).
 */
export function stopTarget(attempt: AttemptRecord, lock: { pid: number; nonce: string } | null, mainPid: number | null): StopTarget {
  const want = attempt.stage === "stopping" ? "old" : attempt.stage === "rolling-back" ? "trial" : null;
  if (!want) return { ok: false, reason: `no fleet is stopped in ${attempt.stage}` };
  if (!lock) return { ok: false, reason: "fleet.lock names no holder" };
  const fleets = (Array.isArray(attempt.fleets) ? attempt.fleets : []) as FleetGeneration[];
  const gen = fleets.find(g => g.nonce === lock.nonce);
  if (!gen || gen.pid !== lock.pid) return { ok: false, reason: `fleet.lock's holder (pid ${lock.pid}) is no recorded generation` };
  if (gen.gen !== want) return { ok: false, reason: `fleet.lock's holder is generation ${gen.gen}, not ${want}` };
  // A MainPID is required whenever the attempt owns a service; only a proven detached attempt (no service) has none
  // (Prism #4502 1). An identity that can't be read proves neither.
  const id = identityOf(attempt);
  if (!id) return { ok: false, reason: "the attempt's recorded ownership is missing or malformed" };
  if (id.ownership.service) {
    if (mainPid === null) return { ok: false, reason: `the service ${id.ownership.service.unit}'s MainPID can't be read` };
    if (mainPid !== lock.pid) return { ok: false, reason: `the service's MainPID ${mainPid} matches no recorded generation` };
  } else if (mainPid !== null) return { ok: false, reason: `a detached attempt has no service, yet a MainPID ${mainPid} was given` };
  return { ok: true, generation: gen };
}
