/**
 * M-2457 PR B (docs/design/bundled-tmux.md §5): which tmux AgEnD runs, on which socket, with which environment — one
 * place for every call site.
 *
 * Dark: the switch `AGEND_BUNDLED_TMUX=1` turns it on, and nothing sets it in this release. While it is off, every
 * answer is exactly what each call site did before: the `tmux` on PATH, `getTmuxSocketName()` (tmux's default socket
 * for the real home, an isolated one for any other), the caller's environment.
 *
 * On (PR C activates it with the transitions):
 *  - the binary is `AGEND_TMUX_BIN` (an absolute path to an executable file; anything else is refused with what to do),
 *    else the bundled tmux this package's postinstall verified (its receipt, launcher/tmux-bundle.cjs), copied once to
 *    `<AGEND_HOME>/tmux/<version>-<sha12>/` so the server never runs from a package an update replaces. There is no
 *    PATH fallback: a missing or unverified bundle refuses with the fix.
 *  - the socket is `agend` for the real home (never the default socket), the isolated name for any other home;
 *  - the environment puts the bundled terminfo first (TERMINFO_DIRS), says the terminal has true colour, and never
 *    passes a caller's $TMUX / $TMUX_PANE to a tmux client.
 */
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgendHome, getTmuxSocketName, isDefaultAgendHome } from "./paths.js";

export const BUNDLED_TMUX_ENV = "AGEND_BUNDLED_TMUX";
export const TMUX_BIN_ENV = "AGEND_TMUX_BIN";
/** The real home's socket once the bundled tmux is on: AgEnD's own, never tmux's default. */
export const BUNDLED_TMUX_SOCKET = "agend";

/** The switch: exactly "1" (as AGEND_FLEET_START_DIRECT). Anything else — unset included — is off. */
export function bundledTmuxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BUNDLED_TMUX_ENV] === "1";
}

export class TmuxUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "TmuxUnavailableError"; }
}

export interface TmuxResolution {
  /** What to execute: "tmux" (PATH) while off; an absolute path while on. */
  binary: string;
  /** The bundled terminfo directory, when the binary is the bundle. */
  terminfo: string | null;
  source: "system" | "override" | "bundled";
  /** The bundle's tmux release ("3.8"), when known. */
  version: string | null;
}

interface Bundle {
  pinnedTmux(manifest: unknown, host: { id: string }): { name: string; version: string } | null;
  readReceipt(pkgDir: string, pin: { version: string } | null): { tmuxPath: string; tmux: string; sha256: string; size: number } | null;
}

