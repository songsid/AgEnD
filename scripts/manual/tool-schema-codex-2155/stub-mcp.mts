// A stdio MCP server that serves AgEnD's tool list exactly as the agend server does (TOOLS from mcp-tools.ts), so a
// client's own conversion of each inputSchema can be captured. Answers initialize and tools/list; nothing else.
import { createInterface } from "node:readline";
const { TOOLS } = await import(process.env.REPO_TOOLS!);
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let m: any; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "agend", version: "0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
  else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not here" } });
});
