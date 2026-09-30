import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clampContextPercent, parseContextPercent } from "./context-percent.js";
import { readClassicLastActivityAt } from "./classic-channel-manager.js";
import { getTreeRssKb } from "./process-memory.js";

/**
 * Per-instance row collection for `agend ls`, extracted so the concurrency is
 * testable (cli.ts self-executes on import via program.parse()).
 *
 * The expensive part of a row is the tmux capture-pane for the context %:
 * historically one blocking 2s-timeout capture per instance, serially, so N
 * instances cost up to N×2s. Rows are now collected concurrently — total time
 * is ~max(one instance), and one hung pane degrades its own row instead of
 * stalling the list. All values stay identical to the serial version.
 */

export function formatTimeSince(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Async capture-pane with the same 2s bound the serial version had. */
export function capturePaneAsync(
  sessionName: string, socket: string | null, target: string, timeoutMs = 2000,
): Promise<string> {
  const args = socket
    ? ["-L", socket, "capture-pane", "-t", `${sessionName}:${target}`, "-p"]
    : ["capture-pane", "-t", `${sessionName}:${target}`, "-p"];
  return new Promise<string>((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf-8", timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export interface LsRowInput {
  name: string;
  isClassic: boolean;
  status: "running" | "paused" | "stopped" | "crashed";
  teams: string[];
  backend: string;
  source: string;
}

export interface LsRowEnv {
  dataDir: string;
  pidByName: Map<string, number>;
  capturePane: (target: string) => Promise<string>;
  /** Backstop per row so a hung capture dependency cannot stall the list. */
  rowTimeoutMs?: number;
}

export interface LsRow {
  name: string;
  backend: string;
  status: "running" | "paused" | "stopped" | "crashed";
  teams: string[];
  source: string;
  context: number | null;
  memMb: number | null;
  lastActivity: string | null;
  classic: boolean;
  idle: boolean | undefined;
  state: "idle" | "working" | "stuck" | "paused" | null | undefined;
}

/** Generous backstop: a healthy row resolves inside the 2s capture bound. */
export const LS_ROW_TIMEOUT_MS = 10_000;

/* ---------------------------------------------------------- shared display */

/** Display width accounting for fullwidth (CJK) characters. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    // … and ─ render one column despite being above ASCII; zero-width
    // space renders none.
    w += (cp > 0x7f && cp !== 0x200b && cp !== 0x2026 && !(cp >= 0x2500 && cp <= 0x257f)) ? 2 : 1;
  }
  return w;
}

/**
 * Truncate to a display width, keeping room for the ellipsis. Real model
 * names run to 23 columns (gemini-3.8-flash-medium, "Opus 5.5 (1M context)");
 * table columns cap them so Model never blows the table wider (#1052
 * measured the live fleet's ls table at ~121 wide on names alone).
 */
export function truncateDisplay(s: string, maxWidth: number): string {
  if (displayWidth(s) <= maxWidth) return s;
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw + 1 > maxWidth) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** Max model column: fits claude-sonnet-4.6 whole, truncates the 21+ ones. */
export const MODEL_DISPLAY_WIDTH_MAX = 20;

/**
 * Status icon shared by `agend ls` and /status's merged State column (#1052):
 * one glyph per lifecycle/execution state — ⏸ paused, ✗ stopped.
 */
export function lsStatusIcon(s: string, idle?: boolean, state?: string | null): string {
  if (s === "crashed") return "\x1b[31m●\x1b[0m";
  if (s === "stopped") return "\x1b[90m✗\x1b[0m";
  if (state === "stuck") return "\x1b[31m●\x1b[0m";
  if (state === "paused" || s === "paused") return "\x1b[2;33m○\x1b[0m";
  if (state === "working") return "\x1b[34m●\x1b[0m";
  if (state === "idle") return "\x1b[32m●\x1b[0m";
  // Fallback for when API is unreachable
  if (s === "running") return idle === false ? "\x1b[34m●\x1b[0m" : "\x1b[32m●\x1b[0m";
  return "\x1b[90m✗\x1b[0m";
}

export function lsStatusLabel(s: string, idle?: boolean, state?: string | null): string {
  if (s === "crashed") return "Crashed";
  if (s === "stopped") return "Stopped";
  if (state === "stuck") return "Stuck";
  if (state === "paused" || s === "paused") return "Paused";
  if (state === "working") return "Working";
  if (state === "idle") return "Idle";
  if (s === "running") return idle === false ? "Busy" : "Idle";
  return "Stopped";
}

function degradedRow(input: LsRowInput): LsRow {
  return {
    name: input.name, backend: input.backend, status: input.status,
    teams: input.teams, source: input.source,
    context: null, memMb: null, lastActivity: null,
    classic: input.isClassic, idle: undefined, state: undefined,
  };
}

export async function collectLsRow(input: LsRowInput, env: LsRowEnv): Promise<LsRow> {
  const { name } = input;
  const build = (async (): Promise<LsRow> => {
    // Read statusline for context. Only claude-code writes statusline.json;
    // reading it for other backends risks a stale value left over from a
    // previous backend (e.g. after switching claude-code → kiro-cli), so those
    // skip straight to the capture-pane parser below.
    let context: number | null = null;
    if (input.backend === "claude-code") {
      const statusFile = join(env.dataDir, "instances", name, "statusline.json");
      try {
        if (existsSync(statusFile)) {
          const data = JSON.parse(readFileSync(statusFile, "utf-8"));
          context = clampContextPercent(data.context_window?.used_percentage);
        }
      } catch { /* ignore */ }
    }

    // Fallback: parse context from the tmux pane. Every backend gets the
    // universal parser, so codex/agy/opencode resolve too — not just kiro.
    if (context == null) {
      try {
        context = parseContextPercent(await env.capturePane(name));
      } catch { /* tmux capture failed */ }
    }

    // Memory: sum RSS of pane process tree
    let memMb: number | null = null;
    const panePid = env.pidByName.get(name);
    if (panePid) {
      try {
        const rssKb = getTreeRssKb(panePid);
        if (rssKb > 0) memMb = Math.round(rssKb / 1024);
      } catch { /* ignore */ }
    }

    // Classic activity is channel-driven. Lightweight Classic daemons often
    // have no statusline/output log, so prefer the persisted inbound timestamp
    // and fall back to their durable chat-log mtime for pre-migration history.
    let lastActivity: string | null = null;
    if (input.isClassic) {
      let classicActivity = readClassicLastActivityAt(env.dataDir, name) ?? 0;
      try {
        const inboundPath = join(env.dataDir, "instances", name, "last-inbound-at");
        if (existsSync(inboundPath)) {
          const inboundAt = Number(readFileSync(inboundPath, "utf-8").trim());
          if (Number.isFinite(inboundAt) && inboundAt >= 0 && inboundAt <= Date.now()) {
            classicActivity = Math.max(classicActivity, inboundAt);
          }
        }
      } catch { /* ignore */ }
      if (classicActivity) {
        lastActivity = formatTimeSince(new Date(classicActivity).toISOString());
      }
    } else {
      // Fleet activity: prefer statusline.json mtime (updated on real agent activity).
      for (const probe of ["statusline.json", "daemon.log", "output.log"]) {
        const p = join(env.dataDir, "instances", name, probe);
        try {
          if (existsSync(p)) {
            lastActivity = formatTimeSince(statSync(p).mtime.toISOString());
            break;
          }
        } catch { /* ignore */ }
      }
    }

    return {
      name, backend: input.backend, status: input.status, teams: input.teams,
      source: input.source, context, memMb, lastActivity,
      classic: input.isClassic, idle: undefined, state: undefined,
    };
  })();

  // Isolation: an unexpected throw — or a capture dependency that never
  // settles — degrades this row instead of killing the whole listing. The
  // rejection handler on `settled` also means a late-settling build never
  // surfaces as an unhandled rejection.
  const settled = build.then(
    (row): LsRow => row,
    (): LsRow => degradedRow(input),
  );
  const timeoutMs = env.rowTimeoutMs ?? LS_ROW_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<LsRow>(resolve => {
      timer = setTimeout(() => resolve(degradedRow(input)), timeoutMs);
    });
    return await Promise.race([settled, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collect every row concurrently: total time is ~max(one instance), not the
 * sum. A rejected row is already degraded inside collectLsRow, so allSettled
 * semantics fall out without losing the failure isolation.
 */
export function collectLsRows(inputs: LsRowInput[], env: LsRowEnv): Promise<LsRow[]> {
  return Promise.all(inputs.map(input => collectLsRow(input, env)));
}
