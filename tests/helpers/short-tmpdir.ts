import { accessSync, constants, realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * A temp base that stays short whatever TMPDIR is, for tests that assert on or
 * bind a path ending in an AF_UNIX socket.
 *
 * sun_path holds ~107 bytes (104 on macOS), and `os.tmpdir()` follows TMPDIR:
 * a runner's per-task TMPDIR (`/tmp/multica-task-<id>` is already 28 chars) or
 * macOS's `/var/folders/..` leaves too little room, so such a test passes or
 * fails by where it happens to run. `/tmp` is symlink-resolved so a path built
 * under it is also its own realpath (macOS: `/private/tmp`).
 */
export function shortTmpdir(): string {
  if (process.platform !== "win32") {
    try {
      accessSync("/tmp", constants.W_OK | constants.X_OK);
      return realpathSync("/tmp");
    } catch { /* no usable /tmp: fall back to the platform default */ }
  }
  return tmpdir();
}
