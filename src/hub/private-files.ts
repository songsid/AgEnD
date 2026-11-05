/** Hub-on composition only. Native Windows callers need a verified ACL adapter before support can be enabled. */
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
export function privatePath(home: string, suffix: string, directory = false): string {
  if (process.platform === "win32") throw Error("Hub private Windows ACL verification is unavailable");
  const root = resolve(home), path = resolve(root, suffix), rel = relative(root, path);
  if (isAbsolute(suffix) || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw Error("Invalid Hub private path");
  for (const part of [root, ...rel.split(sep).filter(Boolean).map((_, i, pieces) => join(root, ...pieces.slice(0, i + 1)))]) {
    const s = lstatSync(part), last = part === path;
    if (s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0
      || last && (directory ? !s.isDirectory() : !s.isFile()) || !last && !s.isDirectory()) throw Error("Hub private file permissions are invalid");
  }
  if (realpathSync(path) !== path) throw Error("Hub private path changed");
  return path;
}
export function ensurePrivateDirectory(home: string, suffix: string): string {
  privatePath(home, "", true);
  let current = "";
  for (const part of suffix.split("/")) {
    if (!part || part === "." || part === ".." || part.includes("\\")) throw Error("Invalid Hub private directory");
    current = current ? `${current}/${part}` : part;
    try { mkdirSync(join(home, current), { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    privatePath(home, current, true);
  }
  return join(home, suffix);
}
export function readPrivateFile(home: string, suffix: string, maximum = 64 * 1024): string {
  const path = privatePath(home, suffix), s = lstatSync(path);
  if (s.size > maximum) throw Error("Hub private file is too large");
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
}
