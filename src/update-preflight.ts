/**
 * #1441 part B: before `agend update` installs a release, decide whether that release can run on this host — on the
 * Node it will actually run on. That is the target's bundled runtime where the target pins one for this host and the
 * host can run it (#1450: then the system Node does not matter), and otherwise the system Node: the `node` on PATH for a
 * direct install, or the exact Node 22 nvm selected for an nvm install. Which host can run the bundled runtime comes from
 * the helper the preinstall guard, the postinstall and the launcher share (launcher/runtime-platform.cjs).
 *
 * Design baseline: #1441 issuecomment-6108441160. Every input to a definite verdict is read from what the install will
 * actually run (#1623 review): the release's requirements from the npm that installs it, for the exact spec it
 * installs, and the Node version from the interpreter the release will start on. Anything that cannot be read or
 * proven — an unreadable requirement, a range this parser does not understand, a Node not chosen yet — is "unknown":
 * never "compatible" and never invented into a refusal. The update then goes on, and the target's own preinstall guard
 * still refuses inside npm (the previous package stays).
 */
import { createRequire } from "node:module";

export interface RuntimeHost { platform: string; arch: string; id: string; glibc: string | null; darwinRelease: string | null }
export interface RuntimePlatform {
  hostPlatform(probe?: Partial<RuntimeHost>): RuntimeHost;
  runtimeSupport(host: RuntimeHost): { supported: boolean; reason: string | null };
}

const require = createRequire(import.meta.url);
/** The one answer to "can this host run AgEnD's bundled Node?", shared with preinstall, postinstall and the launcher. */
export const runtimePlatform = require("../launcher/runtime-platform.cjs") as RuntimePlatform;

/** What the release about to be installed asks for: its Node range, and the runtime it pins per host id. */
export interface TargetManifest { version: string; engines: string | null; runtimePins: Record<string, string> }

/** A published package version (semver 2.0, no leading zeros). */
const PACKAGE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
/** A runtime pin as the launcher and postinstall accept it (launcher/runtime-select.cjs): Node x.y.z, optionally -agend.N. */
const RUNTIME_PIN = /^(\d+\.\d+\.\d+)(-agend\.\d+)?$/;

/** The npm arguments that read a release's requirements; the caller runs them with the npm that installs it. */
export function manifestQuery(spec: string): string[] {
  return ["view", spec, "version", "engines", "optionalDependencies", "--json"];
}

/**
 * The target's own requirements, read by `read` — which runs `npm <manifestQuery(spec)>` with the npm, environment and
 * registry the install uses and returns its stdout, or null when it fails. The spec must be the one npm installs, and
 * it must name the exact version (`@songsid/agend@<version>`); the answer must be that version. Otherwise: null.
 */
export function lookupTargetManifest(spec: string, version: string, read: (args: string[]) => string | null): TargetManifest | null {
  if (!PACKAGE_VERSION.test(version) || spec !== `@songsid/agend@${version}`) return null;
  const raw = read(manifestQuery(spec));
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const m = parsed as { version?: unknown; engines?: unknown; optionalDependencies?: unknown };
  // The registry answered for another version (or with something that is not one): it says nothing about this one.
  if (typeof m.version !== "string" || m.version !== version) return null;
  const engines = m.engines && typeof m.engines === "object" && typeof (m.engines as { node?: unknown }).node === "string"
    ? (m.engines as { node: string }).node : null;
  const runtimePins: Record<string, string> = Object.create(null);
  if (m.optionalDependencies && typeof m.optionalDependencies === "object") {
    for (const [name, pin] of Object.entries(m.optionalDependencies as Record<string, unknown>)) {
      const id = /^@songsid\/agend-node-(.+)$/.exec(name)?.[1];
      if (id && typeof pin === "string") runtimePins[id] = pin;
    }
  }
  return { version: m.version, engines, runtimePins };
}

/** The Node the release would run on when its bundled runtime does not apply. */
export type SystemNode =
  | { kind: "version"; version: string; path?: string | null; label: string }
  | { kind: "none" }
  | { kind: "unknown"; note: string };

