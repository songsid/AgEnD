/** Local pane-scoped MCP endpoint. The CLI never receives the host or enrollment credential. */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { validatePaneMcpBody, validatePaneMcpOwner, type PaneMcpBody, type PaneMcpOwner } from "./runtime-pane-mcp-protocol.js";
import type { PaneMcpConnection } from "./windows-pane-mcp.js";
export interface PaneMcpRelayOptions {
  secret: string;
  endpoint(): string;
  owned(owner: PaneMcpOwner): boolean;
  forward(body: PaneMcpBody, current: () => boolean): Promise<unknown>;
}
function key(owner: PaneMcpOwner): string { return JSON.stringify([owner.hostBootId, owner.paneId, owner.launchId, owner.agentId, owner.instance]); }
export class PaneMcpRelay {
  private pending = 0;
  get pendingCount(): number { return this.pending; }
  constructor(private options: PaneMcpRelayOptions) {}
  private token(owner: PaneMcpOwner): string { return createHmac("sha256", this.options.secret).update(key(owner)).digest("hex"); }
  connection(owner: PaneMcpOwner, tools: string[]): PaneMcpConnection {
    validatePaneMcpOwner(owner);
    if (!this.options.owned(owner)) throw Error("Pane MCP owner is unavailable");
    return { endpoint: this.options.endpoint(), token: this.token(owner), owner: { ...owner }, tools: [...tools] };
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
      if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token(body.owner))) || !this.options.owned(body.owner)) throw Error("Pane MCP scope is unavailable");
      const current = (): boolean => !res.destroyed && !res.writableEnded && this.options.owned(body.owner);
      const result = await this.options.forward(body, current);
      if (!current()) throw Error("Pane MCP lease expired");
      answer(200, result);
    } catch { answer(403, { error: "Pane MCP request was refused or is unconfirmed; it was not replayed" }); }
    finally { await finished; this.pending--; }
  }
}
