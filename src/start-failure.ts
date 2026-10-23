/**
 * #2481: a fleet that cannot start after an upgrade is told, plainly, to the person — never rolled back.
 *
 * An updater can only judge what it sees while it runs. 2.2.6's, under launchd, takes the first running pid of the new
 * job for a successful start (#2481), and any updater misses a fleet that starts and then fails a few minutes later.
 * The installed version then crash-loops under the service manager, with the person told the update succeeded. This
 * module is what every `agend` command and `agend doctor` consult afterwards:
 *
 * - `fleet-start-attempts.json` — written by `fleet start` as the first import of dist/cli.js (start-attempt.ts), so
 *   before anything later in the module graph can throw; the last attempts of the installed version.
 * - `fleet-started.json` — written by the fleet only when its startup completes (with READY=1); the versions that ran.
 * - the service manager's own counters — launchd's runs and last exit code, systemd's state, result and restarts — for
 *   failures before any of our code runs (a broken package, a missing file).
 *
 * The check costs nothing once the installed version has started: `fleet-started.json` names it and nothing else is
 * read. It never fires for a slow start (one attempt, the job running), a deliberate stop (the job not loaded, or
 * systemd inactive with Result=success), or a package installed less than 90 s ago.
 *
 * #2490: the same notice in chat (General, else the admin's DM): notifyChatOnce, from start-attempt.ts, runs
 * start-failure-chat.js once per version, on its third failed start.
 *
 * Only node built-ins (and child-process.ts, itself only built-ins): start-attempt.ts imports this before the rest of the CLI.
 */
import { spawnSync, type SpawnOptions } from "node:child_process";
import { spawn } from "./child-process.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const STARTED_FILE = "fleet-started.json";
export const ATTEMPTS_FILE = "fleet-start-attempts.json";
/** Attempts of one version within this window, with no start completed, count as a crash loop (no service to ask). */
export const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
export const LOOP_ATTEMPTS = 3;
/** A version trying to start for less than this (since its first attempt, else its install) is never judged. */
export const FRESH_INSTALL_MS = 90 * 1000;
const KEEP_ATTEMPTS = 20;
const KEEP_HISTORY = 5;

export interface StartedRecord { version: string; at: string; pid: number; history: string[] }
/** `notified`: the macOS notification went (once per version). The chat notice's claim is a file of its own (#2490). */
export interface AttemptsRecord { version: string; attempts: string[]; notified?: boolean }

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return null; }
}
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

export function readStarted(home: string): StartedRecord | null {
  const r = readJson<StartedRecord>(join(home, STARTED_FILE));
  return r && typeof r.version === "string" && Array.isArray(r.history) ? r : null;
}
/** #2481: the versions that completed a start here; "unreadable" when the record is there but cannot be read. */
export function readStartedHistory(home: string): string[] | "unreadable" {
  if (!existsSync(join(home, STARTED_FILE))) return [];
  return readStarted(home)?.history ?? "unreadable";
}
export function readAttempts(home: string): AttemptsRecord | null {
  const r = readJson<AttemptsRecord>(join(home, ATTEMPTS_FILE));
  return r && typeof r.version === "string" && Array.isArray(r.attempts) ? r : null;
}

/** `fleet start` is running this version now. Returns the record as written. */
export function recordStartAttempt(home: string, version: string, now: number): AttemptsRecord {
  const prior = readAttempts(home);
  const same = prior?.version === version;
  const record: AttemptsRecord = {
    version,
    attempts: [...(same ? prior!.attempts : []), new Date(now).toISOString()].slice(-KEEP_ATTEMPTS),
    ...(same && prior!.notified ? { notified: true } : {}),
  };
  writeJson(join(home, ATTEMPTS_FILE), record);
  return record;
}

/** The fleet's startup completed on this version: it runs; its attempts are history. */
export function recordStarted(home: string, version: string, pid: number, now: number): void {
  const prior = readStarted(home);
  const history = [version, ...(prior?.history ?? []).filter(v => v !== version)].slice(0, KEEP_HISTORY);
  writeJson(join(home, STARTED_FILE), { version, at: new Date(now).toISOString(), pid, history } satisfies StartedRecord);
  clearStartAttempts(home);
}

/** A deliberate stop: the attempts so far are not a crash loop. */
export function clearStartAttempts(home: string): void {
  try { unlinkSync(join(home, ATTEMPTS_FILE)); } catch { /* none */ }
}