export type UpdateTargetVerdict =
  | { kind: "runtime"; host: string; pin: string }
  | { kind: "system"; node: string; label: string }
  | { kind: "refuse"; message: string; summary: string }
  | { kind: "unknown"; note: string };

const UNREADABLE = "  Note: the release's Node requirements could not be read; its own install check still applies (a refusal there keeps this version installed).";
const unparsed = (range: string) => `  Note: the release asks for Node ${range}, which this check cannot evaluate; its own install check still applies (a refusal there keeps this version installed).`;

/** Which Node the target will run on here, and whether that Node satisfies the target's engines. */
export function evaluateUpdateTarget(input: {
  manifest: TargetManifest | null;
  host: RuntimeHost;
  platform?: RuntimePlatform;
  system: SystemNode;
}): UpdateTargetVerdict {
  const p = input.platform ?? runtimePlatform;
  const m = input.manifest;
  if (!m || !m.engines) return { kind: "unknown", note: UNREADABLE };
  const pin = Object.prototype.hasOwnProperty.call(m.runtimePins, input.host.id) ? m.runtimePins[input.host.id]! : null;
  const support = p.runtimeSupport(input.host);
  if (pin && support.supported) {
    // The pin keeps its identity (22.23.4-agend.1); the Node it installs is the one judged (postinstall: 22.23.4).
    const node = RUNTIME_PIN.exec(pin)?.[1];
    if (!node) return { kind: "unknown", note: `  Note: the release pins its bundled Node as ${JSON.stringify(pin)}, which this check cannot read; its own install check still applies.` };
    const fits = satisfiesNodeRange(node, m.engines);
    if (fits === null) return { kind: "unknown", note: unparsed(m.engines) };
    if (fits) return { kind: "runtime", host: input.host.id, pin };
    const summary = `v${m.version} pins Node ${pin} for ${input.host.id}, which is outside its own range ${m.engines}`;
    return { kind: "refuse", summary, message: refusal(m, `${summary}.`, false) };
  }
  const why = !pin ? `v${m.version} ships no bundled Node for ${input.host.id}` : `this host cannot use AgEnD's bundled Node: ${support.reason}`;
  const s = input.system;
  if (s.kind === "unknown") return { kind: "unknown", note: s.note };
  if (s.kind === "version") {
    const fits = satisfiesNodeRange(s.version, m.engines);
    if (fits === null) return { kind: "unknown", note: unparsed(m.engines) };
    if (fits) return { kind: "system", node: s.version, label: s.label };
  }
  const runsOn = s.kind === "none" ? "there is no usable `node` on PATH" : `it would run on ${s.label} (Node ${s.version}${s.path ? `, ${s.path}` : ""})`;
  const summary = `v${m.version} needs Node ${m.engines}; ${why}, and ${runsOn}`;
  return { kind: "refuse", summary, message: refusal(m, `${why}, and ${runsOn}.`, true) };
}

/** Where the update runs its commands: the install environment (`run`) and the npm binary the install invokes. */
export interface PreflightEnv { run(argv: string[], timeoutMs: number): { status: number | null; stdout: string }; npm: string }

/** The version and path of the `node` the environment resolves; exit 127 when there is none. */
export const NODE_PROBE_SCRIPT = `command -v node >/dev/null 2>&1 || exit 127; exec node -p "process.versions.node + ' ' + process.execPath"`;

/** The Node the release's `#!/usr/bin/env node` resolves to in `env` (`label` names it in messages). */
export function probeSystemNode(env: PreflightEnv, label: string): SystemNode {
  const r = env.run(["sh", "-c", NODE_PROBE_SCRIPT], 10_000);
  if (r.status === 127) return { kind: "none" };
  const m = r.status === 0 ? /^(\d+\.\d+\.\d+) (\/.*)$/.exec(r.stdout.trim().split("\n").pop()?.trim() ?? "") : null;
  if (!m) return { kind: "unknown", note: `  Note: could not read the version of ${label}; the release's own install check still applies (a refusal there keeps this version installed).` };
  return { kind: "version", version: m[1]!, path: m[2]!, label };
}

