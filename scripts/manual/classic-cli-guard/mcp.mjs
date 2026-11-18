// Dummy MCP for a private guard rig. No credentials, account or Fleet.
import { appendFileSync } from "node:fs";
const [label, log] = process.argv.slice(2);
appendFileSync(`${log}.starts`, JSON.stringify({ server: label }) + "\n");
const tools = label === "agend" ? ["reply", "create_instance"] : ["lookup", "write"];
let buffer = "";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
process.stdin.on("error", () => process.exit(1)); process.stdout.on("error", () => process.exit(1));
process.stdin.on("data", data => {
  buffer += data;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: {
      protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "guard-fixture", version: "1.0.0" },
    } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: tools.map(name => ({
      name, description: "Local fixture only", inputSchema: { type: "object", properties: {}, additionalProperties: true },
    })) } });
    else if (m.method === "tools/call") {
      appendFileSync(log, JSON.stringify({ server: label, tool: m.params.name }) + "\n");
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ROOM_TOOL_OK" }] } });
    } else send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
