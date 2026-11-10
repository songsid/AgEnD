/**
 * AGEND-136 (upstream #3521): the releases of each AI CLI that AgEnD has audited — the one list an "Update" button reads, on the AgEnD host and on a paired
 * Windows computer alike.
 *
 * AgEnD audits what a CLI's screens and prompts do (decision ffb8104e, the daily upstream watch) before it depends on a release, so an update goes to the newest
 * AUDITED release, never to "latest". The watch's own ledger lives on the maintainer's host; this is its shipped mirror, the same one the Windows pane gate has always
 * read (`NATIVE_CLI_AUDITED`, runtime-pane-native.ts, now derived from here): when a version is marked audited there, it is added here, in the same change that carries
 * its audit evidence (tests/<cli>-<version>-audit.test.ts and tests/fixtures/<cli>-<version>-audit/).
 *
 * Plain data and string comparison only; built-ins only: part of the Runtime bundle (RUNTIME_BUNDLE_MODULES).
 */
import type { CliId } from "./cli-capability.js";

/** Audited releases, oldest first. The last entry is the one an update goes to. A list is `readonly`: nothing at run time adds to it. */
export const AUDITED_CLI_VERSIONS: Readonly<Record<CliId, readonly string[]>> = Object.freeze({
  // The maintainer-confirmed ledger of 2026-11-09 21:00 (Taipei): Claude 2.1.319, Codex 0.167.0, Kiro 3.1.0, Grok 1.0.77, Antigravity 1.5.3, OpenCode 1.19.5, Muse 1.4.14-R7309.1 are
  // the newest audited release of each. (Maintaining this shipped ledger is part of our audit PRs: when a version is marked audited, the maintainer who audits it adds it here.)
  // 2.1.316: native persistent-pane acceptance. 2.1.318: upstream watch audit (#3048). 2.1.319: live-captured (tests/claude-cold-resume-2.1.319.test.ts).
  "claude-code": Object.freeze(["2.1.316", "2.1.318", "2.1.319"]),
  // 0.165.0: native persistent-pane acceptance (#2954 / #3001 / #3219). 0.166.0: upstream watch audit. 0.167.0: tests/codex-0167-audit.test.ts.
  codex: Object.freeze(["0.165.0", "0.166.0", "0.167.0"]),
  // tests/kiro-*-audit.test.ts: 2.29.0 … 3.1.0.
  "kiro-cli": Object.freeze(["2.29.0", "2.29.1", "2.30.0", "2.33.0", "2.34.0", "2.37.0", "3.0.0", "3.1.0"]),
  // tests/fixtures/agy-1.3.5-audit, agy-1.3.6-audit; 1.5.3 on the maintainer's ledger.
  antigravity: Object.freeze(["1.3.5", "1.3.6", "1.5.3"]),
  // tests/grok-1.0.*-audit.test.ts: 1.0.52 … 1.0.77.
  grok: Object.freeze(["1.0.52", "1.0.60", "1.0.67", "1.0.70", "1.0.77"]),
  // tests/muse-1.4.*-audit.test.ts. The newest is kept with its build (`1.4.14-R7309.1`, docs/dev/muse-1.4.14-audit.md): an installed `1.4.14-R7012.1` is not the audited release,
  // and the page can say so. (Older entries are the numbers the earlier audits recorded, without a build.)
  muse: Object.freeze(["1.4.4", "1.4.6", "1.4.7", "1.4.11", "1.4.12", "1.4.13", "1.4.14-R7309.1"]),
  // tests/fixtures/opencode-1.18.34-*; 1.19.5 on the maintainer's ledger.
  opencode: Object.freeze(["1.18.34", "1.19.5"]),
});

/** A release as it is written in a command: three whole numbers, nothing else. A command's `{version}` is only ever filled with one of these. */
export const AUDITED_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
/** A release as it is written in the ledger: three whole numbers and, where a CLI ships one (Muse), its build — `1.4.14-R7309.1`. */
export const AUDITED_RELEASE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-R\d{1,9}(?:\.\d{1,6})*)?$/;

/**
 * The release inside what a CLI printed for `--version` ("codex-cli 0.165.0", "2.1.316 (Claude Code)", "1.4.14-R7012.1"): the first x.y.z, not glued to other digits or dots,
 * WITH the build a CLI ships after it (Muse's `-R7309.1`) — the full release identity, so "installed 1.4.14-R7012.1" and the audited "1.4.14-R7309.1" are told apart. Any other
 * prerelease suffix is dropped (it never changes which x.y.z the release is). Null when there is none.
 */
