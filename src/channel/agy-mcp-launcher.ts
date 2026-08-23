#!/usr/bin/env node
/**
 * Antigravity only supports a global MCP config. Keep one shared launcher in
 * that config and select its behavior from the environment inherited from the
 * owning agy process: AgEnD instances run the real server, unrelated agy
 * sessions get a healthy empty server instead of another instance's tools.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

async function main(): Promise<void> {
  if (process.env.AGEND_SOCKET_PATH) {
    await import("./mcp-server.js");
    return;
  }

  const server = new Server(
    { name: "agend-fleet-inactive", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "AgEnD tools are only available inside an AgEnD-managed instance." }],
    isError: true,
  }));
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`agend: Antigravity MCP launcher failed: ${err}\n`);
  process.exit(1);
});
