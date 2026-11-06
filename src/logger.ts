import { ensureAgendHome } from "./agend-home.js";
import pino from "pino";
import { join } from "node:path";
import { Writable } from "node:stream";
import { lstatSync, fstatSync, unlinkSync, renameSync, copyFileSync, openSync, closeSync, fchmodSync, ftruncateSync, truncateSync, constants, promises as fsp } from "node:fs";
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

const OPEN_LOG = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const OPEN_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Copy through this path so a swapped directory entry cannot redirect the held fd. */
function heldFdPath(fd: number): string {
  return process.platform === "darwin" ? `/dev/fd/${fd}` : `/proc/self/fd/${fd}`;
}

/** Unix: open `path` without following a symlink. Caller closes the fd. Undefined = leave the path alone. */
function openOwnedLog(path: string, create: boolean): number | undefined {
  if (process.platform === "win32" || typeof process.getuid !== "function") return undefined;
  let fd: number;
  try {
    fd = openSync(path, OPEN_LOG | (create ? constants.O_CREAT : 0), PRIVATE_LOG_MODE);
  } catch { return undefined; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid()) {
      closeSync(fd);
      return undefined;
    }
    if ((info.mode & 0o777) !== PRIVATE_LOG_MODE) fchmodSync(fd, PRIVATE_LOG_MODE);
    return fd;
  } catch {
    closeSync(fd);
    return undefined;
  }
}

function lstatRegular(path: string): { size: number } | undefined {
  try {
    const st = lstatSync(path);
    return st.isFile() ? { size: st.size } : undefined;
  } catch { return undefined; }
}

function unlinkIfExists(path: string): void {
  try { unlinkSync(path); } catch { /* missing */ }
}

/** Drop a planted symlink at `path` so the next create/copy is a regular file; leave other non-files alone. */
function unlinkIfSymlink(path: string): void {
  try { if (lstatSync(path).isSymbolicLink()) unlinkSync(path); } catch { /* missing */ }
}

function truncateOwnedLog(path: string): void {
  const fd = openOwnedLog(path, false);
  if (fd !== undefined) {
    try { ftruncateSync(fd, 0); } finally { closeSync(fd); }
    return;
  }
  if (process.platform === "win32") {
    try { truncateSync(path, 0); } catch { /* best effort */ }
  }
}

/** Unlink a planted symlink or leftover file so the next create/copy is exclusive. */
function unlinkIfNotDir(path: string): void {
  try { if (!lstatSync(path).isDirectory()) unlinkSync(path); } catch { /* missing */ }
}

function copyOwnedLog(src: string, dst: string): void {
  if (process.platform === "win32") {
    if (!lstatRegular(src)) return;
    try { copyFileSync(src, dst); } catch { /* best effort */ }
    return;
  }
  let srcFd: number | undefined;
  try {
    srcFd = openSync(src, OPEN_READ);
    const info = fstatSync(srcFd);
    if (!info.isFile() || (typeof process.getuid === "function" && info.uid !== process.getuid())) return;
    unlinkIfNotDir(dst);
    copyFileSync(heldFdPath(srcFd), dst, constants.COPYFILE_EXCL);
  } catch { /* best effort */ } finally {
    if (srcFd !== undefined) closeSync(srcFd);
  }
}

function shiftRotated(src: string, dst: string): void {
  if (!lstatRegular(src)) return;
  unlinkIfSymlink(dst);
  try { renameSync(src, dst); } catch { /* best effort */ }
}

/**
 * Make `path` a private (0600) log through its own descriptor. pino-pretty does not pass a `mode` to the file it opens
 * (SonicBoom creates it 0666 & ~umask), so the file is created — or an existing one repaired — here, before any writer
 * opens it.
 *   - never follows a symlink (O_NOFOLLOW), never blocks on a FIFO (O_NONBLOCK), and changes only a regular file this
 *     process's user owns; anything else is left alone
 *   - `create: false` only repairs a file that exists (a rotated copy), never makes one
 * Best effort: a log that cannot be checked is not a reason to stop the fleet. No-op on Windows (no Unix modes).
 */
