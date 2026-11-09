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
  // 2.1.316: native persistent-pane acceptance. 2.1.318: upstream watch audit (#3048). (2.1.319 is on some hosts and is not audited yet.)
  "claude-code": Object.freeze(["2.1.316", "2.1.318"]),
  // 0.165.0: native persistent-pane acceptance (#2954 / #3001 / #3219). 0.166.0: upstream watch audit. (tests/codex-0167-audit.test.ts exists; the ledger has not taken 0.167.0.)
  codex: Object.freeze(["0.165.0", "0.166.0"]),
  // tests/kiro-*-audit.test.ts: 2.29.0 … 3.1.0.
  "kiro-cli": Object.freeze(["2.29.0", "2.29.1", "2.30.0", "2.33.0", "2.34.0", "2.37.0", "3.0.0", "3.1.0"]),
  // tests/fixtures/agy-1.3.5-audit, agy-1.3.6-audit.
  antigravity: Object.freeze(["1.3.5", "1.3.6"]),
  // tests/grok-1.0.*-audit.test.ts: 1.0.52 … 1.0.77.
  grok: Object.freeze(["1.0.52", "1.0.60", "1.0.67", "1.0.70", "1.0.77"]),
  // tests/muse-1.4.*-audit.test.ts (the number before the `-R…` build suffix).
  muse: Object.freeze(["1.4.4", "1.4.6", "1.4.7", "1.4.11", "1.4.12", "1.4.13", "1.4.14"]),
  // tests/fixtures/opencode-1.18.34-*.
  opencode: Object.freeze(["1.18.34"]),
});

/** A release as it is written in a ledger or a command: three whole numbers, nothing else. A command's `{version}` is only ever filled with one of these. */
export const AUDITED_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/**
 * The version number inside what a CLI printed for `--version` ("codex-cli 0.165.0", "2.1.316 (Claude Code)", "1.4.14-R7012.1"): the first x.y.z, not glued to other
 * digits or dots. Null when there is none. (A prerelease or build suffix is dropped: it never changes which x.y.z the release is.)
 */
export function versionOf(printed: unknown): string | null {
  return typeof printed === "string" ? /(?<![\d.])(\d{1,6}\.\d{1,6}\.\d{1,6})(?!\d|\.\d)/.exec(printed)?.[1] ?? null : null;
}

/** -1, 0 or 1: the numbers of two x.y.z compared one by one (never as text, so 2.1.99 < 2.1.316). */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d !== 0) return d < 0 ? -1 : 1; }
  return 0;
}

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
  /** The Update button is offered: the CLI is behind and has an update the registry knows (`host.update`/`runtime.update`). */
  button: boolean;
}

/** Pure. `printed`: what the binary probe read; `canUpdate`: the registry has an update for this CLI on this side. Null for an id with no audited release. */
export function cliUpdateView(id: string, printed: unknown, canUpdate: boolean): CliUpdateView | null {
  const audited = auditedVersion(id);
  if (!audited) return null;
  const installed = versionOf(printed);
  if (!installed) return { state: "unknown", audited, installed: null, button: false };
  const order = compareVersions(installed, audited);
  const state: CliUpdateState = order < 0 ? "behind" : order > 0 ? "newer" : "current";
  return { state, audited, installed, button: state === "behind" && canUpdate };
}
