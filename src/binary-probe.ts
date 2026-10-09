import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Where an executable is on PATH, found without forking (#1490).
 *
 * `/ui/backends` used to run `execFileSync("which", …)` seven times per request, each with a 2 s timeout, on the fleet's
 * event loop: up to ~14 s of blocking per request on a slow or broken PATH. This walks PATH with asynchronous fs calls
 * instead, so a hung entry (a dead network mount) occupies a libuv thread, never the event loop, and nothing is spawned.
 *
 * Same answer as `which` for what AgEnD asks: the first PATH directory holding a regular file the process may execute.
 * Relative PATH entries are skipped (as a shell's `which` resolves them against a cwd the fleet does not share).
 */
export async function findOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!binary || binary.includes("/") || binary.includes("\\")) return null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, binary);
    try {
      await access(candidate, fsConstants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

/** How long a probe answer is reused: long enough that a polled route never repeats the walk, short enough to see installs. */
export const BINARY_PROBE_TTL_MS = 30_000;

type Entry = { at: number; path: string | null } | { pending: Promise<string | null> };

/**
 * Probe answers per binary, reused for BINARY_PROBE_TTL_MS (monotonic clock), with concurrent probes of one binary
 * sharing one walk. `fresh: true` starts its own walk (an install just ran: neither a cached answer nor a walk that
 * began before it will do) and supersedes the one in flight; `invalidate()` drops answers so a probe already in flight
 * cannot store a stale one.
 */
export class BinaryProbe {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly find: (binary: string) => Promise<string | null> = (b) => findOnPath(b),
    private readonly now: () => number = () => performance.now(),
    private readonly ttlMs = BINARY_PROBE_TTL_MS,
  ) {}

  /** The binary's path, or null when it is not on PATH. */
  probe(binary: string, opts: { fresh?: boolean } = {}): Promise<string | null> {
    const entry = this.entries.get(binary);
    if (!opts.fresh && entry && "pending" in entry) return entry.pending;
    if (!opts.fresh && entry && "at" in entry && this.now() - entry.at < this.ttlMs) return Promise.resolve(entry.path);
    const pending = this.find(binary).catch(() => null).then((path) => {
      // Only the walk that is still current may store its answer: invalidate() or a fresh probe replaced it otherwise.
      const now = this.entries.get(binary);
      if (now && "pending" in now && now.pending === pending) {
        this.entries.set(binary, { at: this.now(), path });
      }
      return path;
    });
    this.entries.set(binary, { pending });
    return pending;
  }

  /** Forget every answer (or one binary's); probes already running will not store theirs. */
  invalidate(binary?: string): void {
    if (binary === undefined) this.entries.clear();
    else this.entries.delete(binary);
  }
}

/** The fleet process's shared probe. */
export const binaryProbe = new BinaryProbe();