/** Seams for tests: where the package lives, the host, the home. Production passes none. */
export interface TmuxResolveDeps {
  env?: NodeJS.ProcessEnv;
  packageDir?: string;
  hostId?: string;
  agendHome?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** src/ (tsx) and dist/ (built) both sit one level under the package root. */
const PACKAGE_DIR = join(HERE, "..");
const sha256File = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

let cache: { key: string; value: TmuxResolution } | null = null;
/** Tests: forget the cached answers. */
export function resetTmuxResolution(): void { cache = null; confWritten = null; }

/** Which tmux to run. Cached per (switch, override, home): a launch never re-copies. */
export function resolveTmux(deps: TmuxResolveDeps = {}): TmuxResolution {
  const env = deps.env ?? process.env;
  if (!bundledTmuxEnabled(env)) return { binary: "tmux", terminfo: null, source: "system", version: null };
  const home = deps.agendHome ?? getAgendHome();
  const key = JSON.stringify([env[TMUX_BIN_ENV] ?? null, home, deps.packageDir ?? null, deps.hostId ?? null]);
  if (cache && cache.key === key) return cache.value;
  const value = env[TMUX_BIN_ENV] !== undefined ? overrideBinary(env[TMUX_BIN_ENV]!) : bundledBinary(deps, home);
  cache = { key, value };
  return value;
}

function overrideBinary(raw: string): TmuxResolution {
  const path = raw.trim();
  const refuse = (why: string) => new TmuxUnavailableError(`${TMUX_BIN_ENV}=${JSON.stringify(raw)} ${why}. Set it to the absolute path of a tmux 3.6a or newer, or unset it to use AgEnD's bundled tmux.`);
  if (!path || !isAbsolute(path)) throw refuse("is not an absolute path");
  let file = false;
  try { file = statSync(path).isFile(); } catch { /* checked below */ }
  if (!file) throw refuse("is not a file");
  try { accessSync(path, constants.X_OK); } catch { throw refuse("is not executable"); }
  return { binary: path, terminfo: null, source: "override", version: null };
}

function bundledBinary(deps: TmuxResolveDeps, home: string): TmuxResolution {
  const pkgDir = deps.packageDir ?? PACKAGE_DIR;
  const req = createRequire(join(pkgDir, "package.json"));
  const bundle = req("./launcher/tmux-bundle.cjs") as Bundle;
  const hostId = deps.hostId ?? `${process.platform}-${process.arch}`;
  const reinstall = `Reinstall AgEnD (npm install -g @songsid/agend), or set ${TMUX_BIN_ENV} to a tmux 3.6a or newer.`;
  let manifest: unknown = null;
  try { manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")); } catch { /* refused below */ }
  const pin = bundle.pinnedTmux(manifest, { id: hostId });
  if (!pin) throw new TmuxUnavailableError(`This release has no bundled tmux for ${hostId}. ${reinstall}`);
  const receipt = bundle.readReceipt(pkgDir, pin);
  if (!receipt) throw new TmuxUnavailableError(`AgEnD's bundled tmux (${pin.name}@${pin.version}) is not installed or not verified. ${reinstall}`);
  const pkgTmuxDir = dirname(dirname(receipt.tmuxPath));
  const dest = join(home, "tmux", `${receipt.tmux}-${receipt.sha256.slice(0, 12)}`);
  const bin = join(dest, "bin", "tmux");
  // The copy is trusted only when its bytes are the receipt's.
  if (!(existsSync(bin) && statSync(bin).size === receipt.size && sha256File(bin) === receipt.sha256)) {
    const tmp = `${dest}.${process.pid}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, "bin"), { recursive: true });
    cpSync(receipt.tmuxPath, join(tmp, "bin", "tmux"));
    chmodSync(join(tmp, "bin", "tmux"), 0o755);
    if (existsSync(join(pkgTmuxDir, "share", "terminfo"))) cpSync(join(pkgTmuxDir, "share", "terminfo"), join(tmp, "share", "terminfo"), { recursive: true });
    if (sha256File(join(tmp, "bin", "tmux")) !== receipt.sha256) {
      rmSync(tmp, { recursive: true, force: true });
      throw new TmuxUnavailableError(`AgEnD's bundled tmux changed while it was being copied to ${dest}. ${reinstall}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
  }
  return { binary: bin, terminfo: join(dest, "share", "terminfo"), source: "bundled", version: receipt.tmux };
}

/** The tmux to execute (see resolveTmux). */
export function tmuxBinary(deps?: TmuxResolveDeps): string {
  return resolveTmux(deps).binary;
}

/**
 * The -L socket: while off, getTmuxSocketName() as before (null — tmux's default socket — only for the real home);
 * while on, the real home's is `agend`, and any other home keeps its isolated name.
 */
export function tmuxSocket(env: NodeJS.ProcessEnv = process.env): string | null {
  return socketFor(bundledTmuxEnabled(env), isDefaultAgendHome(), getTmuxSocketName());
}

/** The socket rule, pure: off → `before` as is; on → `agend` for the real home, `before` (its isolated name) otherwise. */
export function socketFor(enabled: boolean, realHome: boolean, before: string | null): string | null {
  if (!enabled) return before;
  return realHome ? BUNDLED_TMUX_SOCKET : before;
}

/**
 * Whether `agend attach` runs inside THIS fleet's tmux (then it switches the client instead of attaching). Off: any
 * $TMUX, as before. On: only a $TMUX whose socket (its first field, a path) is this fleet's — the user's own tmux on
 * another socket is not "inside", and attaching from it is an ordinary (nested) attach.
 */
export function insideFleetTmux(tmuxVar: string | undefined, enabled: boolean, socket: string | null): boolean {
  if (!tmuxVar) return false;
  if (!enabled) return true;
  const path = tmuxVar.split(",")[0] ?? "";
  return socket !== null && path.slice(path.lastIndexOf("/") + 1) === socket;
}

/** AgEnD's own tmux configuration (§4): the bundled tmux reads this file, never the user's ~/.tmux.conf. */
export const AGEND_TMUX_CONF = [
  "# AgEnD's tmux configuration (M-2457). AgEnD's bundled tmux reads only this file; your ~/.tmux.conf is untouched.",
  'set -g default-terminal "tmux-256color"',
  'set -as terminal-features ",*:RGB"',
  "",
].join("\n");

let confWritten: string | null = null;
/** The -f config arguments: none while off; `-f <AGEND_HOME>/tmux/agend-tmux.conf` (written when missing) while on. */
export function tmuxConfArgs(env: NodeJS.ProcessEnv = process.env, home: string = getAgendHome()): string[] {
  if (!bundledTmuxEnabled(env)) return [];
  const file = join(home, "tmux", "agend-tmux.conf");
  if (confWritten !== file) {
    let current: string | null = null;
    try { current = readFileSync(file, "utf8"); } catch { /* written below */ }
    if (current !== AGEND_TMUX_CONF) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.${process.pid}.tmp`, AGEND_TMUX_CONF);
      renameSync(`${file}.${process.pid}.tmp`, file);
    }
    confWritten = file;
  }
  return ["-f", file];
}

/** `args` with this fleet's -L socket (none for tmux's default socket while off) and, on, the -f config in front. */
export function tmuxArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const socket = tmuxSocket(env);
  return [...(socket ? ["-L", socket] : []), ...tmuxConfArgs(env), ...args];
}

/**
 * The environment a tmux client runs with. Off: `base` as it is. On: the bundled terminfo first in TERMINFO_DIRS,
 * COLORTERM=truecolor, and no $TMUX / $TMUX_PANE (a client must never read another server's from its caller).
 */
export function tmuxEnv(base: NodeJS.ProcessEnv = process.env, deps?: TmuxResolveDeps): NodeJS.ProcessEnv {
  if (!bundledTmuxEnabled(deps?.env ?? base)) return base;
  const r = resolveTmux({ ...deps, env: deps?.env ?? base });
  const out: NodeJS.ProcessEnv = { ...base };
  delete out.TMUX;
  delete out.TMUX_PANE;
  if (r.terminfo) out.TERMINFO_DIRS = r.terminfo + (base.TERMINFO_DIRS ? `:${base.TERMINFO_DIRS}` : ":/usr/share/terminfo:/lib/terminfo:/usr/lib/terminfo");
  out.COLORTERM = "truecolor";
  // Panes inherit the server's environment: a script inside one reaches this server with this binary (a system tmux
  // client may not speak the bundled server's protocol).
  out.AGEND_TMUX = r.binary;
  return out;
}

/** For spreading into a child's options: `{ env }` with the bundled tmux's environment while on; `{}` while off. */
export function tmuxEnvOption(): { env?: NodeJS.ProcessEnv } {
  return bundledTmuxEnabled() ? { env: tmuxEnv() } : {};
}
