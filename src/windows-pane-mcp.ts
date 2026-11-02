/** Persistent pane stdio helper. A fresh helper identity prevents JSON-RPC id reuse after a helper restart. */
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lstatSync, readFileSync } from "node:fs";
import { validateNativeMcpConnection, type NativeMcpConnection } from "./windows-cli-providers.js";
import { nativeMcpCallId, nativeMcpRpc, type NativeMcpRequest } from "./windows-native-mcp.js";
import { validatePaneMcpBody, validatePaneMcpOwner, type PaneMcpBody, type PaneMcpOwner } from "./runtime-pane-mcp-protocol.js";
export interface PaneMcpConnection extends NativeMcpConnection { owner: PaneMcpOwner }
export function readPaneMcpConnection(path: string): PaneMcpConnection {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_000 || process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw Error("Pane MCP connection is not private");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !["endpoint", "token", "tools", "owner"].includes(key))) throw Error("Invalid pane MCP connection");
  return { ...validateNativeMcpConnection({ endpoint: value.endpoint, token: value.token, tools: value.tools }), owner: validatePaneMcpOwner(value.owner) };
}
export function paneMcpHttp(connection: PaneMcpConnection, body: PaneMcpBody): Promise<unknown> {
  const checked = validateNativeMcpConnection({ endpoint: connection.endpoint, token: connection.token, tools: connection.tools });
  const text = JSON.stringify(validatePaneMcpBody(body));
  return new Promise((resolve, reject) => {
    const call = request(checked.endpoint, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "X-Agend-Native-Token": checked.token } }, response => {
      let text = "", bytes = 0; response.setEncoding("utf8");
      response.on("data", (part: string) => { bytes += Buffer.byteLength(part); if (bytes > 192 * 1024) call.destroy(); else text += part; });
      response.on("error", () => reject(Error("Pane MCP response was interrupted")));
      response.on("end", () => { if (response.statusCode !== 200) { reject(Error("Pane MCP scope is unavailable")); return; } try { resolve(JSON.parse(text)); } catch { reject(Error("Invalid pane MCP response")); } });
    });
    call.setTimeout(90_000, () => call.destroy()); call.on("error", () => reject(Error("Pane MCP connection is unavailable"))); call.end(text);
  });
}
export class PaneMcpSession {
  readonly helperId = randomUUID();
  private readonly receipts = new Map<string, string>();
  private initializeId: string | number | undefined;
  private ready = false;
  private closed = false;
  private pinging = false;
  constructor(private connection: PaneMcpConnection, private http: (body: PaneMcpBody) => Promise<unknown> = body => paneMcpHttp(connection, body)) {}
  async rpc(input: unknown): Promise<Record<string, unknown> | null> {
    if (this.closed) throw Error("Pane MCP helper has closed");
    const transport = async (request: NativeMcpRequest): Promise<unknown> => {
      if (this.receipts.size >= 64) throw Error("Pane MCP response backlog is full");
      const body = validatePaneMcpBody({ ...request, op: "pane-mcp", owner: this.connection.owner, helperId: this.helperId });
      const response = await this.http(body) as { result?: unknown; responseId?: unknown };
      if (body.method === "tools/call" && typeof response?.responseId === "string" && /^[a-f0-9]{64}$/.test(response.responseId)) this.receipts.set(body.callId, response.responseId);
      return response?.result;
    };
    const response = await nativeMcpRpc(input, this.connection, transport, { clientSessionId: this.helperId, instructions: "AgEnD tools belong to this persistent agent and its current configured permissions." });
    if (input && typeof input === "object" && !Array.isArray(input) && (input as any).method === "initialize"
      && response && Object.hasOwn(response, "result") && (typeof response.id === "string" || typeof response.id === "number")) this.initializeId = response.id;
    return response;
  }
  close(): void { this.closed = true; this.ready = false; }
  async heartbeat(): Promise<void> {
    if (this.closed || !this.ready || this.pinging) return;
    this.pinging = true;
    try { await this.http({ op: "pane-mcp", owner: this.connection.owner, helperId: this.helperId, method: "presence", params: {} }); }
    finally { this.pinging = false; }
  }
  async responseWritten(value: Record<string, unknown>): Promise<void> {
    const id = value.id;
    if (!Object.hasOwn(value, "result") || typeof id !== "string" && typeof id !== "number") return;
    if (id === this.initializeId) { this.initializeId = undefined; this.ready = true; await this.heartbeat(); }
    const callId = nativeMcpCallId(this.connection.token, id, this.helperId), responseId = this.receipts.get(callId);
    if (!responseId) return;
    this.receipts.delete(callId);
    await this.http({ op: "pane-mcp", owner: this.connection.owner, helperId: this.helperId, method: "response-written", callId, responseId });
  }
}
export async function paneMcpMain(connection: PaneMcpConnection): Promise<void> {
  const session = new PaneMcpSession(connection);
  const presence = setInterval(() => { void session.heartbeat().catch(() => {}); }, 5_000); presence.unref();
  process.stdin.once("close", () => { clearInterval(presence); session.close(); });
  let buffer = "", pending = 0, failed = false;
  process.stdout.on("error", () => { failed = true; process.stdin.destroy(); });
  const send = (value: Record<string, unknown>): void => {
    const text = JSON.stringify(value) + "\n";
    if (process.stdout.writableLength > 256 * 1024 || Buffer.byteLength(text) > 192 * 1024) { failed = true; process.stdin.destroy(); return; }
    process.stdout.write(text, error => {
      if (error) return;
      // The response-written barrier is the successful stdio write, never resolution of either relay hop.
      void session.responseWritten(value).catch(() => {});
    });
  };
  process.stdin.setEncoding("utf8").on("data", (part: string) => {
    if (failed) return; buffer += part;
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) break;
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue;
      if (Buffer.byteLength(line) > 64 * 1024 || pending >= 32) { failed = true; process.stdin.destroy(); return; }
      let input: unknown; try { input = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
      pending++;
      void session.rpc(input)
        .then(response => { if (response) send(response); }).catch(() => { failed = true; process.stdin.destroy(); }).finally(() => { pending--; });
    }
    if (Buffer.byteLength(buffer) > 64 * 1024) { failed = true; process.stdin.destroy(); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--connection-file") throw Error("Missing pane MCP scope");
    void paneMcpMain(readPaneMcpConnection(process.argv[3])).catch(() => { process.exitCode = 1; });
  } catch { process.stderr.write("Persistent pane MCP scope is unavailable\n"); process.exitCode = 1; }
}
