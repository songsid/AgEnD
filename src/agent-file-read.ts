/**
 * #1629: reading a file an agent names for an upload (set_web_theme_asset, and later effects, widgets and mods), on the
 * agent's side — the daemon — so the fleet never opens a workspace path (first design §4: tool handlers neither fork
 * nor read outside their own state). The file must be in the agent's own working directory, not a symlink, a regular
 * file within the size limit, and outside AgEnD state except for this caller's admitted managed asset area; what is read is that
 * open file. The caller identity comes from the daemon/CLI context, never a tool argument.
 *
 * The open never waits (#1887 review): O_NONBLOCK, so a regular file replaced by a FIFO between the lstat and the
 * open returns at once and is refused by the descriptor's own fstat — it never holds a filesystem worker waiting for
 * a writer. O_NOCTTY, so a terminal device swapped in is never made the controlling terminal.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { classicInstanceName, sanitizeInstanceName } from "./instance-names.js";

export type AgentFileRead = { ok: true; bytes: Buffer } | { ok: false; reason: string };

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export interface AgentFileContext {
  workspace: string | undefined;
  stateDir: string;
  instance?: string;
  /** Daemon launch config, never a tool argument. CLI resolves its record from fleet.yaml. */
  configuredWorkspace?: string;
}

const plainCaller = (name: unknown): name is string => typeof name === "string" && name.length > 0 && name !== "." && name !== ".." && !/[/\\\u0000-\u001f\u007f]/.test(name);
// These names are private even inside an admitted staging directory. A staging area is not a credential store.
const sensitiveNames = [
  "instances", "credential-profiles", "inbox", "chat-logs", "web-files", "web-chat.json", "cx", "kiro-v3", "cli-env", "access",
  "web.token", "view.token", "web-sessions", "sessions", "session-env", "projects", "file-history", "shell-snapshots", "backups", "todos", "statsig", "ide",
  "claude.md", "agents.md", "mcp-config.json", "claude-settings.json", "credentials.json", "opencode.json", "opencode.jsonc",
  "config.toml", "settings.json", "settings.local.json", "auth.json", "history.jsonl", "agent.token", "session-id", "session-id.backend",
  "fleet.yaml", "classicbot.yaml", "web-sessions.json", "web-devices.json", "web-prefs.json", "web-effects.json", "web-mods.json",
  "web-themes.json", "web-offices.json", "web-effect-profiles.json", "kiro-engine-ledger.json", "cache-codex-rollouts.json", "settings-apply-jobs.json",
  "cancel-buttons.json", "forged-envelope-reports.json", "upgrade-notices.json", "fleet.lock", "fleet.pid", "fleet.log", "daemon.log",
  "restart-audit.log", "tunnel.lease", "service-plan.json", "update-in-progress.json", "self-restart.json", "setup-complete.json",
];
const sensitivePart = (part: string) => (part.startsWith(".") && part !== ".agend") || sensitiveNames.some(name => part.toLowerCase() === name || part.toLowerCase().startsWith(name + ".") || part.toLowerCase().startsWith(name + "-"))
  || /\.(?:db|sqlite|sqlite3)(?:[.-]|$)/i.test(part) || /\.(?:token|pem|key)(?:[.-]|$)/i.test(part);
const reservedStateRoots = new Set(["workspaces", "kiro-identity", "operator", "model-catalog", "profiles", "preview-tunnel", "bin", "web-effects", "web-mods", "web-themes", "web-owner-css", "cards", "avatars", "cache", "web-files"]);
const staging = ["web-assets", "web-effects", ".agend/appearance", ".agend/mods"];

/** Read persisted Classic ownership, including peers with no running daemon. Never construct the migrating manager. */
async function classicPeerNames(state: string, fleet: unknown): Promise<Set<string>> {
  let raw: unknown;
  try {
    const text = await readFile(resolve(state, "classicBot.yaml"), "utf8");
    const { default: yaml } = await import("js-yaml"); raw = yaml.load(text);
  } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set(); throw err; }
  if (raw == null) return new Set();
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid Classic configuration");
  const channels = (raw as { channels?: unknown }).channels ?? {};
  if (typeof channels !== "object" || Array.isArray(channels)) throw new Error("invalid Classic roster");
  const names = new Set<string>();
  for (const [key, value] of Object.entries(channels)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Classic record");
    const row = value as { instanceName?: unknown; channelId?: unknown; name?: unknown; adapterId?: unknown };
    let name = row.instanceName;
    if (name == null) {
      // Match the manager's legacy naming, including non-primary adapter suffixes, without load()/save().
      const channelId = row.channelId ?? key, label = row.name ?? channelId;
      if (typeof channelId !== "string" || typeof label !== "string" || row.adapterId != null && typeof row.adapterId !== "string") throw new Error("unknown Classic identity");
      const cfg = fleet as { channels?: unknown; channel?: unknown } | undefined;
      if (cfg?.channels != null && !Array.isArray(cfg.channels)) throw new Error("unknown adapters");
      const first = Array.isArray(cfg?.channels) && cfg.channels.length ? cfg.channels[0] : cfg?.channel;
      if (first != null && (typeof first !== "object" || Array.isArray(first))) throw new Error("unknown primary adapter");
      const primary = first as { id?: unknown; type?: unknown } | undefined;
      const primaryId = primary?.id ?? primary?.type;
      if (primaryId != null && typeof primaryId !== "string") throw new Error("unknown primary adapter");
      name = classicInstanceName(sanitizeInstanceName(label), channelId, row.adapterId && row.adapterId !== primaryId ? row.adapterId as string : undefined);
    }
    if (!plainCaller(name)) throw new Error("invalid Classic instance name");
    names.add(name);
  }
  return names;
}

