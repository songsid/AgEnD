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