/** What the service manager says of the fleet's job; null when it cannot be read. */
export type ManagerView =
  | { kind: "launchd"; loaded: false }
  | { kind: "launchd"; loaded: true; state: string; runs: number | null; lastExit: number | null; pid: number | null }
  | { kind: "systemd"; active: string; sub: string; result: string; restarts: number | null; status: number | null };

export function parseLaunchctlPrint(stdout: string): ManagerView {
  const field = (key: string) => new RegExp(`^\\s*${key} = (.+?)\\s*$`, "m").exec(stdout)?.[1] ?? null;
  const num = (v: string | null) => (v !== null && /^-?\d+$/.test(v) ? Number(v) : null);
  return { kind: "launchd", loaded: true, state: field("state") ?? "", runs: num(field("runs")), lastExit: num(field("last exit code")), pid: num(field("pid")) };
}

export function parseSystemctlShow(stdout: string): ManagerView {
  const props: Record<string, string> = {};
  for (const line of stdout.split("\n")) { const at = line.indexOf("="); if (at > 0) props[line.slice(0, at)] = line.slice(at + 1).trim(); }
  const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  return { kind: "systemd", active: props.ActiveState ?? "", sub: props.SubState ?? "", result: props.Result ?? "", restarts: num(props.NRestarts), status: num(props.ExecMainStatus) };
}

const FAILED_RESULTS = new Set(["exit-code", "signal", "core-dump", "start-limit-hit", "timeout", "watchdog"]);

/**
 * Does the manager show this job failing to start, again and again? `recentAttempts`: this version's, within the window.
 * launchd keeps `last exit code` and counts `runs` for as long as the job stays loaded: a job running now (a pid) may
 * just be slow — a #2461 memory-deferred start takes minutes — so for it only our own recent attempts say it restarts.
 */
export function managerShowsLoop(view: ManagerView, recentAttempts: number): boolean {
  if (view.kind === "launchd") {
    if (!view.loaded) return false;                                  // not loaded: stopped on purpose
    const exitedBadly = view.lastExit !== null && view.lastExit !== 0;
    if (!exitedBadly) return false;
    if (view.state === "running" && view.pid !== null) return recentAttempts >= LOOP_ATTEMPTS;
    return recentAttempts >= 2 || (view.runs ?? 0) >= LOOP_ATTEMPTS;
  }
  if (view.active === "failed") return view.result !== "success";
  if (view.sub === "auto-restart") return true;
  return FAILED_RESULTS.has(view.result) && (view.restarts ?? 0) >= 2;
}

export type StartFailure =
  | { failing: false }
  | { failing: true; version: string; previous: Previous | null; detail: string };

/** The version to go back to, and the package copy an updater kept of it (its path), when there is one. */
export interface Previous { version: string; copy: string | null }
/** A package copy an updater kept: `<prefix>/.agend-rollback/<version>-<time>[-<pid>]/agend`. */
export interface KeptCopy { version: string; path: string }

/**
 * The decision, from what was read (pure). `manager`: undefined — no service installed; null — one is, but it could
 * not be read; then only our own attempts record can tell.
 */
export function judgeStartFailure(input: {
  installed: string; packageAgeMs: number; now: number;
  started: StartedRecord | null; attempts: AttemptsRecord | null; manager: ManagerView | null | undefined;
  keptCopies?: KeptCopy[];
}): StartFailure {
  const { installed, started } = input;
  if (started?.version === installed) return { failing: false };
  const mine = input.attempts?.version === installed ? input.attempts.attempts : [];
  // How long this version has been trying to start: since its first recorded attempt, else since it was installed.
  const firstAttempt = mine.length ? Date.parse(mine[0]!) : NaN;
  const tryingMs = Number.isFinite(firstAttempt) ? input.now - firstAttempt : input.packageAgeMs;
  if (tryingMs < FRESH_INSTALL_MS) return { failing: false };
  const recent = mine.filter(a => { const at = Date.parse(a); return Number.isFinite(at) && input.now - at <= ATTEMPT_WINDOW_MS && at <= input.now; });
  let detail: string | null = null;
  if (input.manager) {
    if (!managerShowsLoop(input.manager, recent.length)) return { failing: false };
    detail = input.manager.kind === "launchd"
      ? `launchd: exit ${(input.manager as { lastExit: number | null }).lastExit}, started ${(input.manager as { runs: number | null }).runs ?? "?"} times`
      : `systemd: ${input.manager.active}/${input.manager.sub}, result ${input.manager.result || "?"}, restarted ${input.manager.restarts ?? "?"} times`;
  } else {
    if (input.manager === undefined && started === null && mine.length === 0) return { failing: false };   // never run here
    if (recent.length < LOOP_ATTEMPTS) return { failing: false };
    detail = `${recent.length} start attempts in the last ${ATTEMPT_WINDOW_MS / 60000} minutes, none completed`;
  }
  return { failing: true, version: installed, previous: previousVersion(installed, started, input.keptCopies ?? []), detail };
}

