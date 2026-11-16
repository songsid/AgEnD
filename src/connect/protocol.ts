/** The local person's connector surface. No agent identity or administrative operation is accepted. */
import { z } from "zod";

const agent = z.string().min(1).max(128).refine(value => !/[\\/\u0000-\u001f\u007f]/.test(value) && !value.includes(".."));
const text = z.string().min(1).max(16_384).refine(value => value.trim().length > 0 && !value.trimStart().startsWith("/"));
export const ownerAppSchemas = {
  list_agents: z.strictObject({}),
  send_message: z.strictObject({ agent, text, operation_id: z.uuid().optional().describe("Only for reading the result of a retry: use an operation_id previously returned by this connector; omit it for a new message.") }),
  read_answer: z.strictObject({ agent, after: z.string().min(1).max(256).optional(), limit: z.number().int().min(1).max(50).optional() }),
  task_board: z.strictObject({ card: z.string().min(1).max(80).optional(), agent: agent.optional(), limit: z.number().int().min(1).max(100).optional() }),
};
export type OwnerAppOperation = keyof typeof ownerAppSchemas;
export type OwnerAppInput<K extends OwnerAppOperation> = z.infer<typeof ownerAppSchemas[K]>;
export const OWNER_APP_TOOLS = Object.entries(ownerAppSchemas).map(([name, schema]) => {
  const { $schema: _version, ...inputSchema } = z.toJSONSchema(schema);
  return { name, description: {
    list_agents: "List this local owner's Fleet agents and their current status.",
    send_message: "Send a question to one of this owner's agents. Returns a cursor for reading later answers. Slash commands and approvals are not supported. Keep operation_id when retrying an uncertain send.",
    read_answer: "Read an agent's answer messages after the cursor returned by send_message. Other conversation replies may also be present. This does not wait for a turn to finish.",
    task_board: "Read this Fleet's task board or one card. This tool cannot create, edit, assign or approve anything.",
  }[name as OwnerAppOperation], inputSchema: inputSchema as { type: "object"; [key: string]: unknown } };
});

export interface OwnerAppService {
  current(): boolean;
  listAgents(): unknown;
  send(input: OwnerAppInput<"send_message">, current: () => boolean): Promise<unknown>;
  readAnswers(input: OwnerAppInput<"read_answer">): unknown;
  readBoard(input: OwnerAppInput<"task_board">): unknown;
}
export async function dispatchOwnerApp(service: OwnerAppService, operation: unknown, args: unknown, connected: () => boolean): Promise<unknown> {
  if (typeof operation !== "string" || !Object.hasOwn(ownerAppSchemas, operation)) throw new Error("This connector does not offer that operation.");
  const name = operation as OwnerAppOperation;
  const input = ownerAppSchemas[name].parse(args);
  const current = () => connected() && service.current();
  if (!current()) throw new Error("The Fleet is not available. Start AgEnD and try again.");
  const result = name === "list_agents" ? service.listAgents()
    : name === "send_message" ? await service.send(input as OwnerAppInput<"send_message">, current)
    : name === "read_answer" ? service.readAnswers(input as OwnerAppInput<"read_answer">)
    : service.readBoard(input as OwnerAppInput<"task_board">);
  if (!current()) throw new Error("The Fleet connection changed; read the current state before retrying.");
  return result;
}
