/** Stdio transport only; listing never asks the Fleet, a Hub, a CLI or the network. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { OWNER_APP_TOOLS, ownerAppSchemas, type OwnerAppOperation } from "./protocol.js";

export function ownerAppMcp(call: (operation: OwnerAppOperation, input: unknown) => Promise<unknown>): Server {
  const server = new Server({ name: "agend-connect", version: "1" }, { capabilities: { tools: {} },
    instructions: "Talk to your own Fleet agents and read their answers and task board. This local connector does not provide administrative tools or approval authority. Messages are app-originated, not proof of a human approval." });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: OWNER_APP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name;
    let operationId: string | undefined;
    try {
      if (!Object.hasOwn(ownerAppSchemas, name)) throw new Error("This connector does not offer that operation.");
      const input = ownerAppSchemas[name as OwnerAppOperation].parse(request.params.arguments ?? {});
      if (name === "send_message") {
        const send = input as { operation_id?: string };
        operationId = send.operation_id;
      }
      const result = await call(name as OwnerAppOperation, input);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "The Fleet call failed.";
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false,
        code: name === "send_message" ? "uncertain" : "unavailable", message,
        ...(name === "send_message" ? { next: "Read answers before sending again; do not automatically repeat a possibly handed-off message." } : {}),
        ...(operationId ? { operation_id: operationId } : {}) }) }] };
    }
  });
  return server;
}
export async function serveOwnerApp(call: (operation: OwnerAppOperation, input: unknown) => Promise<unknown>): Promise<Server> {
  const server = ownerAppMcp(call);
  await server.connect(new StdioServerTransport());
  return server;
}
