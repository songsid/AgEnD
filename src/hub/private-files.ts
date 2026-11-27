/** Hub-on composition only. Native Windows callers need a verified ACL adapter before support can be enabled. */
import { lstatSync, mkdirSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
function checkPrivateStat(s: Stats, directory: boolean): void {
  if (s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0
    || (directory ? !s.isDirectory() : !s.isFile())) throw Error("Hub private file permissions are invalid");
}
/** No retained path/stat result: every call checks all ancestors and the latest leaf metadata. */
function checkedPrivatePath(home: string, suffix: string, directory: boolean, maximum?: number): string {
  if (process.platform === "win32") throw Error("Hub private Windows ACL verification is unavailable");
  const root = resolve(home), path = resolve(root, suffix), rel = relative(root, path);
  if (isAbsolute(suffix) || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw Error("Invalid Hub private path");
  for (const part of [root, ...rel.split(sep).filter(Boolean).map((_, i, pieces) => join(root, ...pieces.slice(0, i + 1)))]) {
    if (part !== path) checkPrivateStat(lstatSync(part), true);
  }
  let canonical: string;
  try { canonical = realpathSync(path); }
  catch (error) {
    // A dangling link is unsafe, not an absent identity that a writer may initialize.
    // A genuinely missing leaf still supplies lstat's native ENOENT to its existing callers.
    checkPrivateStat(lstatSync(path), directory);
    throw error;
  }
  const leaf = lstatSync(path);
  checkPrivateStat(leaf, directory);
  if (canonical !== path) throw Error("Hub private path changed");
  if (maximum !== undefined && leaf.size > maximum) throw Error("Hub private file is too large");
  return path;
}
export function privatePath(home: string, suffix: string, directory = false): string {
  return checkedPrivatePath(home, suffix, directory);
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
export function readPrivateFile(home: string, suffix: string, maximum = 64 * 1024, options: { preserveBom?: boolean } = {}): string {
  const path = checkedPrivatePath(home, suffix, false, maximum);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: options.preserveBom === true }).decode(readFileSync(path));
}