/**
 * The whole check, run where the install runs: the requirements of `spec` (which must be `@songsid/agend@<version>`)
 * from `env.npm`, and the Node `env` resolves — both read the way the install that follows reads them.
 */
export function preflightUpdate(env: PreflightEnv, spec: string, version: string, label: string, host: RuntimeHost = runtimePlatform.hostPlatform()): UpdateTargetVerdict {
  const manifest = lookupTargetManifest(spec, version, args => {
    const r = env.run([env.npm, ...args], 15_000);
    return r.status === 0 ? r.stdout : null;
  });
  if (!manifest) return { kind: "unknown", note: UNREADABLE };
  return evaluateUpdateTarget({ manifest, host, system: probeSystemNode(env, label) });
}

/**
 * The check an nvm install runs once nvm has selected its Node 22 (UpdateInstallPlan.preflight): on that Node, with that
 * Node's npm. A refusal is printed in full and returned as the update's outcome; unknown is a note and the install goes on.
 */
export function installPreflight(spec: string, version: string, label: string, out: { log(message: string): void; error(message: string): void }, host?: RuntimeHost) {
  return (env: PreflightEnv): { ok: true } | { ok: false; message: string } => {
    const verdict = preflightUpdate(env, spec, version, label, host);
    if (verdict.kind === "unknown") out.log(verdict.note);
    if (verdict.kind !== "refuse") return { ok: true };
    out.error(`\n${verdict.message}\n`);
    return { ok: false, message: `  Not updated: ${verdict.summary}. The installed AgEnD was not changed.` };
  };
}

function refusal(m: TargetManifest, why: string, installable: boolean): string {
  return [
    `  ✗ AgEnD v${m.version} cannot run on this host's Node — AgEnD was not changed.`,
    "",
    `    v${m.version} needs Node ${m.engines}.`,
    `    ${why}`,
    "",
    installable
      ? `    Install a Node that satisfies ${m.engines} and put it first on PATH, then run: agend update`
      : "    This release cannot be installed here; wait for the next one.",
  ].join("\n");
}

// ── npm's range grammar for a stable Node version ──────────────────────────────────────────────────────────────────
// npm judges `engines.node` with semver. This is the same grammar — `||` alternatives of space-separated comparators
// (`<`, `<=`, `>`, `>=`, `=`, `~`, `^`, x-ranges with x/X/* or missing parts) and hyphen ranges — for a stable version
// (Node's own versions have no prerelease). Anything outside it (prerelease tags, `~>`, leading zeros, an empty `||`
// alternative, a version part past Number.MAX_SAFE_INTEGER, ...) is null: "cannot tell", never a guess.

type Triple = [number, number, number];
interface Comparator { op: "<" | "<=" | ">" | ">="; v: Triple }
const NUM = "(?:0|[1-9]\\d*)";
const PART = `(?:${NUM}|[xX*])`;
const PARTIAL = new RegExp(`^v?(${PART})(?:\\.(${PART})(?:\\.(${PART}))?)?$`);
/** Matches nothing: no stable version is below 0.0.0. */
const NEVER: Comparator[] = [{ op: "<", v: [0, 0, 0] }];

/** `[major, minor, patch]` with null for a wildcard or missing part; null when it is not a partial version. */
function partial(text: string): [number | null, number | null, number | null] | null {
  const m = PARTIAL.exec(text);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].map(x => (x === undefined || /^[xX*]$/.test(x) ? null : Number(x)));
  // `1.x.3`: a number after a wildcard is not something this check guesses at.
  for (let i = 1; i < 3; i++) if (parts[i] !== null && parts[i - 1] === null) return null;
  return parts as [number | null, number | null, number | null];
}