/** Shared by reads, effect-directory admission and generated writes. No ownership inferred from the shell cwd. */
export async function agentFileScope(opts: AgentFileContext): Promise<{ workspace: string; managedState: boolean; stateBlocked(path: string): boolean }> {
  const workspace = await realpath(opts.workspace!);
  const states = [resolve(opts.stateDir)];
  let state: string | undefined;
  try { state = await realpath(opts.stateDir); states.push(state); } catch { /* absent state has no exception */ }
  const managedState = states.some(root => under(workspace, root) || under(resolve(opts.workspace!), root));
  let own: string | undefined, ownWorkspace = false;
  if (state && managedState && plainCaller(opts.instance)) {
    // Unlike loadFleetConfig this reads no defaults that create directories or initialize repositories.
    // A malformed/unreadable roster cannot prove exclusive ownership and refuses all in-state reads.
    let fleet: unknown, rosterRead = false;
    try {
      const text = await readFile(resolve(state, "fleet.yaml"), "utf8");
      const { default: yaml } = await import("js-yaml");
      rosterRead = true; fleet = yaml.load(text);
    }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    if (rosterRead && (!fleet || typeof fleet !== "object" || Array.isArray(fleet))) throw new Error("invalid fleet configuration");
    const rows = fleet && typeof fleet === "object" && !Array.isArray(fleet)
      ? (fleet as { instances?: unknown }).instances : undefined;
    if (rows !== undefined && (!rows || typeof rows !== "object" || Array.isArray(rows))) throw new Error("invalid instance roster");
    const roster = (rows ?? {}) as Record<string, { working_directory?: unknown }>;
    const defaults = (fleet as { defaults?: unknown } | undefined)?.defaults ?? {};
    if (typeof defaults !== "object" || Array.isArray(defaults)) throw new Error("invalid fleet defaults");
    const configured = (name: string, row: { working_directory?: unknown }) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid instance record");
      // The loader merges defaults first, skips undefined overrides, then falls back on a falsy cwd.
      // Only records in fleet.instances inherit these defaults; dynamic Classic instances do not.
      const raw = row.working_directory === undefined ? (defaults as { working_directory?: unknown }).working_directory : row.working_directory;
      if (raw && (typeof raw !== "string" || !raw.trim())) throw new Error("unknown working directory");
      const path = raw ? resolve((raw as string).replace(/^~(?=\/|$)/, homedir())) : resolve(state!, "workspaces", name);
      // Permit an alias of the state root, never an alias of an individual managed directory.
      return under(path, states[0]!) ? resolve(state!, relative(states[0]!, path)) : path;
    };
    const hasRecord = Object.hasOwn(roster, opts.instance);
    const row = roster[opts.instance];
    const expected = hasRecord ? configured(opts.instance, row!) : resolve(state, "workspaces", opts.instance);
    const launchMatches = !opts.configuredWorkspace || configured(opts.instance, { working_directory: opts.configuredWorkspace }) === expected;
    // A nonstandard name can only come from the configured record/defaults above, never the shell cwd.
    const workspaces = resolve(state, "workspaces");
    const workspaceDirectory = expected !== workspaces && under(expected, workspaces);
    const parts = relative(state, expected).split(sep);
    const reserved = expected === state || !under(expected, state) || parts.some(part => part.startsWith(".") || sensitivePart(part))
      || (reservedStateRoots.has(parts[0]!) && !workspaceDirectory);
    if (launchMatches && !reserved && under(workspace, expected)) {
      let exclusive = true;
      const peerRoots = new Set<string>();
      for (const [name, peer] of Object.entries(roster)) {
        if (name === opts.instance) continue;
        if (!plainCaller(name)) throw new Error("invalid instance name");
        // A peer's standard workspace remains theirs even when their configured cwd is elsewhere.
        peerRoots.add(configured(name, peer)); peerRoots.add(resolve(state, "workspaces", name));
      }
      for (const name of await classicPeerNames(state, fleet)) if (name !== opts.instance) peerRoots.add(resolve(state, "workspaces", name));
      for (const named of peerRoots) {
        let actual = named;
        try { actual = await realpath(named); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
        if (under(named, expected) || under(expected, named) || under(actual, expected) || under(expected, actual)) exclusive = false;
      }
      try {
        // A symlink named General (or one of its ancestors) cannot authorize another directory.
        if (exclusive && await realpath(expected) === expected) { own = expected; ownWorkspace = workspaceDirectory; }
      } catch { /* no readable, canonical managed directory: no exception */ }
    }
  }
  const areas: string[] = [];
  if (own && !ownWorkspace) for (const dir of staging) {
    const expected = resolve(own, dir);
    try { if (await realpath(expected) === expected) areas.push(expected); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") areas.push(expected); else throw err; }
  }
  return { workspace, managedState, stateBlocked: path => {
    if (managedState && !own) return true;
    if (state && under(path, states[0]!)) path = resolve(state, relative(states[0]!, path));
    if (!states.some(root => under(path, root))) return false;
    if (!own || !under(path, own)) return true;
    const rel = relative(own, path), parts = rel.split(sep);
    if (parts.some(sensitivePart)) return true;
    // .agend is a private namespace; only the two existing generated-output directories are readable.
    if (parts.includes(".agend") && !(parts[0] === ".agend" && ["appearance", "mods"].includes(parts[1] ?? "") && !parts.slice(1).includes(".agend"))) return true;
    return !ownWorkspace && !areas.some(area => under(path, area));
  } };
}

export async function readAgentFile(file: unknown, opts: AgentFileContext & { maxBytes: number }): Promise<AgentFileRead> {
  if (typeof file !== "string" || !file.trim() || file.includes("\0")) return { ok: false, reason: "a file path in your working directory" };
  if (!opts.workspace) return { ok: false, reason: "this instance has no working directory" };
  const path = isAbsolute(file) ? file : resolve(opts.workspace, file);
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const own = await lstat(path);
    if (own.isSymbolicLink()) return { ok: false, reason: "a symlink" };
    if (!own.isFile()) return { ok: false, reason: "not a regular file" };
    const real = await realpath(path);
    const scope = await agentFileScope(opts), ws = scope.workspace;
    if (!under(real, ws)) return { ok: false, reason: "outside your working directory" };
    if (scope.stateBlocked(real) || scope.stateBlocked(path)) return { ok: false, reason: "inside the AgEnD state directory" };
    fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY);
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, reason: "not a regular file" };
    if (scope.managedState && st.nlink !== 1) return { ok: false, reason: "a hard-linked state file" };
    if (st.size > opts.maxBytes) return { ok: false, reason: `over the size limit (${Math.floor(opts.maxBytes / 1024)} KiB)` };
    const named = await stat(real);
    if (named.dev !== st.dev || named.ino !== st.ino) return { ok: false, reason: "replaced while it was opened" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const { bytesRead } = await fh.read(buf, off, st.size - off, off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return { ok: true, bytes: off === st.size ? buf : buf.subarray(0, off) };
  } catch {
    return { ok: false, reason: "cannot be read" };
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * #1629 r4 §1: write a file the fleet produced for the agent (preview_web_appearance's SVGs) into its own working
 * directory, on the agent's side — the daemon or the CLI; the fleet never names a path. `dir` is a fixed relative path
 * (".agend/appearance"); each of its folders is created if missing and must not be a symlink; the result must be in
 * the working directory and outside AgEnD state except the caller's own workspace (a $HOME cwd holds ~/.agend). The
 * file goes to a new temporary name (O_EXCL | O_NOFOLLOW) and is renamed over `name`, so a planted symlink is replaced,
 * never followed.
 */
export async function writeAgentFile(dir: string, name: string, bytes: Uint8Array, opts: AgentFileContext): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (!opts.workspace) return { ok: false, reason: "this instance has no working directory" };
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".") || dir.split("/").some(p => !/^[A-Za-z0-9._-]+$/.test(p) || p === "..")) return { ok: false, reason: "not a plain name" };
  const { mkdir, rename, unlink } = await import("node:fs/promises");
  const { randomBytes } = await import("node:crypto");
  try {
    const scope = await agentFileScope(opts), ws = scope.workspace;
    // Refused before anything is created (#1890 review: a $HOME working directory got ~/.agend/appearance first).
    if (scope.stateBlocked(resolve(ws, dir)) || scope.stateBlocked(resolve(ws, dir, name))) return { ok: false, reason: "inside the AgEnD state directory" };
    let at = ws;
    for (const part of dir.split("/")) {
      at = resolve(at, part);
      try {
        const st = await lstat(at);
        if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: `${part} is not a plain folder` };
      } catch { await mkdir(at, { mode: 0o700 }); }
    }
    const real = await realpath(at);
    if (!under(real, ws)) return { ok: false, reason: "outside your working directory" };
    if (scope.stateBlocked(real)) return { ok: false, reason: "inside the AgEnD state directory" };
    const tmp = resolve(real, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
    const fh = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await fh.writeFile(bytes); } finally { await fh.close(); }
    const final = resolve(real, name);
    try { await rename(tmp, final); } catch (err) { await unlink(tmp).catch(() => {}); throw err; }
    return { ok: true, path: final };
  } catch {
    return { ok: false, reason: "cannot be written" };
  }
}