export function ensurePrivateLogFile(path: string, create = true): void {
  const fd = openOwnedLog(path, create);
  if (fd !== undefined) closeSync(fd);
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
 * truncate resets the same inode to size 0 in place, so the held fd keeps
 * writing to the now-empty file. Copying before truncating means no data loss.
 *
 * A symlink at the live path or a rotation slot is never followed (#2406 / #3083).
 */
export function rotateLogIfNeeded(logPath: string, maxSize = MAX_LOG_SIZE, maxFiles = ROTATE_MAX_FILES): void {
  // An async rotation of this very file is under way: it owns the shift/copy/truncate (#1161).
  if (rotationsInFlight.has(logPath)) return;
  try {
    const stat = lstatRegular(logPath);
    if (!stat || stat.size < maxSize) return;

    // Ballooned far past the limit (e.g. never-rotated TUI animation flood at
    // hundreds of MB): drop content in place. Copying a 700MB+ file to .1 is
    // slow and wasteful; the open writer (pipe-pane `cat >>`, pino) keeps the
    // same inode so truncate is enough.
    if (stat.size > maxSize * 10) {
      for (let i = 1; i <= maxFiles; i++) unlinkIfExists(`${logPath}.${i}`);
      truncateOwnedLog(logPath);
      return;
    }

    // Shift existing rotated files: .2 → .3 (oldest deleted), .1 → .2, …
    for (let i = maxFiles; i >= 2; i--) {
      const src = `${logPath}.${i - 1}`;
      const dst = `${logPath}.${i}`;
      if (i === maxFiles) unlinkIfExists(dst);
      shiftRotated(src, dst);
    }
    copyOwnedLog(logPath, `${logPath}.1`);
    ensurePrivateLogFile(`${logPath}.1`, false);         // a copy is as private as the log, whatever the source's mode
    truncateOwnedLog(logPath);
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
 *   - the size check stays synchronous and cheap (one lstat), so a caller on a hot path —
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
    const stat = lstatRegular(logPath);
    if (!stat) return Promise.resolve();
    size = stat.size;
  } catch { return Promise.resolve(); }
  if (size < maxSize) return Promise.resolve();
  const rotation = rotateAsync(logPath, size, maxSize, maxFiles)
    .catch(() => { /* best effort, like the sync version */ })
    .finally(() => { rotationsInFlight.delete(logPath); });
  rotationsInFlight.set(logPath, rotation);
  return rotation;
}

async function lstatRegularAsync(path: string): Promise<{ size: number } | undefined> {
  try {
    const st = await fsp.lstat(path);
    return st.isFile() ? { size: st.size } : undefined;
  } catch { return undefined; }
}

async function unlinkIfExistsAsync(path: string): Promise<void> {
  await fsp.unlink(path).catch(() => {});
}

async function unlinkIfSymlinkAsync(path: string): Promise<void> {
  try { if ((await fsp.lstat(path)).isSymbolicLink()) await fsp.unlink(path); } catch { /* missing */ }
}

async function truncateOwnedLogAsync(path: string): Promise<void> {
  if (process.platform === "win32") {
    await fsp.truncate(path, 0).catch(() => {});
    return;
  }
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(path, OPEN_LOG);
    const info = await handle.stat();
    if (!info.isFile() || (typeof process.getuid === "function" && info.uid !== process.getuid())) return;
    await handle.truncate(0);
  } catch { /* best effort */ } finally { await handle?.close().catch(() => {}); }
}

async function unlinkIfNotDirAsync(path: string): Promise<void> {
  try { if (!(await fsp.lstat(path)).isDirectory()) await fsp.unlink(path); } catch { /* missing */ }
}

async function copyOwnedLogAsync(src: string, dst: string): Promise<boolean> {
  if (process.platform === "win32") {
    if (!(await lstatRegularAsync(src))) return false;
    await fsp.copyFile(src, dst);
    return true;
  }
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(src, OPEN_READ);
    const info = await handle.stat();
    if (!info.isFile() || (typeof process.getuid === "function" && info.uid !== process.getuid())) return false;
    await unlinkIfNotDirAsync(dst);
    await fsp.copyFile(heldFdPath(handle.fd), dst, constants.COPYFILE_EXCL);
    return true;
  } catch { return false; } finally { await handle?.close().catch(() => {}); }
}

