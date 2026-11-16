/** Stdio transport only; listing never asks the Fleet, a Hub, a CLI or the network. */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { staticPersonMcp } from "./mcp.js";
import { OWNER_APP_TOOLS, ownerAppSchemas, type OwnerAppOperation } from "./protocol.js";

export function ownerAppMcp(call: (operation: OwnerAppOperation, input: unknown) => Promise<unknown>): Server {
  return staticPersonMcp({name:"agend-connect",tools:OWNER_APP_TOOLS,
    instructions: "Talk to your own Fleet agents and read their answers and task board. This local connector does not provide administrative tools or approval authority. Messages are app-originated, not proof of a human approval.",call:async(name,args)=>{
    let operationId: string | undefined;
    try {
      if (!Object.hasOwn(ownerAppSchemas, name)) throw new Error("This connector does not offer that operation.");
      const input = ownerAppSchemas[name as OwnerAppOperation].parse(args);
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
  }});
}
export async function serveOwnerApp(call: (operation: OwnerAppOperation, input: unknown) => Promise<unknown>): Promise<Server> {
  const server = ownerAppMcp(call);
  await server.connect(new StdioServerTransport());
  return server;
}
