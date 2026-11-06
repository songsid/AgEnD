/** Local initializer only: snapshot an explicitly selected owner-only secret file; never echo or remove the source. */
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, type Stats } from "node:fs";
import { isAbsolute, dirname, resolve } from "node:path";
const MAXIMUM = 1024;
const refused = () => Error("hub_secret_file_invalid");
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
export function readHubSecretFile(input: string): string {
  if (process.platform === "win32" || typeof process.getuid !== "function" || !isAbsolute(input) || resolve(input) !== input) throw refused();
  let fd: number | undefined;
  const bytes = Buffer.alloc(MAXIMUM + 1);
  try {
    const parents = new Map<string, Stats>();
    for (let path = dirname(input);; path = dirname(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw refused();
      parents.set(path, stat);
      if (dirname(path) === path) break;
    }
    const before = lstatSync(input), mode = before.mode & 0o7777;
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() || ![0o400, 0o600].includes(mode)
      || before.size < 1 || before.size > MAXIMUM) throw refused();
    fd = openSync(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!same(before, fstatSync(fd))) throw refused();
    let length = 0, count: number;
    do { count = readSync(fd, bytes, length, bytes.length - length, null); length += count; } while (count && length < bytes.length);
    if (length !== before.size || length > MAXIMUM || !same(before, fstatSync(fd)) || !same(before, lstatSync(input))) throw refused();
    for (const [path, original] of parents) {
      const current = lstatSync(path);
      if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== original.dev || current.ino !== original.ino) throw refused();
    }
    const exact = bytes.subarray(0, length);
    const password = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(exact);
    if (password.includes("\0") || !Buffer.from(password, "utf8").equals(exact)) throw refused();
    return password;
  } catch { throw refused(); }
  finally { bytes.fill(0); if (fd !== undefined) closeSync(fd); }
}