/**
 * The version to go back to: the newest that ran here, else the newest copy an updater kept (2.2.6's updater keeps the
 * one it took before a launchd activation it judged successful); never the installed one. Its kept copy, when there is
 * one, is named too — for the person to see; nothing here restores it.
 */
export function previousVersion(installed: string, started: StartedRecord | null, kept: KeptCopy[]): Previous | null {
  const copyOf = (v: string) => kept.find(c => c.version === v)?.path ?? null;
  for (const v of started?.history ?? []) if (v !== installed) return { version: v, copy: copyOf(v) };
  for (const c of kept) if (c.version !== installed) return { version: c.version, copy: c.path };
  return null;
}

/** The package copies updaters kept in `<prefix>/.agend-rollback/<version>-<time>[-<pid>]/agend`, newest first. */
export function keptCopies(prefix: string): KeptCopy[] {
  const base = join(prefix, ".agend-rollback");
  let names: string[] = [];
  try { names = readdirSync(base); } catch { return []; }
  return names
    .map(name => ({ name, version: /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+?)?)-\d{4}-\d\d-\d\dT/.exec(name)?.[1] ?? null, mtime: (() => { try { return statSync(join(base, name)).mtimeMs; } catch { return 0; } })() }))
    .filter((e): e is { name: string; version: string; mtime: number } => e.version !== null && existsSync(join(base, e.name, "agend", "package.json")))
    .sort((a, b) => b.mtime - a.mtime)
    .map(e => ({ version: e.version, path: join(base, e.name, "agend") }));
}

/** This package: its root, version and npm prefix (`<prefix>/lib/node_modules/@songsid/agend`, or Windows' layout). */
export function ownPackage(): { root: string; version: string | null; prefix: string | null } {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const version = readJson<{ version?: string }>(join(root, "package.json"))?.version ?? null;
  return { root, version, prefix: npmPrefixOf(root) };
}

/** npm's global prefix for a package root: `<prefix>/lib/node_modules/…` (Unix) or `<prefix>/node_modules/…`; else null. */
export function npmPrefixOf(root: string): string | null {
  const parts = root.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  if (at <= 0) return null;
  return parts.slice(0, parts[at - 1] === "lib" ? at - 1 : at).join("/") || "/";
}

type Run = (cmd: string, args: string[]) => { status: number | null; stdout: string; error?: unknown };
const defaultRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  return { status: r.status, stdout: r.stdout ?? "", error: r.error };
};

/** The AgEnD service on this host, as `agend restart` chooses it; undefined when none is installed. */
export function readManager(run: Run = defaultRun, opts: { platform?: NodeJS.Platform; home?: string; uid?: number } = {}): ManagerView | null | undefined {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  if (platform === "darwin") {
    if (!existsSync(join(home, "Library", "LaunchAgents", "com.agend.fleet.plist"))) return undefined;
    const r = run("launchctl", ["print", `gui/${opts.uid ?? process.getuid?.() ?? 501}/com.agend.fleet`]);
    if (r.error || r.status === null) return null;
    if (r.status === 113 || r.status === 125) return { kind: "launchd", loaded: false };
    return r.status === 0 ? parseLaunchctlPrint(r.stdout) : null;
  }
  const system = existsSync("/etc/systemd/system/agend.service");
  const user = existsSync(join(home, ".config", "systemd", "user", "com.agend.fleet.service"));
  if (!system && !user) return undefined;
  const r = run("systemctl", [...(system ? [] : ["--user"]), "show", "-p", "ActiveState,SubState,Result,NRestarts,ExecMainStatus", system ? "agend" : "com.agend.fleet"]);
  if (r.error || r.status !== 0) return null;
  return parseSystemctlShow(r.stdout);
}