function comparators(op: string, text: string): Comparator[] | null {
  const pv = partial(text);
  if (!pv) return null;
  const [M, m, pt] = pv;
  if (M === null) return op === "<" || op === ">" ? NEVER : [];
  const lo: Triple = [M, m ?? 0, pt ?? 0];
  const nextMajor: Triple = [M + 1, 0, 0];
  const next: Triple = m === null ? nextMajor : pt === null ? [M, m + 1, 0] : [M, m, pt];
  switch (op) {
    case "": case "=":
      return m === null || pt === null ? [{ op: ">=", v: lo }, { op: "<", v: next }] : [{ op: ">=", v: lo }, { op: "<=", v: lo }];
    case ">": return m === null || pt === null ? [{ op: ">=", v: next }] : [{ op: ">", v: lo }];
    case ">=": return [{ op: ">=", v: lo }];
    case "<": return [{ op: "<", v: lo }];
    case "<=": return m === null || pt === null ? [{ op: "<", v: next }] : [{ op: "<=", v: lo }];
    case "~": return [{ op: ">=", v: lo }, { op: "<", v: m === null ? nextMajor : [M, m + 1, 0] }];
    case "^": {
      if (m === null) return [{ op: ">=", v: lo }, { op: "<", v: nextMajor }];
      const upper: Triple = M > 0 ? nextMajor : pt === null || m > 0 ? [0, m + 1, 0] : [0, 0, pt + 1];
      return [{ op: ">=", v: lo }, { op: "<", v: upper }];
    }
    default: return null;
  }
}

function hyphen(from: string, to: string): Comparator[] | null {
  const a = partial(from), b = partial(to);
  if (!a || !b) return null;
  const out: Comparator[] = [];
  if (a[0] !== null) out.push({ op: ">=", v: [a[0], a[1] ?? 0, a[2] ?? 0] });
  if (b[0] !== null) {
    if (b[1] === null) out.push({ op: "<", v: [b[0] + 1, 0, 0] });
    else if (b[2] === null) out.push({ op: "<", v: [b[0], b[1] + 1, 0] });
    else out.push({ op: "<=", v: [b[0], b[1], b[2]] });
  }
  return out;
}

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Does Node `version` (stable x.y.z) satisfy npm range `range`? true/false as semver would answer, or null when the
 * version or the range is outside what this parser reads exactly.
 */
export function satisfiesNodeRange(version: string, range: string): boolean | null {
  const vm = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!vm) return null;
  const v: Triple = [Number(vm[1]), Number(vm[2]), Number(vm[3])];
  if (v.some(n => !Number.isSafeInteger(n))) return null;
  const alternatives = range.trim().split("||").map(a => a.trim());
  if (alternatives.length === 1 && alternatives[0] === "") return true;
  let any = false;
  for (const alt of alternatives) {
    if (alt === "") return null;
    let set: Comparator[] | null;
    const h = /^(\S+)\s+-\s+(\S+)$/.exec(alt);
    if (h) set = hyphen(h[1]!, h[2]!);
    else {
      set = [];
      for (const token of alt.replace(/(<=|>=|<|>|=|~|\^)\s+/g, "$1").split(/\s+/)) {
        const t = /^(<=|>=|<|>|=|~|\^)?(.*)$/.exec(token)!;
        const c = comparators(t[1] ?? "", t[2]!);
        if (!c) { set = null; break; }
        set.push(...c);
      }
    }
    // semver refuses any version part above Number.MAX_SAFE_INTEGER — written, or produced by expanding x/~/^/hyphen
    // upper bounds (`^9007199254740991` → <9007199254740992.0.0) — so such a range has no npm meaning: cannot tell.
    if (!set || set.some(c => c.v.some(n => !Number.isSafeInteger(n)))) return null;
    if (set.every(c => {
      const d = compare(v, c.v);
      return c.op === "<" ? d < 0 : c.op === "<=" ? d <= 0 : c.op === ">" ? d > 0 : d >= 0;
    })) any = true;
  }
  return any;
}
