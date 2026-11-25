/** Local pane-scoped MCP endpoint. The CLI never receives the host or enrollment credential. */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { validatePaneMcpBody, validatePaneMcpOwner, type PaneMcpBody, type PaneMcpOwner } from "./runtime-pane-mcp-protocol.js";
import type { PaneMcpConnection } from "./windows-pane-mcp.js";
import { validateRequestContextCallStamp, type RequestContextCallStamp } from "./request-context-call-protocol.js";
export interface PaneMcpRelayOptions {
  secret: string;
  endpoint(): string;
  owned(owner: PaneMcpOwner): boolean;
  forward(body: PaneMcpBody, current: () => boolean, stamp?: RequestContextCallStamp): Promise<unknown>;
  /** Internal bilateral negotiation only. No production publication until L. */
  requestContextProtocol?: 1;
}
function key(owner: PaneMcpOwner): string { return JSON.stringify([owner.hostBootId, owner.paneId, owner.launchId, owner.agentId, owner.instance]); }
export class PaneMcpRelay {
  private pending = 0;
  private readonly owners = new Map<string, PaneMcpOwner>();
  private readonly stamps = new Map<string, RequestContextCallStamp>();
  private readonly interrupted = new Set<string>();
  private readonly callStamps = new Map<string, RequestContextCallStamp>();
  get pendingCount(): number { return this.pending; }
  constructor(private options: PaneMcpRelayOptions) {}
  private token(owner: PaneMcpOwner): string { return createHmac("sha256", this.options.secret).update(key(owner)).digest("hex"); }
  connection(owner: PaneMcpOwner, tools: string[]): PaneMcpConnection {
    validatePaneMcpOwner(owner);
    if (!this.options.owned(owner)) throw Error("Pane MCP owner is unavailable");
    const token = this.token(owner);
    if (this.options.requestContextProtocol === 1) {
      if (!this.owners.has(token) && this.owners.size >= 1024) throw Error("Pane MCP launch registry requires retirement");
      this.owners.set(token, Object.freeze({ ...owner }));
    }
    return { endpoint: this.options.endpoint(), token, owner: { ...owner }, tools: [...tools] };
  }
  /** Install with the C-bound input before input bytes; never called from a CLI tool body. */
  installRequestContext(owner: PaneMcpOwner, raw: unknown): void {
    validatePaneMcpOwner(owner);
    if (this.options.requestContextProtocol !== 1 || !this.options.owned(owner) || !this.owners.has(this.token(owner))) throw Error("Originating-call protocol not negotiated");
    const stamp = validateRequestContextCallStamp(raw), token = this.token(owner);
    if (this.interrupted.has(token) && stamp.coverage === "covered") {
      // Input B still proceeds. Only attribution remains uncovered; this must never become an agent-wide lock.
      this.stamps.set(token, Object.freeze({ version: 1, coverage: "not-covered", reason: "interrupted-launch" })); return;
    }
    if (stamp.coverage === "not-covered" && stamp.reason === "interrupted-launch") this.interrupted.add(token);
    this.stamps.set(token, stamp);
  }
  retire(owner: PaneMcpOwner): void {
    const token = this.token(owner); this.owners.delete(token); this.stamps.delete(token); this.interrupted.delete(token);
    for (const key of this.callStamps.keys()) if (key.startsWith(`${token}:`)) this.callStamps.delete(key);
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const answer = (status: number, value: unknown): void => {
      if (res.destroyed || res.writableEnded) return;
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 192 * 1024) { res.writeHead(503); res.end(); return; }
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(text);
    };
    if (req.method !== "POST" || req.url !== "/agent" || req.headers.origin !== undefined || req.headers.cookie !== undefined
      || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")
      || typeof req.headers["x-agend-native-token"] !== "string" || !/^[a-f0-9]{64}$/.test(req.headers["x-agend-native-token"])
      || this.pending >= 32) { answer(403, { error: "Pane MCP scope is unavailable" }); req.resume(); return; }
    this.pending++;
    // FIRST owned hop: authenticate from the already-installed launch token and freeze BEFORE body iteration.
    const arrivalToken = req.headers["x-agend-native-token"] as string;
    const arrivalOwner = this.owners.get(arrivalToken);
    const arrivalStamp = this.options.requestContextProtocol === 1
      ? this.stamps.get(arrivalToken) ?? Object.freeze({ version: 1 as const, coverage: "not-covered" as const, reason: "unbound-input" as const }) : undefined;
    // Keep physical HTTP ownership through response flush/close, including a held request body.
    const finished = new Promise<void>(done => {
      const settle = () => { res.off("finish", settle); res.off("close", settle); done(); };
      res.once("finish", settle); res.once("close", settle);
      if (res.writableFinished || res.destroyed) settle();
    });
    try {
      const chunks: Buffer[] = []; let size = 0;
      req.setTimeout(10_000, () => req.destroy());
      for await (const part of req) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        size += chunk.length; if (size > 64 * 1024) throw Error("Pane MCP request limit"); chunks.push(chunk);
      }
      req.setTimeout(0);
      const body = validatePaneMcpBody(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
      const supplied = req.headers["x-agend-native-token"] as string;
      if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token(body.owner))) || !this.options.owned(body.owner)
        || this.options.requestContextProtocol === 1 && (!arrivalOwner || key(arrivalOwner) !== key(body.owner))) throw Error("Pane MCP scope is unavailable");
      const current = (): boolean => !res.destroyed && !res.writableEnded && this.options.owned(body.owner);
      let forwardStamp = arrivalStamp;
      if (arrivalStamp && (body.method === "tools/call" || body.method === "response-written")) {
        const callKey = `${arrivalToken}:${body.helperId}:${body.callId}`;
        if (body.method === "tools/call") {
          const original = this.callStamps.get(callKey);
          const identity = (stamp: RequestContextCallStamp): string => stamp.coverage === "covered" ? `covered:${stamp.proof}` : `not-covered:${stamp.reason}`;
          if (original && identity(original) !== identity(arrivalStamp)) throw Error("Pane MCP call identity changed originating input");
          if (!original) {
            if (this.callStamps.size >= 65_536) throw Error("Pane MCP call-stamp registry requires retirement");
            this.callStamps.set(callKey, arrivalStamp);
          }
        } else {
          // A stdout receipt belongs to the ORIGINAL call, never a later installed input.
          forwardStamp = this.callStamps.get(callKey);
          if (!forwardStamp) throw Error("Pane MCP response attribution is unavailable");
        }
      }
      const result = forwardStamp ? await this.options.forward(body, current, forwardStamp) : await this.options.forward(body, current);
      if (!current()) throw Error("Pane MCP lease expired");
      answer(200, result);
    } catch { answer(403, { error: "Pane MCP request was refused or is unconfirmed; it was not replayed" }); }
    finally { await finished; this.pending--; }
  }
}
