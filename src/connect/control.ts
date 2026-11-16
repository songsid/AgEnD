/** Private same-OS-owner socket. It is separate from every agent and administrative control socket. */
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { assertOperatorRoot, assertOperatorClientPath, operatorUid } from "../operator-control-paths.js";
import { UNIX_SOCKET_PATH_MAX } from "../channel/ipc-bridge.js";
import { dispatchOwnerApp, type OwnerAppOperation, type OwnerAppService } from "./protocol.js";

const LABEL = "AgEnD connector", INPUT_MAX = 64 * 1024, OUTPUT_MAX = 192 * 1024;
export const ownerAppSocketPath = (home: string): string => join(home, "operator", "connect.sock");
export class OwnerAppControl {
  private server: Server | null = null;
  private readonly peers = new Set<Socket>();
  private stopped = false;
  private inode: number | null = null;
  private closing: Promise<void> | null = null;
  constructor(private readonly home: string, private readonly service: OwnerAppService) {}
  async listen(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = performance.now() + 2000;
    try { await Promise.race([this.bind(deadline).catch(async error => {
      if (this.stopped) await this.removeOwnedSocket(); throw error;
    }), new Promise<never>((_yes, no) => { timer = setTimeout(() => {
      this.stopped = true; no(new Error("Connector startup timed out."));
    }, 2000); })]); }
    catch (error) { await this.close(); throw error; }
    finally { clearTimeout(timer); }
  }
  private async bind(deadline: number): Promise<void> {
    const current = () => { if (this.stopped || performance.now() >= deadline) throw new Error("Connector startup was stopped."); };
    const path = ownerAppSocketPath(this.home);
    if (Buffer.byteLength(path) >= UNIX_SOCKET_PATH_MAX) throw new Error("Connector socket path is too long.");
    await assertOperatorRoot(this.home, LABEL); current();
    const directory = join(this.home, "operator");
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; }); current();
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat(); current();
      if (!info.isDirectory() || info.uid !== operatorUid(LABEL)) throw new Error("Connector directory is not owned by this user.");
      await handle.chmod(0o700); current();
    } finally { await handle.close(); }
    const existing = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; return null; }); current();
    if (existing) {
      if (!existing.isSocket() || existing.uid !== operatorUid(LABEL)) throw new Error("Refusing to replace a non-owned connector path.");
      await unlink(path); current(); // Fleet singleton must already be held by the caller.
    }
    const server = this.server = createServer(peer => this.accept(peer));
    server.on("error", () => { void this.close(); });
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(path, () => {
        server.removeListener("error", no);
        if (this.stopped || performance.now() >= deadline) { server.close(); no(new Error("Connector startup was stopped.")); }
        else yes();
      });
    });
    const info = await lstat(path); this.inode = info.ino;
    current(); await chmod(path, 0o600); current();
  }
  private accept(peer: Socket): void {
    if (this.stopped || this.peers.size >= 16) { peer.destroy(); return; }
    this.peers.add(peer);
    let bytes = Buffer.alloc(0), handled = false;
    let timer = setTimeout(() => peer.destroy(), 2000);
    peer.on("close", () => { clearTimeout(timer); this.peers.delete(peer); });
    peer.on("error", () => peer.destroy());
    peer.on("data", (chunk: Buffer) => {
      if (handled || this.stopped) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > INPUT_MAX) { peer.destroy(); return; }
      const newline = bytes.indexOf(10); if (newline < 0) return;
      handled = true;
      clearTimeout(timer); timer = setTimeout(() => peer.destroy(), 20_000);
      void (async () => {
        let id: string | undefined;
        try {
          if (bytes.subarray(newline + 1).toString().trim()) throw new Error("One connector request is allowed per connection.");
          const request = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
          if (!request || Array.isArray(request) || typeof request !== "object"
            || Object.keys(request).sort().join() !== "id,input,operation" || typeof request.id !== "string"
            || !/^[0-9a-f-]{36}$/.test(request.id)) throw new Error("Invalid connector request.");
          id = request.id;
          const result = await dispatchOwnerApp(this.service, request.operation, request.input, () => !this.stopped && !peer.destroyed);
          this.respond(peer, { id, ok: true, result });
        } catch {
          this.respond(peer, { id, ok: false, message: "The connector call was refused or the Fleet is unavailable. No administrative operation is offered." });
        } finally { peer.end(); }
      })();
    });
  }
  private respond(peer: Socket, value: unknown): void {
    if (this.stopped || peer.destroyed) return;
    const frame = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(frame) > OUTPUT_MAX) {
      peer.end(JSON.stringify({ ok: false, message: "The result is too large; request fewer items." }) + "\n"); return;
    }
    peer.write(frame);
  }
  close(): Promise<void> {
    this.stopped = true;
    for (const peer of this.peers) peer.destroy();
    this.peers.clear();
    this.closing ??= (async () => {
      const server = this.server; this.server = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { if (server) await Promise.race([new Promise<void>(yes => server.close(() => yes())),
        new Promise<void>(yes => { timer = setTimeout(yes, 2000); })]); }
      finally { clearTimeout(timer); }
      await this.removeOwnedSocket();
    })();
    return this.closing;
  }
  private async removeOwnedSocket(): Promise<void> {
    if (this.inode === null) return;
    const path = ownerAppSocketPath(this.home), info = await lstat(path).catch(() => null);
    if (info?.isSocket() && info.ino === this.inode && info.uid === operatorUid(LABEL)) await unlink(path).catch(() => {});
  }
}

/** A new connection per call; never reconnect/re-send an operation after an uncertain outcome. */
export async function requestOwnerApp(home: string, operation: OwnerAppOperation, input: unknown): Promise<unknown> {
  const path = ownerAppSocketPath(home);
  try { await assertOperatorClientPath(home, path, LABEL); }
  catch { throw new Error("AgEnD is not running for this local owner. Start the Fleet and try again."); }
  return new Promise((yes, no) => {
    const id = randomUUID(), peer = createConnection(path);
    let bytes = Buffer.alloc(0), settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); peer.destroy();
      if (error) no(error); else yes(value);
    };
    const timer = setTimeout(() => finish(new Error("The Fleet call timed out. Check for an answer before sending again.")), 20_000);
    peer.on("connect", () => peer.write(JSON.stringify({ id, operation, input }) + "\n"));
    peer.on("error", () => finish(new Error("AgEnD is unavailable. Start the Fleet and try again.")));
    peer.on("close", () => { if (!settled) finish(new Error("The Fleet connection closed; the outcome may be uncertain.")); });
    peer.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > OUTPUT_MAX) { finish(new Error("The Fleet response is too large.")); return; }
      const newline = bytes.indexOf(10); if (newline < 0) return;
      try {
        const response = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
        if (response.id !== id || response.ok !== true) throw new Error(typeof response.message === "string" ? response.message : "The connector call was refused.");
        finish(null, response.result);
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid connector response.")); }
    });
  });
}