export function versionOf(printed: unknown): string | null {
  const m = typeof printed === "string" ? /(?<![\d.])(\d{1,6}\.\d{1,6}\.\d{1,6})(?:-R(\d{1,9}(?:\.\d{1,6})*))?(?!\d|\.\d)/.exec(printed) : null;
  return m ? (m[2] ? `${m[1]}-R${m[2]}` : m[1]!) : null;
}

/**
 * -1, 0 or 1: the numbers of two releases compared one by one (never as text, so 2.1.99 < 2.1.316). Then the build, if either has one: numbers one by one (R7012.1 < R7309.1),
 * and a release with no build is before the same x.y.z with one.
 */
export function compareVersions(a: string, b: string): number {
  const [ax, ab] = a.split("-R"), [bx, bb] = b.split("-R");
  const x = ax!.split(".").map(Number), y = bx!.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d !== 0) return d < 0 ? -1 : 1; }
  if (ab === undefined && bb === undefined) return 0;
  if (ab === undefined) return -1;
  if (bb === undefined) return 1;
  const p = ab.split(".").map(Number), q = bb.split(".").map(Number);
  for (let i = 0; i < Math.max(p.length, q.length); i++) { const d = (p[i] ?? 0) - (q[i] ?? 0); if (d !== 0) return d < 0 ? -1 : 1; }
  return 0;
}

/** AGEND-154 (Prism P2-1 on #3552): the field of an Update request that says "I know this goes to the vendor's latest, which AgEnD has not audited" (web-host-install.ts, runtime-api.ts, the pages). */
export const LATEST_ACK_FIELD = "acceptLatestUnaudited";

/** The newest audited release of a CLI, or null for an id with none. */
export function auditedVersion(id: string): string | null {
  const list = Object.hasOwn(AUDITED_CLI_VERSIONS, id) ? AUDITED_CLI_VERSIONS[id as CliId] : undefined;
  if (!list?.length) return null;
  return [...list].sort(compareVersions)[list.length - 1] ?? null;
}

/**
 * Where an installed CLI stands against its audited release:
 *  - `current`: it is the audited release. Nothing to update.
 *  - `behind`: it is older than the audited release. An update to it is offered where the CLI has one (`canUpdate`); a CLI that updates itself shows the versions only.
 *  - `newer`: it is newer than anything AgEnD has audited ("not verified by AgEnD yet"). No button.
 *  - `unknown`: its version could not be read.
 */
export type CliUpdateState = "current" | "behind" | "newer" | "unknown";
export interface CliUpdateView {
  state: CliUpdateState;
  /** The newest audited release (what an update installs). */
  audited: string;
  /** The version read from the installed CLI; null when it could not be read. */
  installed: string | null;
  /** The Update button is offered: the CLI is behind and has an update the registry knows (`host.update`/`runtime.update`); for the named exception (`latest`), whenever its version could be read. */
  button: boolean;
  /**
   * AGEND-153: the update is the named exception (the registry's `release: "latest-unaudited"` / `kind: "latest-unaudited"`): it goes to the newest release the vendor serves, NOT to `audited`,
   * so it is offered at, below or above the audited release, and the page labels it "not audited by AgEnD".
   */
  latest: boolean;
}

/**
 * Pure. `printed`: what the binary probe read; `canUpdate`: the registry has an update for this CLI on this side; `latest`: that update is the named exception that goes to the vendor's
 * newest release (AGEND-153), so the audited release does not decide whether it is offered. Null for an id with no audited release.
 */
export function cliUpdateView(id: string, printed: unknown, canUpdate: boolean, latest = false): CliUpdateView | null {
  const audited = auditedVersion(id);
  if (!audited) return null;
  const installed = versionOf(printed), exception = canUpdate && latest;
  if (!installed) return { state: "unknown", audited, installed: null, button: false, latest: exception };
  const order = compareVersions(installed, audited);
  const state: CliUpdateState = order < 0 ? "behind" : order > 0 ? "newer" : "current";
  return { state, audited, installed, button: canUpdate && (exception || state === "behind"), latest: exception };
}
