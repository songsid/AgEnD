import { operatorUid, assertOperatorRoot, assertOperatorClientPath } from "./operator-control-paths.js";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { constants } from "node:fs";
import { lstat, mkdir, open, chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { SettingsConfirmationStore, type SettingsPendingView } from "./settings-confirmation.js";
import { settingsFingerprint } from "./settings-transaction.js";
import { UNIX_SOCKET_PATH_MAX } from "./channel/ipc-bridge.js";


const INPUT_BYTES = 2048;
export const settingsSocketPath = (dataDir: string): string => join(dataDir, "operator", "settings.sock");

function uid(): number { return operatorUid("Settings confirmation"); }
async function checkRoot(dataDir: string): Promise<void> { await assertOperatorRoot(dataDir, "Settings confirmation"); }
async function checkClientPath(dataDir: string): Promise<void> { await assertOperatorClientPath(dataDir, settingsSocketPath(dataDir), "Settings confirmation"); }

/** Operator-only Unix socket; never attached to daemon/MCP IPC or any HTTP listener. */
export class SettingsControlServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private closed = false;
  private inode: number | null = null;
  private closing: Promise<void> | null = null;
  private readonly generation = randomBytes(16).toString("hex");
  constructor(private readonly dataDir: string, private readonly store: SettingsConfirmationStore, private readonly current: () => boolean) {}
  private inspect(id: string): SettingsInspection | null {
    const value = this.store.inspectHost(id);
    return value ? { pending_change: value.view, ticket: { id, generation: this.generation,
      fingerprint: value.fingerprint, summary_fingerprint: settingsFingerprint(value.view.summary) } } : null;
  }

  async listen(): Promise<void> {
    const deadline = performance.now() + 2000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.bind(deadline).catch(async err => { if (this.closed) await this.removeOwnedSocket(); throw err; }), new Promise<never>((_yes, no) => {
        timer = setTimeout(() => { this.closed = true; no(new Error("Settings socket startup timed out")); }, 2000);
      })]);
    } catch (err) { await this.close(); throw err; }
    finally { clearTimeout(timer); }
  }

  private async bind(deadline: number): Promise<void> {
    const current = (): void => {
      if (this.closed || performance.now() >= deadline) throw new Error("Settings socket startup expired.");
    };
    const path = settingsSocketPath(this.dataDir);
    if (Buffer.byteLength(path) >= UNIX_SOCKET_PATH_MAX) throw new Error("Settings socket path exceeds the Unix socket limit.");
    await checkRoot(this.dataDir); current();
    const directory = join(this.dataDir, "operator");
    await mkdir(directory, { mode: 0o700 }).catch(err => { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }); current();
    const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      current(); const info = await dir.stat(); current();
      if (!info.isDirectory() || info.uid !== uid()) throw new Error("Settings operator directory is not owned by this user.");
      await dir.chmod(0o700); current(); // same fd checked and changed, never follow a replaced symlink
    } finally { await dir.close(); }
    current();
    const existing = await lstat(path).catch(err => { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; return null; }); current();
    if (existing) {
      if (!existing.isSocket() || existing.uid !== uid()) throw new Error("Refusing to replace a non-owned/non-socket settings path.");
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
          no(new Error("Settings socket startup expired."));
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
          if (!request || typeof request !== "object" || Array.isArray(request) || !this.current()) throw new Error("Settings confirmation unavailable.");
          const input = request as Record<string, unknown>;
          const action = input.action;
          const id = typeof input.id === "string" ? input.id : (input.ticket as SettingsTicket | undefined)?.id;
          if (!id || !/^[0-9a-f]{32}$/.test(id)) throw new Error("Invalid pending change id.");
          expireAt(performance.now() + 65_000);
          const inspected = this.inspect(id);
          if (!inspected) throw new Error("Pending change not found.");
          if (action === "inspect" && Object.keys(input).length === 2) write({ status: "ok", ...inspected });
          else if ((action === "confirm" || action === "reject") && Object.keys(input).length === 2
            && settingsFingerprint(input.ticket) === settingsFingerprint(inspected.ticket)) {
            const result = await this.store.decide(id, action, { label: "host operator", current: () => !this.closed && this.current() });
            write({ status: "ok", pending_change: result });
          } else throw new Error("Inspection is stale; inspect the authoritative diff again.");
        } catch {
          write({ status: "error", message: "Settings confirmation rejected; inspect the change again." });
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
      const info = await lstat(settingsSocketPath(this.dataDir)).catch(() => null);
      if (info?.isSocket() && info.ino === this.inode && info.uid === uid()) await unlink(settingsSocketPath(this.dataDir)).catch(() => {});
    }
  }
}

export interface SettingsTicket { id: string; generation: string; fingerprint: string; summary_fingerprint: string }
export interface SettingsInspection { pending_change: SettingsPendingView; ticket: SettingsTicket }
/** Same-user host authority only. No agent, HTTP, MCP or fallback startup path. */
export async function requestSettingsConfirmation(dataDir: string, request: { action: "inspect"; id: string } | {
  action: "confirm" | "reject"; ticket: SettingsTicket;
}, env: NodeJS.ProcessEnv = process.env): Promise<SettingsInspection | { pending_change: SettingsPendingView }> {
  if (Object.hasOwn(env, "AGEND_INSTANCE_NAME")) throw new Error("Agent sessions cannot confirm Settings changes.");
  await checkClientPath(dataDir);
  const budget = request.action === "inspect" ? 8_000 : 65_000;
  const deadline = performance.now() + budget;
  return new Promise((resolve, reject) => {
    const socket = createConnection(settingsSocketPath(dataDir));
    let buffer = "", bytes = 0, settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (err: Error | null, result?: any): void => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (err) reject(err); else resolve(result);
    };
    const check = (): void => {
      const remaining = deadline - performance.now();
      if (remaining > 0) timer = setTimeout(check, Math.ceil(remaining));
      else finish(new Error("Confirmation is still running; inspect its pending state."));
    };
    timer = setTimeout(check, budget);
    socket.once("connect", () => {
      if (settled || performance.now() >= deadline) { finish(new Error("Confirmation connection expired.")); return; }
      socket.write(JSON.stringify(request) + "\n");
    });
    socket.on("error", () => finish(new Error("Local Settings confirmation unavailable. Is the fleet or setup host running?")));
    socket.on("close", () => finish(new Error("Settings confirmation control disconnected.")));
    socket.on("data", (data: Buffer) => {
      bytes += data.length; if (bytes > 32 * 1024) { finish(new Error("Invalid confirmation response.")); return; }
      buffer += data.toString("utf8");
      const end = buffer.indexOf("\n"); if (end < 0 || settled) return;
      try {
        const value = JSON.parse(buffer.slice(0, end));
        if (performance.now() >= deadline || value.status !== "ok" || !value.pending_change) throw new Error("Confirmation rejected or expired.");
        finish(null, value);
      } catch (err) { finish(err as Error); }
    });
  });
}
