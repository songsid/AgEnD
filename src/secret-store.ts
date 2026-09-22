/**
 * Small, deliberately boring secret store for the running Settings API.
 *
 * Secrets live in the existing .env file for compatibility with the CLI, but
 * all writes go through this module.  The write is same-directory atomic,
 * owner-only, and returns a snapshot that can be restored when an adapter
 * rebuild fails.  No exception from this module includes the secret value.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export const SECRET_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_ENV_KEYS = new Set([
  "PATH", "HOME", "PWD", "SHELL", "ENV", "BASH_ENV", "NODE_OPTIONS", "LD_PRELOAD",
]);

export interface SecretSnapshot {
  exists: boolean;
  content: string;
}

export interface SecretStoreOptions {
  /** A test seam; production uses fsync and atomic rename below. */
  fsync?: (fd: number) => void;
}

function fsyncDirectory(path: string, fsync: (fd: number) => void): void {
  const fd = openSync(path, "r");
  try { fsync(fd); } finally { closeSync(fd); }
}

/** Replace one KEY=value while retaining comments and unrelated variables. */
export function upsertSecretEnvLine(existing: string, key: string, value: string): string {
  const lines = existing.split(/\r?\n/);
  let replaced = false;
  const next = lines.map(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || match[1] !== key) return line;
    replaced = true;
    return `${key}=${value}`;
  });
  if (!replaced) {
    while (next.length && next[next.length - 1] === "") next.pop();
    next.push(`${key}=${value}`);
  }
  return next.join("\n").replace(/\n*$/, "\n");
}

export class SecretStore {
  private readonly fsync: (fd: number) => void;

  constructor(
    readonly path: string,
    private readonly allowedKeys: ReadonlySet<string> = new Set(),
    opts: SecretStoreOptions = {},
  ) {
    this.fsync = opts.fsync ?? fsyncSync;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.rejectSymlink(path);
  }

  private rejectSymlink(path: string): void {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error("secret file must not be a symlink");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private validateKey(key: string): void {
    if (!SECRET_ENV_KEY.test(key) || RESERVED_ENV_KEYS.has(key)) throw new Error("secret key is not allowed");
    if (this.allowedKeys.size > 0 && !this.allowedKeys.has(key)) throw new Error("secret key is not configured for a connection");
  }

  snapshot(): SecretSnapshot {
    this.rejectSymlink(this.path);
    try { return { exists: true, content: readFileSync(this.path, "utf8") }; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, content: "" };
      throw new Error("secret file could not be read");
    }
  }

  /** Atomic replacement; callers should retain snapshot() for rollback. */
  replace(content: string): void {
    this.rejectSymlink(this.path);
    const dir = dirname(this.path);
    const temp = join(dir, `.${this.path.split(/[\\/]/).pop() ?? "env"}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeSync(fd, content, undefined, "utf8");
      this.fsync(fd);
      closeSync(fd); fd = undefined;
      // chmod is deliberately a hard error: a successful rename with loose
      // permissions is never reported as an applied secret.
      chmodSync(temp, 0o600);
      this.rejectSymlink(temp);
      renameSync(temp, this.path);
      this.fsyncDirectory(dir);
    } catch (err) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
      try { unlinkSync(temp); } catch { /* best effort */ }
      if (err instanceof Error && /secret file must not be a symlink/.test(err.message)) throw err;
      throw new Error("secret file could not be written atomically");
    }
  }

  private fsyncDirectory(path: string): void {
    try { fsyncDirectory(path, this.fsync); }
    catch { throw new Error("secret directory could not be synced"); }
  }

  restore(snapshot: SecretSnapshot): void {
    if (snapshot.exists) this.replace(snapshot.content);
    else {
      this.rejectSymlink(this.path);
      try { unlinkSync(this.path); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("secret rollback could not remove file");
      }
      try { this.fsyncDirectory(dirname(this.path)); } catch { throw new Error("secret rollback could not sync directory"); }
    }
  }

  write(key: string, value: string): SecretSnapshot {
    this.validateKey(key);
    if (!value || /[\r\n\0]/.test(value)) throw new Error("secret value is invalid");
    const before = this.snapshot();
    try {
      this.replace(upsertSecretEnvLine(before.content, key, value));
    } catch (err) {
      // A directory fsync can fail after rename has already replaced the
      // target. Restore the snapshot here so callers never see a failed write
      // with a new secret left on disk.
      try { this.restore(before); } catch { /* caller reports rollback failure */ }
      throw err;
    }
    return before;
  }
}
