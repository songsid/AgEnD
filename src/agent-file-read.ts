/**
 * #1629: reading a file an agent names for an upload (set_web_theme_asset, and later effects, widgets and mods), on the
 * agent's side — the daemon — so the fleet never opens a workspace path (first design §4: tool handlers neither fork
 * nor read outside their own state). The file must be in the agent's own working directory, not a symlink, a regular
 * file within the size limit, and not under the AgEnD state directory; what is read is that open file.
 *
 * The open never waits (#1887 review): O_NONBLOCK, so a regular file replaced by a FIFO between the lstat and the
 * open returns at once and is refused by the descriptor's own fstat — it never holds a filesystem worker waiting for
 * a writer. O_NOCTTY, so a terminal device swapped in is never made the controlling terminal.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

export type AgentFileRead = { ok: true; bytes: Buffer } | { ok: false; reason: string };

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export async function readAgentFile(file: unknown, opts: { workspace: string | undefined; stateDir: string; maxBytes: number }): Promise<AgentFileRead> {
  if (typeof file !== "string" || !file.trim() || file.includes("\0")) return { ok: false, reason: "a file path in your working directory" };
  if (!opts.workspace) return { ok: false, reason: "this instance has no working directory" };
  const path = isAbsolute(file) ? file : resolve(opts.workspace, file);
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const own = await lstat(path);
    if (own.isSymbolicLink()) return { ok: false, reason: "a symlink" };
    if (!own.isFile()) return { ok: false, reason: "not a regular file" };
    const real = await realpath(path);
    const ws = await realpath(opts.workspace);
    if (!under(real, ws)) return { ok: false, reason: "outside your working directory" };
    const state = [resolve(opts.stateDir)];
    try { state.push(await realpath(opts.stateDir)); } catch { /* not there */ }
    if (state.some(root => under(real, root))) return { ok: false, reason: "inside the AgEnD state directory" };
    fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY);
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, reason: "not a regular file" };
    if (st.size > opts.maxBytes) return { ok: false, reason: `over the size limit (${Math.floor(opts.maxBytes / 1024)} KiB)` };
    const named = await stat(real);
    if (named.dev !== st.dev || named.ino !== st.ino) return { ok: false, reason: "replaced while it was opened" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const { bytesRead } = await fh.read(buf, off, st.size - off, off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return { ok: true, bytes: off === st.size ? buf : buf.subarray(0, off) };
  } catch {
    return { ok: false, reason: "cannot be read" };
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * #1629 r4 §1: write a file the fleet produced for the agent (preview_web_appearance's SVGs) into its own working
 * directory, on the agent's side — the daemon or the CLI; the fleet never names a path. `dir` is a fixed relative path
 * (".agend/appearance"); each of its folders is created if missing and must not be a symlink; the result must be in
 * the working directory and not in the AgEnD state directory (a working directory that is $HOME holds ~/.agend). The
 * file goes to a new temporary name (O_EXCL | O_NOFOLLOW) and is renamed over `name`, so a planted symlink is replaced,
 * never followed.
 */
export async function writeAgentFile(dir: string, name: string, bytes: Uint8Array, opts: { workspace: string | undefined; stateDir: string }): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (!opts.workspace) return { ok: false, reason: "this instance has no working directory" };
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".") || dir.split("/").some(p => !/^[A-Za-z0-9._-]+$/.test(p) || p === "..")) return { ok: false, reason: "not a plain name" };
  const { mkdir, rename, unlink } = await import("node:fs/promises");
  const { randomBytes } = await import("node:crypto");
  try {
    const ws = await realpath(opts.workspace);
    const state = [resolve(opts.stateDir)];
    try { state.push(await realpath(opts.stateDir)); } catch { /* not there */ }
    // Refused before anything is created (#1890 review: a $HOME working directory got ~/.agend/appearance first).
    if (state.some(root => under(resolve(ws, dir), root))) return { ok: false, reason: "inside the AgEnD state directory" };
    let at = ws;
    for (const part of dir.split("/")) {
      at = resolve(at, part);
      try {
        const st = await lstat(at);
        if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: `${part} is not a plain folder` };
      } catch { await mkdir(at, { mode: 0o700 }); }
    }
    const real = await realpath(at);
    if (!under(real, ws)) return { ok: false, reason: "outside your working directory" };
    if (state.some(root => under(real, root))) return { ok: false, reason: "inside the AgEnD state directory" };
    const tmp = resolve(real, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
    const fh = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await fh.writeFile(bytes); } finally { await fh.close(); }
    const final = resolve(real, name);
    try { await rename(tmp, final); } catch (err) { await unlink(tmp).catch(() => {}); throw err; }
    return { ok: true, path: final };
  } catch {
    return { ok: false, reason: "cannot be written" };
  }
}
