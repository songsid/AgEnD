import { createServer, createConnection, type Server, type Socket } from "node:net";
import { constants } from "node:fs";
import { lstat, mkdir, open, chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { cpuProfileSeconds, CPU_PROFILE_ENV } from "./cpu-profile.js";
import { UNIX_SOCKET_PATH_MAX } from "./channel/ipc-bridge.js";
import { RuntimeCpuProfiler, ProfileBusyError, profileDuration, type ProfileResult } from "./runtime-cpu-profile.js";

const INPUT_BYTES = 256;
export const profileSocketPath = (dataDir: string): string => join(dataDir, "operator", "profile.sock");

function uid(): number {
  if (!process.getuid) throw new Error("Local CPU profile control requires Unix user permissions.");
  return process.getuid();
}
async function checkRoot(dataDir: string): Promise<void> {
  const root = await lstat(dataDir);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== uid() || (root.mode & 0o022)) {
    throw new Error("Profile control requires an owned real AGEND_HOME without group/other write permission.");
  }
}
async function checkClientPath(dataDir: string): Promise<void> {
  await checkRoot(dataDir);
  const directory = await lstat(join(dataDir, "operator"));
  const socket = await lstat(profileSocketPath(dataDir));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid() || (directory.mode & 0o077)
    || !socket.isSocket() || socket.uid !== uid() || (socket.mode & 0o077)) {
    throw new Error("Profile control is not a private socket owned by this user.");
  }
}

/** Operator-only Unix socket; never attached to daemon/MCP IPC or any HTTP listener. */
export class ProfileControlServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private closed = false;
  private inode: number | null = null;
  private closing: Promise<void> | null = null;
  constructor(private readonly dataDir: string, private readonly profiler: RuntimeCpuProfiler) {}

  async listen(): Promise<void> {
    const deadline = performance.now() + 2000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.bind(deadline).catch(async err => { if (this.closed) await this.removeOwnedSocket(); throw err; }), new Promise<never>((_yes, no) => {
        timer = setTimeout(() => { this.closed = true; no(new Error("Profile socket startup timed out")); }, 2000);
      })]);
    } catch (err) { await this.close(); throw err; }
    finally { clearTimeout(timer); }
  }

  private async bind(deadline: number): Promise<void> {
    const current = (): void => {
      if (this.closed || performance.now() >= deadline) throw new Error("Profile socket startup expired.");
    };
    const path = profileSocketPath(this.dataDir);
    if (Buffer.byteLength(path) >= UNIX_SOCKET_PATH_MAX) throw new Error("Profile socket path exceeds the Unix socket limit.");
    await checkRoot(this.dataDir); current();
    const directory = join(this.dataDir, "operator");
    await mkdir(directory, { mode: 0o700 }).catch(err => { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }); current();
    const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      current(); const info = await dir.stat(); current();
      if (!info.isDirectory() || info.uid !== uid()) throw new Error("Profile operator directory is not owned by this user.");
      await dir.chmod(0o700); current(); // same fd checked and changed, never follow a replaced symlink
    } finally { await dir.close(); }
    current();
    const existing = await lstat(path).catch(err => { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; return null; }); current();
    if (existing) {
      if (!existing.isSocket() || existing.uid !== uid()) throw new Error("Refusing to replace a non-owned/non-socket profile path.");
      await unlink(path); current(); // only called after the fleet singleton has been claimed
    }
    const server = createServer(socket => this.accept(socket));
    this.server = server;
    server.on("error", () => { void this.close(); });
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(path, () => {
        server.removeListener("error", no);
        if (this.closed || performance.now() >= deadline) {
          // A late native listen completion must not reopen an expired listener.
          server.close();
          no(new Error("Profile socket startup expired."));
        } else yes();
      });
    });
    // The 0700 parent already gates access while these asynchronous checks run.
    const info = await lstat(path);
    this.inode = info.ino;
    current(); await chmod(path, 0o600); current();
    if (this.closed) await this.removeOwnedSocket();
  }

  private accept(socket: Socket): void {
    if (this.closed || this.clients.size >= 8) { socket.destroy(); return; }
    this.clients.add(socket);
    let buffer = "", bytes = 0, handled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const write = (value: unknown): void => {
      try { if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n"); }
      catch { socket.destroy(); }
    };
    const expireAt = (deadline: number): void => {
      clearTimeout(timer);
      const check = (): void => {
        const remaining = deadline - performance.now();
        if (remaining > 0) timer = setTimeout(check, Math.ceil(remaining));
        else socket.destroy();
      };
      timer = setTimeout(check, Math.max(0, Math.ceil(deadline - performance.now())));
    };
    const inputDeadline = performance.now() + 2000;
    expireAt(inputDeadline);
    socket.on("close", () => { clearTimeout(timer); this.clients.delete(socket); });
    socket.on("error", () => socket.destroy());
    socket.on("data", (data: Buffer) => {
      if (handled || this.closed || socket.destroyed) return;
      if (performance.now() >= inputDeadline) { socket.destroy(); return; }
      bytes += data.length;
      if (bytes > INPUT_BYTES) { socket.destroy(); return; }
      buffer += data.toString("utf8");
      if (!buffer.includes("\n")) return;
      handled = true;
      void (async () => {
        try {
          const request: unknown = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          if (!request || typeof request !== "object" || Object.keys(request).length !== 1
            || !Object.hasOwn(request, "seconds") || typeof (request as { seconds: unknown }).seconds !== "number") throw new Error("Invalid profile request.");
          const seconds = profileDuration((request as { seconds: number }).seconds);
          expireAt(performance.now() + seconds * 1000 + 15_000);
          const ticket = await this.profiler.start(seconds);
          write({ status: "recording", seconds });
          write({ status: "saved", ...await ticket.done });
        } catch (err) {
          write({ status: "error", message: String(err), ...(err instanceof ProfileBusyError ? { remainingSeconds: err.remainingSeconds } : {}) });
        } finally { clearTimeout(timer); try { socket.end(); } catch { socket.destroy(); } }
      })();
    });
  }

  close(): Promise<void> {
    this.closed = true;
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    this.closing ??= (async () => {
      const server = this.server; this.server = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (server) await Promise.race([
          new Promise<void>(resolve => server.close(() => resolve())),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); }),
        ]);
      } finally { clearTimeout(timer); }
      await this.removeOwnedSocket();
    })();
    return this.closing;
  }

  private async removeOwnedSocket(): Promise<void> {
    if (this.inode !== null) {
      const info = await lstat(profileSocketPath(this.dataDir)).catch(() => null);
      if (info?.isSocket() && info.ino === this.inode && info.uid === uid()) await unlink(profileSocketPath(this.dataDir)).catch(() => {});
    }
  }
}