/** The whole check for this installed package; `{failing:false}` at once when it has started here. */
export function checkStartFailure(home: string, now = Date.now(), run?: Run): StartFailure {
  const own = ownPackage();
  if (!own.version) return { failing: false };
  const started = readStarted(home);
  if (started?.version === own.version) return { failing: false };
  // No attempt of this version recorded: its fleet never reached dist/cli.js's first import — and then this CLI, the same
  // entry, would not be running either. Nothing to judge, and no service manager is asked (every command stays as it was).
  const attempts = readAttempts(home);
  if (attempts?.version !== own.version) return { failing: false };
  let packageAgeMs = 0;
  try { packageAgeMs = now - statSync(own.root).mtimeMs; } catch { return { failing: false }; }
  return judgeStartFailure({
    installed: own.version, packageAgeMs, now, started, attempts,
    manager: readManager(run), keptCopies: own.prefix ? keptCopies(own.prefix) : [],
  });
}

/** The last lines of fleet.log — the service's own stdout/stderr — where the failure itself is. */
export function fleetLogTail(home: string, lines = 15): string[] {
  try { return readFileSync(join(home, "fleet.log"), "utf8").trimEnd().split("\n").slice(-lines); } catch { return []; }
}

/**
 * macOS: one notification per version, the 3rd failed attempt in a row (best effort; never blocks, never throws).
 * English only: it runs before any config is read; `agend doctor` says the rest in the fleet's language.
 */
/** How the notification is launched (tests pass a fake). */
export type Launch = (cmd: string, args: string[], opts: SpawnOptions) => { on?: (event: "error", cb: () => void) => unknown; unref?: () => void };
const defaultLaunch: Launch = (cmd, args, opts) => spawn(cmd, args, opts);

export function notifyOnce(home: string, record: AttemptsRecord, platform: NodeJS.Platform = process.platform, launch: Launch = defaultLaunch): boolean {
  if (platform !== "darwin" || record.notified || record.attempts.length < LOOP_ATTEMPTS) return false;
  try {
    writeJson(join(home, ATTEMPTS_FILE), { ...record, notified: true });
    const text = `AgEnD v${record.version} is installed but the fleet fails to start. Run: agend doctor`;
    const child = launch("osascript", ["-e", `display notification ${JSON.stringify(text)} with title "AgEnD"`], { detached: true, stdio: "ignore" });
    child.on?.("error", () => { /* no osascript: the banner and doctor remain */ });
    child.unref?.();
    return true;
  } catch { return false; }
}

// ── #2490: the chat notice (posted by start-failure-chat.ts) ────────────────────────────────────────────────────

/** How long a failing `fleet start` waits, once per version, for the notice to go out. */
export const CHAT_NOTICE_TIMEOUT_MS = 10_000;

/** This version's attempts within the window (the loop #2488/#2490/#2481's auto-restore judge). */
export function recentAttemptCount(record: AttemptsRecord, now: number): number {
  return record.attempts.filter(a => { const at = Date.parse(a); return Number.isFinite(at) && at <= now && now - at <= ATTEMPT_WINDOW_MS; }).length;
}

/** Is this attempt the one that sends the chat notice? This version's third start in the window, none completed. */
export function chatNoticeDue(record: AttemptsRecord, started: StartedRecord | null, now: number): boolean {
  if (started?.version === record.version) return false;
  return recentAttemptCount(record, now) >= LOOP_ATTEMPTS;
}

/** The chat notice's claim for a version: created once, O_EXCL — no rewrite of the attempts record can undo it. */
export function chatClaimFile(home: string, version: string): string | null {
  return /^[0-9A-Za-z.+-]{1,64}$/.test(version) ? join(home, `${CHAT_CLAIM_PREFIX}${version}`) : null;
}
const CHAT_CLAIM_PREFIX = "fleet-start-chat-notified-";

/**
 * Claim the chat notice for this version, atomically across processes (an O_EXCL create): true for exactly one caller,
 * ever. The other versions' claims go (best effort): a later version gets its own notice, and a reinstalled one again.
 */
export function claimChatNotice(home: string, version: string): boolean {
  const file = chatClaimFile(home, version);
  if (!file) return false;
  try { writeFileSync(file, new Date().toISOString() + "\n", { flag: "wx", mode: 0o600 }); }
  catch { return false; }
  try {
    for (const name of readdirSync(home)) {
      if (name.startsWith(CHAT_CLAIM_PREFIX) && join(home, name) !== file) { try { unlinkSync(join(home, name)); } catch { /* gone */ } }
    }
  } catch { /* the claim stands */ }
  return true;
}

