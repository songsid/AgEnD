// M-3653: a stdio MCP server that answers initialize, tools/list (one "ping" tool) and tools/call, and appends each
// start, request and exit to STUB_MARK. With GEN_MCP pointing here, the rig launches codex with it registered the way
// AgEnD registers its own server, so mcp-start.sh can show when codex starts it.
import { appendFileSync } from "node:fs";
const mark = process.env.STUB_MARK;
const log = (what) => { if (mark) appendFileSync(mark, `${Date.now()} ${process.pid} ${what}\n`); };
log("start");
process.on("exit", () => log("exit"));
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => { log(s); process.exit(0); });
let buf = "";
process.stdin.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
    if (m.method === "initialize") { log("initialize"); reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1.0.0" } }); }
    else if (m.method === "tools/list") { log("tools/list"); reply({ tools: [{ name: "ping", description: "Answers pong.", inputSchema: { type: "object", properties: {} } }] }); }
    else if (m.method === "tools/call") { log("tools/call"); reply({ content: [{ type: "text", text: "pong" }] }); }
    else reply({});
  }
});
process.stdin.on("end", () => { log("stdin-end"); process.exit(0); });
