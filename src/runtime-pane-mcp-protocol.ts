/** Provider-independent persistent pane MCP identity, separate from per-turn exec grants. */
import { validWindowsAgentId } from "./windows-cli-worker.js";
export interface PaneMcpOwner { hostBootId: string; paneId: string; launchId: string; agentId: string; instance: string }
export type PaneMcpBody = { op: "pane-mcp"; owner: PaneMcpOwner; helperId: string } & (
  | { method: "tools/list"; params: Record<string, never> }
  | { method: "tools/call"; callId: string; params: { name: string; arguments: Record<string, unknown> } }
  | { method: "response-written"; callId: string; responseId: string }
);
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function validatePaneMcpOwner(value: unknown): PaneMcpOwner {
  if (!object(value) || Object.keys(value).some(key => !["hostBootId", "paneId", "launchId", "agentId", "instance"].includes(key))
    || ![value.hostBootId, value.paneId, value.launchId, value.agentId].every(validWindowsAgentId)
    || typeof value.instance !== "string" || !/^[\p{L}\p{N}_.-]{1,160}$/u.test(value.instance)) throw Error("Invalid pane MCP owner");
  return value as unknown as PaneMcpOwner;
}
export function validatePaneMcpBody(value: unknown): PaneMcpBody {
  if (!object(value) || value.op !== "pane-mcp" || !validWindowsAgentId(value.helperId)
    || Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) throw Error("Invalid pane MCP request");
  validatePaneMcpOwner(value.owner);
  const common = ["op", "owner", "helperId", "method"];
  if (value.method === "tools/list") {
    if (Object.keys(value).some(key => ![...common, "params"].includes(key)) || !object(value.params) || Object.keys(value.params).length) throw Error("Invalid pane MCP menu request");
  } else if (value.method === "tools/call") {
    if (Object.keys(value).some(key => ![...common, "callId", "params"].includes(key)) || typeof value.callId !== "string" || !/^[a-f0-9]{64}$/.test(value.callId)
      || !object(value.params) || Object.keys(value.params).some(key => !["name", "arguments"].includes(key)) || typeof value.params.name !== "string"
      || !/^[a-z][a-z0-9_]{0,63}$/.test(value.params.name) || !object(value.params.arguments)) throw Error("Invalid pane MCP tool call");
  } else if (value.method === "response-written") {
    if (Object.keys(value).some(key => ![...common, "callId", "responseId"].includes(key)) || typeof value.callId !== "string" || !/^[a-f0-9]{64}$/.test(value.callId)
      || typeof value.responseId !== "string" || !/^[a-f0-9]{64}$/.test(value.responseId)) throw Error("Invalid pane MCP response receipt");
  } else throw Error("Unsupported pane MCP method");
  return value as unknown as PaneMcpBody;
}
export function samePaneMcpOwner(a: PaneMcpOwner, b: PaneMcpOwner): boolean {
  return a.hostBootId === b.hostBootId && a.paneId === b.paneId && a.launchId === b.launchId && a.agentId === b.agentId && a.instance === b.instance;
}
