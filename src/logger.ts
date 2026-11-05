import { ensureAgendHome } from "./agend-home.js";
import pino from "pino";
import { join } from "node:path";
import { statSync, fstatSync, existsSync, unlinkSync, renameSync, copyFileSync, truncateSync, openSync, closeSync, fchmodSync, constants, promises as fsp } from "node:fs";
import { getAgendHome } from "./paths.js";

const DATA_DIR = getAgendHome();
const LOG_FILE = join(DATA_DIR, "daemon.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const ROTATE_MAX_FILES = 3;

/**
 * Console formatting for interactive output. The file-format option remains
 * available to callers, although service stdout no longer gets a pino copy.
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

/** A log holds what the fleet saw: only its owner reads it. */
const PRIVATE_LOG_MODE = 0o600;

/**
 * Make `path` a private (0600) log through its own descriptor. pino-pretty does not pass a `mode` to the file it opens
 * (SonicBoom creates it 0666 & ~umask), so the file is created — or an existing one repaired — here, before any writer
 * opens it, and the writer then appends to it with its mode unchanged.
 *   - never follows a symlink (O_NOFOLLOW), never blocks on a FIFO (O_NONBLOCK), and changes only a regular file this
 *     process's user owns; anything else is left alone
 *   - `create: false` only repairs a file that exists (a rotated copy), never makes one
 * Best effort: a log that cannot be checked is not a reason to stop the fleet. No-op on Windows (no Unix modes).
 */
export function ensurePrivateLogFile(path: string, create = true): void {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK | (create ? constants.O_CREAT : 0), PRIVATE_LOG_MODE);
  } catch { return; }
  try {
    const info = fstatSync(fd);
    if (info.isFile() && info.uid === process.getuid() && (info.mode & 0o777) !== PRIVATE_LOG_MODE) fchmodSync(fd, PRIVATE_LOG_MODE);
  } catch { /* best effort */ } finally { closeSync(fd); }
}

/** The live log and every rotated copy, private (see ensurePrivateLogFile). */
export function ensurePrivateLogFiles(logPath: string, maxFiles = ROTATE_MAX_FILES): void {
  ensurePrivateLogFile(logPath);
  for (let i = 1; i <= maxFiles; i++) ensurePrivateLogFile(`${logPath}.${i}`, false);
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
  // An async rotation of this very file is under way: it owns the shift/copy/truncate (#1161).
  if (rotationsInFlight.has(logPath)) return;
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
    ensurePrivateLogFile(`${logPath}.1`, false);         // a copy is as private as the log, whatever the source's mode
    truncateSync(logPath, 0);
  } catch { /* best effort */ }
}

/** Rotations running right now, by path: a second request for the same file joins the first. */
const rotationsInFlight = new Map<string, Promise<void>>();

/** Passes at picking up what the writer appended while the copy ran, before the truncate. */
const MAX_DELTA_PASSES = 3;
/** The most the delta is read in one piece: its size is the writer's, not ours to allocate. */
const DELTA_CHUNK_BYTES = 64 * 1024;

/**
 * The same copytruncate rotation as `rotateLogIfNeeded`, without blocking the event
 * loop (#1161): the 10–100 MiB copy runs on the libuv pool instead of the fleet thread.
 *
 *   - the size check stays synchronous and cheap (one stat), so a caller on a hot path —
 *     the daemon's health tick — pays only that when nothing is due, and may fire this
 *     and forget it: the returned promise never rejects
 *   - one rotation per file at a time: a request that arrives while one is running
 *     gets that rotation's promise (the daemon's spawn/wake await it before attaching
 *     pipe-pane, so they still see a rotated file), and the sync version stands aside
 *   - same inode, same .1 → .2 → .3 shift, same drop-in-place for a ballooned log
 *   - bytes the writer appended while the copy ran are copied too before the truncate,
 *     which narrows the window in which they used to be lost to the truncate itself
 */
