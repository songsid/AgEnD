// elicit-mcp.js: a stub stdio MCP server for the kiro 2.34 audit. It logs every message, advertises one tool and one
// prompt, and sends elicitation/create (a) right after `initialized` when ELICIT_ON_INIT=1 and (b) while answering
// prompts/get — so kiro's elicitation form can be reached offline, without a model.
const fs = require("fs");
const LOG = process.env.ELICIT_LOG || "/tmp/elicit.log";
const log = (dir, o) => fs.appendFileSync(LOG, `${Date.now()} ${dir} ${JSON.stringify(o)}\n`);
let buf = "", nextId = 1000; const pending = new Map();
const send = o => { log(">", o); process.stdout.write(JSON.stringify(o) + "\n"); };
const SCHEMA = { type: "object", properties: {
  colour: { type: "string", title: "Favourite colour", enum: ["red", "green", "blue"], enumNames: ["Red", "Green", "Blue"] },
  count: { type: "integer", title: "How many", minimum: 1, maximum: 9 },
  note: { type: "string", title: "A short note" } }, required: ["colour"] };
const elicit = () => new Promise(res => { const id = nextId++; pending.set(id, res);
  send({ jsonrpc: "2.0", id, method: "elicitation/create", params: { message: "The audit server asks for a few values", requestedSchema: SCHEMA } }); });
process.stdin.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
  let m; try { m = JSON.parse(line); } catch { continue; } log("<", m);
  if (m.id !== undefined && !m.method && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); continue; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "elicit-audit", version: "1.0.0" } } });
  else if (m.method === "notifications/initialized") { if (process.env.ELICIT_ON_INIT === "1") setTimeout(() => elicit(), 1500); }
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ask_values", description: "Asks the user for values", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.method === "prompts/list") send({ jsonrpc: "2.0", id: m.id, result: { prompts: [{ name: "askme", description: "Ask the user for values" }] } });
  else if (m.method === "prompts/get") elicit().then(r => send({ jsonrpc: "2.0", id: m.id, result: { messages: [{ role: "user", content: { type: "text", text: "elicited: " + JSON.stringify(r.result ?? r.error) } }] } }));
  else if (m.method === "tools/call") elicit().then(r => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "elicited: " + JSON.stringify(r.result ?? r.error) }] } }));
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
} });