async function rotateAsync(logPath: string, size: number, maxSize: number, maxFiles: number): Promise<void> {
  if (size > maxSize * 10) {
    // Ballooned: drop in place, nothing worth copying (see rotateLogIfNeeded).
    for (let i = 1; i <= maxFiles; i++) await unlinkIfExistsAsync(`${logPath}.${i}`);
    await truncateOwnedLogAsync(logPath);
    return;
  }
  for (let i = maxFiles; i >= 2; i--) {
    const src = `${logPath}.${i - 1}`;
    const dst = `${logPath}.${i}`;
    if (i === maxFiles) await unlinkIfExistsAsync(dst);
    if (await lstatRegularAsync(src)) {
      await unlinkIfSymlinkAsync(dst);
      await fsp.rename(src, dst).catch(() => {});
    }
  }
  const rotated = `${logPath}.1`;
  if (!(await lstatRegularAsync(logPath))) return;
  if (!(await copyOwnedLogAsync(logPath, rotated))) return;
  ensurePrivateLogFile(rotated, false);                // a copy is as private as the log, whatever the source's mode
  // The writer kept appending while we copied: carry what it added, then truncate.
  // In fixed-size chunks (the delta is whatever the writer managed during the copy, not
  // something to allocate in one piece), and a short read is not "done": keep reading
  // until the range is in. No progress (a zero read, the file shrank under us) → give up
  // this rotation WITHOUT truncating: the live log keeps everything it has.
  const dest = await fsp.open(rotated, OPEN_LOG).catch(() => undefined);
  if (!dest) return;
  try {
    let copied = (await dest.stat()).size;
    const chunk = Buffer.allocUnsafe(DELTA_CHUNK_BYTES);
    for (let pass = 0; pass < MAX_DELTA_PASSES; pass++) {
      const live = (await lstatRegularAsync(logPath))?.size ?? 0;
      if (live <= copied) break;
      const handle = await fsp.open(logPath, OPEN_READ);
      try {
        while (copied < live) {
          const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, live - copied), copied);
          if (bytesRead === 0) return;
          await dest.write(chunk.subarray(0, bytesRead));
          copied += bytesRead;
        }
      } finally {
        await handle.close();
      }
    }
  } finally {
    await dest.close().catch(() => {});
  }
  await truncateOwnedLogAsync(logPath);
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

function fileDestination(): number | string | undefined {
  if (process.platform === "win32") return LOG_FILE;
  return openOwnedLog(LOG_FILE, true);
}

function transportStream() {
  if (sharedTransport) return sharedTransport;
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
  const destination = fileDestination();
  if (destination !== undefined) {
    targets.push(
      {
        target: "pino-pretty",
        options: {
          destination,
          colorize: false,
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
          ignore: "pid,hostname",
        },
        level: "trace",
      },
    );
  }
  if (targets.length === 0) {
    if (typeof destination === "number") closeSync(destination);
    return undefined;
  }
  try {
    sharedTransport ??= pino.transport({ targets });
  } catch (err) {
    if (typeof destination === "number") {
      try { closeSync(destination); } catch { /* already closed */ }
    }
    throw err;
  }
  return sharedTransport;
}

const discarded = new Writable({ write(_chunk, _enc, cb) { cb(); } });

export function createLogger(level: string = "info") {
  ensureAgendHome(DATA_DIR);
  rotateLogIfNeeded(LOG_FILE);
  // Before the transport's writer opens it: the writer would create the log 0644 under a usual umask, and never repairs
  // one. Created (empty) or repaired synchronously here. The transport is given the same O_NOFOLLOW fd (or omitted when
  // daemon.log is a symlink), so pino-pretty cannot follow a planted link (#2406).
  ensurePrivateLogFiles(LOG_FILE);
  const stream = transportStream();
  return stream ? pino({ level }, stream) : pino({ level }, discarded);
}

export type Logger = ReturnType<typeof createLogger>;