/** No fleet construction or fallback startup. Refuse agent env before filesystem/socket effects. */
export async function requestCpuProfile(dataDir: string, value?: string | number, env: NodeJS.ProcessEnv = process.env): Promise<ProfileResult> {
  const seconds = cpuProfileSeconds({ ...env, [CPU_PROFILE_ENV]: String(value ?? 60) })!;
  try { await checkClientPath(dataDir); }
  catch (err) { throw new Error(`Running fleet profile control unavailable: ${String(err)}`); }
  const deadline = performance.now() + seconds * 1000 + 20_000;
  return new Promise((resolve, reject) => {
    const socket = createConnection(profileSocketPath(dataDir));
    let buffer = "", bytes = 0, settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (err: Error | null, result?: ProfileResult): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (err) reject(err); else resolve(result!);
    };
    const check = (): void => {
      const remaining = deadline - performance.now();
      if (remaining > 0) timer = setTimeout(check, Math.ceil(remaining));
      else finish(new Error("CPU profile request timed out; the fleet may still save its capture."));
    };
    timer = setTimeout(check, seconds * 1000 + 20_000);
    socket.once("connect", () => {
      if (settled || performance.now() >= deadline) { finish(new Error("CPU profile connection arrived after its deadline.")); return; }
      try { socket.write(JSON.stringify({ seconds }) + "\n"); } catch (err) { finish(err as Error); }
    });
    socket.on("error", err => finish(new Error(`Running fleet profile control unavailable: ${err.message}`)));
    socket.on("close", () => finish(new Error("Fleet disconnected before the CPU profile result.")));
    socket.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 8192) { finish(new Error("Invalid CPU profile response.")); return; }
      buffer += data.toString("utf8");
      while (buffer.includes("\n") && !settled) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const result = JSON.parse(line);
          if (performance.now() >= deadline) { finish(new Error("CPU profile response arrived after its deadline.")); return; }
          if (result.status === "error") {
            finish(typeof result.remainingSeconds === "number" ? new ProfileBusyError(result.remainingSeconds) : new Error(String(result.message)));
          } else if (result.status === "saved" && typeof result.path === "string" && (result.bytes === null || typeof result.bytes === "number")) {
            finish(null, { path: result.path, bytes: result.bytes });
          } else if (result.status !== "recording") finish(new Error("Invalid CPU profile response."));
        } catch (err) { finish(err as Error); }
      }
    });
  });
}