export function rotateLogIfNeededAsync(logPath: string, maxSize = MAX_LOG_SIZE, maxFiles = ROTATE_MAX_FILES): Promise<void> {
  const running = rotationsInFlight.get(logPath);
  if (running) return running;
  let size: number;
  try {
    if (!existsSync(logPath)) return Promise.resolve();
    size = statSync(logPath).size;
  } catch { return Promise.resolve(); }
  if (size < maxSize) return Promise.resolve();
  const rotation = rotateAsync(logPath, size, maxSize, maxFiles)
    .catch(() => { /* best effort, like the sync version */ })
    .finally(() => { rotationsInFlight.delete(logPath); });
  rotationsInFlight.set(logPath, rotation);
  return rotation;
}

async function rotateAsync(logPath: string, size: number, maxSize: number, maxFiles: number): Promise<void> {
  if (size > maxSize * 10) {
    // Ballooned: drop in place, nothing worth copying (see rotateLogIfNeeded).
    for (let i = 1; i <= maxFiles; i++) await fsp.unlink(`${logPath}.${i}`).catch(() => {});
    await fsp.truncate(logPath, 0);
    return;
  }
  for (let i = maxFiles; i >= 2; i--) {
    const src = `${logPath}.${i - 1}`;
    const dst = `${logPath}.${i}`;
    if (i === maxFiles) await fsp.unlink(dst).catch(() => {});
    await fsp.rename(src, dst).catch(() => {});       // a missing source is the normal first rotation
  }
  const rotated = `${logPath}.1`;
  await fsp.copyFile(logPath, rotated);
  ensurePrivateLogFile(rotated, false);                // a copy is as private as the log, whatever the source's mode
  // The writer kept appending while we copied: carry what it added, then truncate.
  // In fixed-size chunks (the delta is whatever the writer managed during the copy, not
  // something to allocate in one piece), and a short read is not "done": keep reading
  // until the range is in. No progress (a zero read, the file shrank under us) → give up
  // this rotation WITHOUT truncating: the live log keeps everything it has.
  let copied = (await fsp.stat(rotated)).size;
  const chunk = Buffer.allocUnsafe(DELTA_CHUNK_BYTES);
  for (let pass = 0; pass < MAX_DELTA_PASSES; pass++) {
    const live = (await fsp.stat(logPath)).size;
    if (live <= copied) break;
    const handle = await fsp.open(logPath, "r");
    try {
      while (copied < live) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, live - copied), copied);
        if (bytesRead === 0) return;
        await fsp.appendFile(rotated, chunk.subarray(0, bytesRead));
        copied += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }
  await fsp.truncate(logPath, 0);
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
  const targets: { target: string; options: Record<string, unknown>; level: string }[] = [];
  // Service managers already capture stdout/stderr in fleet.log (or journal).
  // Keep structured logs in daemon.log; only an interactive terminal gets a
  // console copy. This also avoids duplicating entries when stdout is piped.
  if (process.stdout.isTTY === true) {
    targets.push(
      {
        target: "pino-pretty",
        options: getStdoutPrettyOptions(),
        // The root/child logger level performs per-component filtering. Keep
        // transports permissive so a debug-level daemon child is not filtered
        // by an info-level fleet root before it reaches the shared worker.
        level: "trace",
      },
    );
  }
  targets.push(
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
  );
  sharedTransport ??= pino.transport({ targets });
  return sharedTransport;
}

export function createLogger(level: string = "info") {
  ensureAgendHome(DATA_DIR);
  rotateLogIfNeeded(LOG_FILE);
  const stream = transportStream();
  // The transport's writer creates the log 0644 under a usual umask and never repairs one. Whichever opens it first —
  // its worker or this — the file ends 0600 (created 0600 here, or repaired by descriptor). After the transport is
  // built, so nothing is written for a transport that could not be built.
  ensurePrivateLogFiles(LOG_FILE);
  return pino({ level }, stream);
}

export type Logger = ReturnType<typeof createLogger>;
