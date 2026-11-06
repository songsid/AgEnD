/** Private authenticated link to a persistent host. Closing the runtime client never closes its CLI panes. */
import WebSocket from "ws";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "./child-process.js";
import { readPaneSystemBootId } from "./runtime-pane-boot.js";
import { nativeCliEnvironment } from "./windows-cli-worker.js";
import { runtimeJobDigest } from "./runtime-client-store.js";
import { protectPaneDirectory, readPaneHostDescriptor, type PaneHostDescriptor } from "./runtime-pane-private.js";
import { validateRuntimePaneRequest, validateRuntimePaneSnapshot, validateRuntimePaneShutdown, type RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
import type {} from "./runtime-pane-service.js";
import { validatePaneMcpBody, type PaneMcpBody } from "./runtime-pane-mcp-protocol.js";
export interface PaneLinkOptions {
  directory: string;
  server: string;
  machineId: string;
  /** This Runtime's credential profile root, handed to a NEW pane host so it can map a profile name to a folder under it. */
  credentialRoot?: string;
  online(): boolean;
  maxAgents(): number;
  epoch?(): string;
  output?(snapshot: RuntimePaneSnapshot): void;
  /** Transport loss only; retained CLI/process ownership is unchanged. */
  disconnected?(): void;
  mcp?(body: PaneMcpBody, current: () => boolean): Promise<unknown>;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export class RuntimePaneLink {
  private mcpPending = 0;
  private pending = new Map<string, Pending>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private cleanupOnly=false;
  private readonly clientEpoch = randomUUID();
  private constructor(private socket: WebSocket, readonly hostBootId: string, private options: Pick<PaneLinkOptions, "online" | "maxAgents" | "output" | "epoch" | "mcp" | "disconnected">) {}
  static async open(options: PaneLinkOptions): Promise<RuntimePaneLink> {
    if (process.platform !== "win32") throw Error("Persistent pane host requires Windows Node");
    const directory = join(options.directory, "pane-host");
    await protectPaneDirectory(directory);
    const scope = runtimeJobDigest({ server: options.server, machineId: options.machineId });
    let descriptor = readPaneHostDescriptor(directory, scope);
    const systemBootId = await readPaneSystemBootId();
    let live = false;
    if (descriptor && !(descriptor.systemBootId && systemBootId && descriptor.systemBootId !== systemBootId)) {
      live = true;
      try { process.kill(descriptor.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") live = false; }
    }
    if (!live) {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./runtime-pane-service.js", import.meta.url)), directory, scope, ...(options.credentialRoot ? [options.credentialRoot] : [])], {
        detached: true, windowsHide: true, stdio: "ignore", shell: false, env: nativeCliEnvironment(),
      });
      let failed = false; child.on("error", () => { failed = true; }); child.unref();
      const deadline = performance.now() + 120_000;
      const prior = descriptor?.hostBootId;
      for (;;) {
        if (failed || child.exitCode !== null) throw Error("Pane host startup was not confirmed");
        descriptor = readPaneHostDescriptor(directory, scope);
        if (descriptor && descriptor.hostBootId !== prior && descriptor.pid === child.pid) break;
        if (performance.now() > deadline) throw Error("Pane host startup deadline; its state is retained for inspection");
        await new Promise(done => setTimeout(done, 50));
      }
    }
    if (!descriptor) throw Error("Pane host descriptor is unavailable");
    // A live descriptor which cannot authenticate is held, never replaced by another host.
    return this.attach(descriptor, options);
  }
  /** Authenticated discovery seam; fixtures bind only private loopback services. */
  static attach(descriptor: PaneHostDescriptor, options: Pick<PaneLinkOptions, "online" | "maxAgents" | "output" | "epoch" | "mcp" | "disconnected">): Promise<RuntimePaneLink> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${descriptor.port}/pane/v1`, { headers: { Authorization: `Bearer ${descriptor.token}` },
        handshakeTimeout: 10_000, maxPayload: 256 * 1024, followRedirects: false, perMessageDeflate: false });
      const link = new RuntimePaneLink(socket, descriptor.hostBootId, options);
      let ready = false;
      const deadline = setTimeout(() => { socket.terminate(); reject(Error("Pane host authentication deadline")); }, 10_000);
      socket.on("error", () => {});
      socket.on("close", () => { clearTimeout(deadline); link.closePending(); if (!ready) reject(Error("Pane host attachment is unconfirmed")); });
      socket.on("message", (bytes, binary) => {
        try {
          if (binary) throw Error("Binary pane frame");
          const value = JSON.parse(bytes.toString());
          if (!ready) {
            if (value?.type !== "hello" || value.hostBootId !== descriptor.hostBootId) throw Error("Pane host boot changed");
            ready = true; clearTimeout(deadline); link.lease(); link.timer = setInterval(() => link.lease(), 5000); link.timer.unref(); resolve(link); return;
          }
          if (value?.type === "mcp.request") {
            if (Object.keys(value).some(key => !["type", "id", "epoch", "body"].includes(key)) || !/^[a-f0-9-]{36}$/i.test(value.id) || value.epoch !== link.epoch()) throw Error("Invalid pane MCP frame");
            const body = validatePaneMcpBody(value.body), epoch = value.epoch;
            const current = (): boolean => !link.closed && !link.cleanupOnly && socket.readyState === WebSocket.OPEN && options.online() && link.epoch() === epoch;
            if (link.mcpPending >= 32) throw Error("Pane MCP transport backlog");
            link.mcpPending++;
            void (async () => {
              try {
                if (!current() || !options.mcp) throw Error("Pane MCP lease unavailable");
                const result = await options.mcp(body, current);
                if (current()) link.mcpReply(value.id, epoch, true, result);
              } catch { if (current()) link.mcpReply(value.id, epoch, false); }
              finally { link.mcpPending--; }
            })();
            return;
          }
          if (value?.type === "output") { options.output?.(validateRuntimePaneSnapshot(value.snapshot)); return; }
          if (value?.type !== "response" || typeof value.id !== "string" || typeof value.ok !== "boolean") throw Error("Invalid pane reply");
          const pending = link.pending.get(value.id); if (!pending) return;
          link.pending.delete(value.id); clearTimeout(pending.timer);
          if (value.ok) pending.resolve(value.result); else pending.reject(Error("Pane host refused operation; inspect its owned snapshot"));
        } catch { socket.close(1008, "Invalid pane host frame"); }
      });
    });
  }
  private mcpReply(id: string, epoch: string, ok: boolean, result?: unknown): void {
    const frame = JSON.stringify({ type: "mcp.result", id, epoch, ok, ...(ok ? { result } : {}) });
    if (Buffer.byteLength(frame) > 256 * 1024 || this.socket.bufferedAmount > 256 * 1024) { this.socket.terminate(); return; }
    this.socket.send(frame);
  }
  connectionChanged(): void { this.lease(); }
  private epoch(): string { return this.options.epoch?.() ?? this.clientEpoch; }
  private lease(): void {
    if (this.socket.readyState !== WebSocket.OPEN || this.closed) return;
    const maxAgents = this.options.maxAgents();
    if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > 16) { this.socket.close(1008, "Invalid machine limit"); return; }
    this.socket.send(JSON.stringify({ type: "lease", epoch: this.epoch(), online: this.cleanupOnly || this.options.online(), maxAgents }));
  }
  request(raw: unknown, current: () => boolean = () => true): Promise<unknown> {
    const request = validateRuntimePaneRequest(raw);
    if(this.cleanupOnly&&!["list","snapshot","close","shutdown"].includes(request.action))return Promise.reject(Error("Pane link only permits owned retirement"));
    if (!current() || this.closed || this.socket.readyState !== WebSocket.OPEN || !(this.cleanupOnly || this.options.online())) return Promise.reject(Error("Pane client is disconnected"));
    if (this.pending.size >= 64 || this.socket.bufferedAmount > 256 * 1024) return Promise.reject(Error("Pane client backpressure limit"));
    this.lease();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error("Pane result unconfirmed; no input is replayed")); }, 125_000); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "request", id, epoch: this.epoch(), request }), error => {
        if (!error) return;
        const pending = this.pending.get(id); if (pending) { clearTimeout(timer); this.pending.delete(id); reject(Error("Pane result unconfirmed")); }
      });
    });
  }
  connected(): boolean { return !this.closed && this.socket.readyState === WebSocket.OPEN; }
  private closePending(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error("Pane connection closed; terminal ownership is retained")); }
    this.pending.clear();
    try { this.options.disconnected?.(); } catch { /* cleanup observers cannot change retained ownership */ }
  }
  /** An authenticated explicit machine revocation retires only this enrollment's owned panes. A disconnect never does. */
  async retireOwned():Promise<void>{
    this.cleanupOnly=true;
    const deadline=performance.now()+125_000;
    const request=(value:unknown):Promise<unknown>=>{
      const remaining=deadline-performance.now();if(remaining<=0)return Promise.reject(Error("Owned pane retirement deadline"));
      return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Owned pane retirement deadline")),remaining);timer.unref();this.request(value).then(result=>{clearTimeout(timer);resolve(result);},error=>{clearTimeout(timer);reject(error);});});
    };
    const inventory=await request({action:"list"}) as {hostBootId?:unknown;panes?:unknown};
    if(inventory?.hostBootId!==this.hostBootId||!Array.isArray(inventory.panes)||inventory.panes.length>4096)throw Error("Owned pane inventory is unconfirmed");
    const panes=inventory.panes.map(validateRuntimePaneSnapshot);
    if(new Set(panes.map(pane=>pane.paneId)).size!==panes.length)throw Error("Owned pane inventory contains duplicate identities");
    // Retire positively observed running Jobs before encountering old unknown reservations.
    panes.sort((a,b)=>Number(b.state==="running")-Number(a.state==="running"));
    for(const pane of panes){if(pane.state==="exited")continue;if(pane.hostBootId!==this.hostBootId)throw Error("Owned pane host changed");
      const current=validateRuntimePaneSnapshot(await request({action:"snapshot",paneId:pane.paneId,launchId:pane.launchId}));
      if(current.hostBootId!==this.hostBootId||current.paneId!==pane.paneId||current.launchId!==pane.launchId||current.agentId!==pane.agentId||current.instance!==pane.instance)throw Error("Owned pane retirement identity changed");
      if(current.state==="exited")continue;
      const exited=validateRuntimePaneSnapshot(await request({action:"close",paneId:current.paneId,launchId:current.launchId,sequence:current.commandSequence+1,operationId:randomUUID()}));
      if(exited.hostBootId!==this.hostBootId||exited.paneId!==pane.paneId||exited.launchId!==pane.launchId||exited.agentId!==pane.agentId||exited.instance!==pane.instance||exited.state!=="exited")throw Error("Owned pane retirement exit is unconfirmed");
    }
    // Only explicit disable/revoke calls retireOwned. A transport/coordinator restart merely detaches via stop().
    validateRuntimePaneShutdown(await request({action:"shutdown",hostBootId:this.hostBootId}),this.hostBootId);
  }
  async stop(): Promise<void> { this.closePending(); this.socket.terminate(); }
}
