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

export function createLogger(level: string = "info") {
  mkdirSync(DATA_DIR, { recursive: true });
  rotateLogIfNeeded(LOG_FILE);
  return pino({
    level,
    transport: {
      targets: [
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
      ],
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