export type RunChild = (cmd: string, args: string[], opts: { timeout: number }) => void;
const defaultRunChild: RunChild = (cmd, args, opts) => {
  // stderr is the service's log (fleet.log): the child's one line goes there. Its exit is not waited past the timeout.
  spawnSync(cmd, args, { timeout: opts.timeout, stdio: ["ignore", "ignore", "inherit"], killSignal: "SIGKILL" });
};

/**
 * #2490, from start-attempt.ts: when this attempt is the one (chatNoticeDue), claim the chat notice and run
 * start-failure-chat.js, which posts it; wait for it at most CHAT_NOTICE_TIMEOUT_MS. Never throws. True when it ran.
 */
export function notifyChatOnce(home: string, version: string, now: number, run: RunChild = defaultRunChild): boolean {
  try {
    const record = readAttempts(home);
    if (!record || record.version !== version || !chatNoticeDue(record, readStarted(home), now)) return false;
    if (!claimChatNotice(home, version)) return false;
    run(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "start-failure-chat.js"), home], { timeout: CHAT_NOTICE_TIMEOUT_MS });
    return true;
  } catch { return false; }
}

/**
 * #2481 auto-restore: the notices, with the restore wording, before the swap moves this package (and the chat script)
 * away. The chat notice takes #2490's per-version claim, so it replaces the plain one; the macOS notification its mark.
 * Never throws.
 */
export function notifyRestore(home: string, from: string, to: string, preimage: string, opts: {
  run?: RunChild; launch?: Launch; platform?: NodeJS.Platform;
} = {}): void {
  try {
    const record = readAttempts(home);
    if (record && record.version === from && !record.notified && (opts.platform ?? process.platform) === "darwin") {
      writeJson(join(home, ATTEMPTS_FILE), { ...record, notified: true });
      const text = `AgEnD v${from} failed to start; restoring v${to} automatically. Run: agend doctor`;
      const child = (opts.launch ?? defaultLaunch)("osascript", ["-e", `display notification ${JSON.stringify(text)} with title "AgEnD"`], { detached: true, stdio: "ignore" });
      child.on?.("error", () => { /* no osascript */ });
      child.unref?.();
    }
  } catch { /* best effort */ }
  try {
    if (!claimChatNotice(home, from)) return;
    (opts.run ?? defaultRunChild)(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "start-failure-chat.js"), home, "--restore", from, to, preimage], { timeout: CHAT_NOTICE_TIMEOUT_MS });
  } catch { /* best effort */ }
}

/**
 * #2481, Fable r1 on #2526: the restore did not happen, but its notices said it was happening (and took #2490's chat
 * claim). The correction, once per version (its own O_EXCL claim): the failure and the way back by hand. `packageAt`:
 * where the installed package — and the chat script — is now (the failed tree when even the rename back failed).
 */
export function notifyRestoreFailed(home: string, from: string, to: string, reason: string, packageAt: string, opts: {
  run?: RunChild; launch?: Launch; platform?: NodeJS.Platform;
} = {}): boolean {
  try {
    if (!/^[0-9A-Za-z.+-]{1,64}$/.test(from)) return false;
    try { writeFileSync(join(home, `fleet-start-restore-failed-${from}`), new Date().toISOString() + "\n", { flag: "wx", mode: 0o600 }); }
    catch { return false; }
    if ((opts.platform ?? process.platform) === "darwin") {
      try {
        const text = `AgEnD v${from} fails to start; restoring v${to} automatically did not work. Run: agend doctor`;
        const child = (opts.launch ?? defaultLaunch)("osascript", ["-e", `display notification ${JSON.stringify(text)} with title "AgEnD"`], { detached: true, stdio: "ignore" });
        child.on?.("error", () => { /* no osascript */ });
        child.unref?.();
      } catch { /* the chat notice and doctor remain */ }
    }
    (opts.run ?? defaultRunChild)(process.execPath, [join(packageAt, "dist", "start-failure-chat.js"), home, "--restore-failed", from, to, reason], { timeout: CHAT_NOTICE_TIMEOUT_MS });
    return true;
  } catch { return false; }
}
