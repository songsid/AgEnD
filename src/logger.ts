import pino from "pino";
import { join } from "node:path";
import { mkdirSync, statSync, existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { getAgendHome } from "./paths.js";

const DATA_DIR = getAgendHome();
const LOG_FILE = join(DATA_DIR, "daemon.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const ROTATE_MAX_FILES = 3;

/** Rotate a log file: foo.log → foo.log.1 → foo.log.2 → foo.log.3 (deleted) */
export function rotateLogIfNeeded(logPath: string, maxSize = MAX_LOG_SIZE, maxFiles = ROTATE_MAX_FILES): void {
  try {
    if (!existsSync(logPath)) return;
    const stat = statSync(logPath);
    if (stat.size < maxSize) return;

    // Shift existing rotated files
    for (let i = maxFiles; i >= 1; i--) {
      const src = i === 1 ? logPath : `${logPath}.${i - 1}`;
      const dst = `${logPath}.${i}`;
      if (i === maxFiles) { try { unlinkSync(dst); } catch {} }
      if (existsSync(src)) { try { renameSync(src, dst); } catch {} }
    }
    // Truncate current log
    writeFileSync(logPath, "");
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
          options: {
            destination: 1,
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
          level,
        },
        {
          target: "pino-pretty",
          options: {
            destination: LOG_FILE,
            colorize: false,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
          level,
        },
      ],
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
