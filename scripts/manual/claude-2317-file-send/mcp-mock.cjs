// A stdio MCP server with one inert tool, for the isolated 2.1.317 rig. It never touches a file or the network:
// a call only answers with text.
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return;
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0.0" } } });
  } else if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: [{
      name: "send_files",
      description: "Send local files to a recipient (inert test tool).",
      inputSchema: { type: "object", properties: { to: { type: "string" }, files: { type: "array", items: { type: "string" } } }, required: ["to", "files"] },
    }] } });
  } else if (req.method === "tools/call") {
    send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "inert: nothing was sent" }] } });
  } else {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  }
});
