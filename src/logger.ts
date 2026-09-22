import pino from "pino";
import { join } from "node:path";
import { mkdirSync, statSync, fstatSync, existsSync, unlinkSync, renameSync, copyFileSync, truncateSync } from "node:fs";
import { getAgendHome } from "./paths.js";

const DATA_DIR = getAgendHome();
const LOG_FILE = join(DATA_DIR, "daemon.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const ROTATE_MAX_FILES = 3;

/**
 * fleet.log is the service manager's stdout destination, not pino's direct
 * file transport (which writes daemon.log). Detect that regular-file stdout so
 * it receives a date; terminals and pipes keep the compact console format.
 */
function stdoutIsRegularFile(): boolean {
  try { return fstatSync(1).isFile(); } catch { return false; }
}

export function getStdoutPrettyOptions(destinationIsFile = stdoutIsRegularFile()) {
  return {
    destination: 1,
    colorize: !destinationIsFile,
    translateTime: destinationIsFile ? "SYS:yyyy-mm-dd HH:MM:ss" : "SYS:HH:MM:ss",
    ignore: "pid,hostname",
  };
}

/**
 * Rotate a log file via copytruncate: foo.log → foo.log.1 → foo.log.2 → foo.log.3 (deleted).
 *
 * We copy-then-truncate rather than rename the live log. pino (and any other
 * writer) holds an open fd to the original inode; renaming the file would leave
 * the writer appending to the rotated copy while the fresh log stays empty.
 * truncateSync resets the same inode to size 0 in place, so the held fd keeps
 * writing to the now-empty file. Copying before truncating means no data loss.
 */
export function rotateLogIfNeeded(logPath: string, maxSize = MAX_LOG_SIZE, maxFiles = ROTATE_MAX_FILES): void {
  try {
    if (!existsSync(logPath)) return;
    const stat = statSync(logPath);
    if (stat.size < maxSize) return;

    // Ballooned far past the limit (e.g. never-rotated TUI animation flood at
    // hundreds of MB): drop content in place. Copying a 700MB+ file to .1 is
    // slow and wasteful; the open writer (pipe-pane `cat >>`, pino) keeps the
    // same inode so truncate is enough.
    if (stat.size > maxSize * 10) {
      for (let i = 1; i <= maxFiles; i++) {
        try { unlinkSync(`${logPath}.${i}`); } catch { /* no rotated file */ }
      }
      truncateSync(logPath, 0);
      return;
    }

    // Shift existing rotated files: .2 → .3 (oldest deleted), .1 → .2, …
    for (let i = maxFiles; i >= 2; i--) {
      const src = `${logPath}.${i - 1}`;
      const dst = `${logPath}.${i}`;
      if (i === maxFiles) { try { unlinkSync(dst); } catch {} }
      if (existsSync(src)) { try { renameSync(src, dst); } catch {} }
    }
    // Copy current content to .1, then truncate the live file in place so the
    // writer's open fd keeps appending to the same (now-empty) inode.
    copyFileSync(logPath, `${logPath}.1`);
    truncateSync(logPath, 0);
  } catch { /* best effort */ }
}

/**
 * One transport per process, shared by every logger built here.
 *
 * `pino({ transport })` builds a fresh transport per logger, and a transport
 * spawns a worker thread per target and registers a `process.on("exit")`
 * handler. FleetManager creates its logger in a field initializer, so a process
 * that builds several of them — which is every test run — accumulated both, and
 * past ten listeners Node reported an exit-listener leak it was right about.
 *
 * Sharing the STREAM rather than the logger is deliberate: callers still get
 * their own logger object, so a test that spies on one fleet's `logger.debug`
 * does not see another fleet's calls. Memoising the logger itself broke exactly
 * that.
 */
let sharedTransport: ReturnType<typeof pino.transport> | undefined;

function transportStream() {
  // Typed loosely on purpose: pino.transport()'s own option type narrows
  // `destination` to a file descriptor, while pino-pretty takes a path.
  const targets: { target: string; options: Record<string, unknown>; level: string }[] = [
      {
        target: "pino-pretty",
        options: getStdoutPrettyOptions(),
        // The root/child logger level performs per-component filtering. Keep
        // transports permissive so a debug-level daemon child is not filtered
        // by an info-level fleet root before it reaches the shared worker.
        level: "trace",
      },
      {
        target: "pino-pretty",
        options: {
          destination: LOG_FILE,
          colorize: false,
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
          ignore: "pid,hostname",
        },
        level: "trace",
      },
  ];
  sharedTransport ??= pino.transport({ targets });
  return sharedTransport;
}

export function createLogger(level: string = "info") {
  mkdirSync(DATA_DIR, { recursive: true });
  rotateLogIfNeeded(LOG_FILE);
  return pino({ level }, transportStream());
}

export type Logger = ReturnType<typeof createLogger>;
