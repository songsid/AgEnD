/**
 * Agent CLI HTTP endpoint — handles POST /agent requests from thin CLI clients.
 * Replaces MCP tool calls with a simple JSON-in/JSON-out HTTP API.
 *
 * Request:  POST /agent { "instance": "dev", "op": "reply", "args": { "text": "hello" } }
 * Response: JSON result (same shape as MCP tool results)
 *
 * Authentication: every request must carry `X-Agend-Instance-Token`. The
 * daemon writes a fresh 32-byte token to <instanceDir>/agent.token (mode 0600)
 * on each spawn; agent-cli reads it and sends it in the header. The endpoint
 * verifies the header matches the on-disk token for the claimed instance,
 * preventing a local process from impersonating another instance.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { OutboundContext } from "./outbound-handlers.js";
import { outboundHandlers } from "./outbound-handlers.js";
import { routeToolCall } from "./channel/tool-router.js";
import { replyDedupText } from "./reply-dedup.js";
import { readBoundedWebBody } from "./web-body.js";
import {
  EARLY_AGENT_OP_TOOLS,
  mayUseTool,
  resolveToolSet,
  toolRefusedMessage,
} from "./tool-permissions.js";

export interface PersistedReplyContext {
  chatId: string;
  threadId?: string;
  adapterId?: string;
}

/** Read the last real channel target persisted by the instance daemon. */
export function readPersistedReplyContext(dataDir: string, instance: string): PersistedReplyContext | null {
  // Prevent path traversal; allow Unicode (e.g. Chinese instance names)
  if (!instance || instance.includes("/") || instance.includes("\\") || instance.includes("..")) return null;
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "instances", instance, "last-chat.json"), "utf-8")) as Record<string, unknown>;
    if (typeof raw.chatId !== "string" || !raw.chatId) return null;
    return {
      chatId: raw.chatId,
      ...(typeof raw.threadId === "string" && raw.threadId ? { threadId: raw.threadId } : {}),
      ...(typeof raw.adapterId === "string" && raw.adapterId ? { adapterId: raw.adapterId } : {}),
    };
  } catch {
    return null;
  }
}

/** Op name mapping: CLI command → internal tool name */
const OP_MAP: Record<string, string> = {
  // Channel
  reply: "reply",
  react: "react",
  edit: "edit_message",
  download: "download_attachment",
  // Communication
  send: "send_to_instance",
  delegate: "delegate_task",
  report: "report_result",
  ask: "request_information",
  "delivery-status": "delivery_status",
  broadcast: "broadcast",
  // Instance management
  list: "list_instances",
  describe: "describe_instance",
  start: "start_instance",
  spawn: "create_instance",
  delete: "delete_instance",
  replace: "replace_instance",
  rename: "set_display_name",
  "set-description": "set_description",
  // Teams
  "team-create": "create_team",
  "team-delete": "delete_team",
  "team-list": "list_teams",
  "team-update": "update_team",
  // Deployments
  deploy: "deploy_template",
  teardown: "teardown_deployment",
  "deploy-list": "list_deployments",
};

/** Schedule/decision/task ops handled separately (they go through fleet-manager CRUD methods) */
type CrudHandler = (ctx: OutboundContext, instance: string, args: Record<string, unknown>) => Promise<unknown>;

export interface AgentEndpointContext extends OutboundContext {
  /** Absolute data directory (e.g. ~/.agend). Used to locate per-instance token files. */
  readonly dataDir: string;
  /** Duplicate-reply suppression shared with the MCP path (see reply-dedup.ts). */
  readonly replyDeduper?: import("./reply-dedup.js").ReplyDeduper;
  /** The MCP path's `reply.stickers` pre-check (#1226): a refused sticker is the reply's error, sent nothing. */
  replyStickerProblem?(adapter: import("./channel/types.js").ChannelAdapter, args: Record<string, unknown>, threadId: string | undefined, worldId: string | undefined): Promise<string | null>;
  /** Mark an HTTP durable-operation result once its response is written. */
  markDurableResponseDelivered?(sourceInstance: string, operationId: string): void;
  handleScheduleCrudHttp(instance: string, op: string, args: Record<string, unknown>): Promise<unknown>;
  handleDecisionCrudHttp(instance: string, op: string, args: Record<string, unknown>): Promise<unknown>;
  handleTaskCrudHttp(instance: string, args: Record<string, unknown>): Promise<unknown>;
  handleSetDisplayNameHttp(instance: string, name: string): Promise<unknown>;
  handleSetDescriptionHttp(instance: string, description: string): Promise<unknown>;
  handleListEmojisHttp(instance: string, refresh: boolean, args?: Record<string, unknown>): Promise<unknown>;
  handleListStickersHttp(instance: string, args: Record<string, unknown>): Promise<unknown>;
  handlePreviewStickersHttp(instance: string, args: Record<string, unknown>): Promise<unknown>;
  handleSetPersonaEmojiHttp(instance: string, args: Record<string, unknown>): Promise<unknown>;
  handlePreviewEmojisHttp(instance: string, args: Record<string, unknown>): Promise<unknown>;
}

const DURABLE_HTTP_TOOLS = new Set([
  "send_to_instance",
  "broadcast",
  "report_result",
  "delegate_task",
  "request_information",
]);

/**
 * Constant-time comparison of the provided header against the per-instance
 * token file. Returns true on match, false on any error (missing file, bad
 * instance name, length mismatch, wrong value).
 */
function verifyInstanceToken(
  ctx: AgentEndpointContext,
  instance: string,
  provided: string | undefined,
): boolean {
  if (!provided) return false;
  // instance name must be a safe filename component (allow Unicode, block traversal)
  if (!instance || instance.includes("/") || instance.includes("\\") || instance.includes("..")) return false;
  const tokenPath = join(ctx.dataDir, "instances", instance, "agent.token");
  let expected: string;
  try {
    expected = readFileSync(tokenPath, "utf-8").trim();
  } catch {
    return false;
  }
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function handleAgentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AgentEndpointContext,
): void {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // ── (1) Validate token BEFORE reading the body ──────────────────────────
  // Reading an unbounded body before authentication lets any local process
  // exhaust memory by sending a large unauthenticated request. Extract the
  // instance from the header, then verify the token before touching the body.
  //
  // Header format: "X-Agend-Instance-Token: <encodedInstance>:<token>"
  // where <encodedInstance> is encodeURIComponent(instanceName). The daemon
  // writes a fresh token (token only, no instance name) to
  // <instanceDir>/agent.token; agend-agent reads it and assembles the full
  // header as encodeURIComponent(AGEND_INSTANCE_NAME) + ":" + token.
  const rawHeader = req.headers["x-agend-instance-token"];
  const headerValue = typeof rawHeader === "string" ? rawHeader
    : Array.isArray(rawHeader) ? rawHeader[0] : undefined;

  // Fast-path rejection: header absent.
  if (!headerValue) {
    req.resume(); // drain the socket so the client isn't left hanging
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Missing instance token" }));
    return;
  }

  // The header carries "<encodedInstance>:<token>" — split on the first colon
  // only (the token is a hex string that never contains a colon; the colon in
  // the encoded instance name would be %3A so splitting on the first literal
  // colon is unambiguous).
  const colonIdx = headerValue.indexOf(":");
  const encodedInstance = colonIdx > 0 ? headerValue.slice(0, colonIdx) : "";
  const tokenFromHeader = colonIdx > 0 ? headerValue.slice(colonIdx + 1) : headerValue;

  let instanceFromHeader: string;
  try {
    instanceFromHeader = decodeURIComponent(encodedInstance);
  } catch {
    // Malformed percent-encoding → treat as invalid token.
    req.resume();
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Invalid or missing instance token" }));
    return;
  }

  if (!instanceFromHeader || !verifyInstanceToken(ctx, instanceFromHeader, tokenFromHeader)) {
    req.resume();
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Invalid or missing instance token" }));
    return;
  }

  // ── (2) Read body with a size limit ─────────────────────────────────────
  // The web API uses 512 KiB for JSON requests; the agent endpoint uses the
  // same limit. Agent CLI payloads are small (instance name, op, and args
  // for a single MCP-like call) so 512 KiB is generous.
  const MAX_AGENT_BODY = 512 * 1024; // 512 KiB — same as web-api.ts:243
  void (async () => {
    let bodyBuf: Buffer;
    try {
      bodyBuf = await readBoundedWebBody(req, MAX_AGENT_BODY);
    } catch {
      res.writeHead(413);
      res.end(JSON.stringify({ error: "Request body too large" }));
      return;
    }

    try {
      const { instance, op, args = {} } = JSON.parse(bodyBuf.toString("utf8")) as {
        instance: string;
        op: string;
        args?: Record<string, unknown>;
      };

      if (!instance || !op) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing instance or op" }));
        return;
      }

      // Re-verify that the body's instance matches the header's instance.
      // This prevents a valid token for instance A from being used to act
      // on instance B by putting B in the body.
      if (instance !== instanceFromHeader) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Instance in body does not match token" }));
        return;
      }

      const result = await dispatchAgentOperation(ctx, instance, op, args);
      res.writeHead(200, { "Content-Type": "application/json" });
      const operationId = result && typeof result === "object" && !Array.isArray(result)
        && typeof (result as Record<string, unknown>).operation_id === "string"
        ? (result as Record<string, unknown>).operation_id as string
        : undefined;
      res.end(JSON.stringify(result), () => {
        if (operationId) ctx.markDurableResponseDelivered?.(instance, operationId);
      });
    } catch (err) {
      // A refusal is not a malformed request: 403 says "you, specifically, may
      // not", which is what the caller has to act on.
      const status = err instanceof ToolNotPermittedError ? 403
        : err instanceof UnknownAgentOpError ? err.status
        : 400;
      res.writeHead(status);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  })();
}

/** An op this endpoint has never heard of: the caller's mistake, answered 400. */
export class UnknownAgentOpError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "UnknownAgentOpError";
  }
}

/** Refused by policy, not by a bad request: the endpoint answers this as 403. */
export class ToolNotPermittedError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "ToolNotPermittedError";
  }
}

/**
 * The tool an op means, whichever way it is dispatched.
 *
 * `OP_MAP` alone would miss these: the schedule, decision, task, usage, rename and emoji
 * ops are answered before it is consulted, so a permission table built from it
 * would have had holes exactly where the early returns are.
 */
export function toolForAgentOp(op: string): string | null {
  // Own-property only: `"constructor"` is in both objects by inheritance, and
  // would otherwise resolve to a function that then gets treated as a name.
  if (Object.hasOwn(EARLY_AGENT_OP_TOOLS, op)) return EARLY_AGENT_OP_TOOLS[op]!;
  if (Object.hasOwn(OP_MAP, op)) return OP_MAP[op]!;
  return null;
}

export async function dispatchAgentOperation(
  ctx: AgentEndpointContext,
  instance: string,
  op: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Sink 3 of 3, before any branch below: the early-returning ops are as much
  // a tool call as the mapped ones. Stage 1 records and continues; the refusal
  // arrives in stage 2.
  const requestedTool = toolForAgentOp(op);
  if (requestedTool) {
    const profile = resolveToolSet(ctx.fleetConfig?.instances[instance], instance);
    if (!mayUseTool(profile, requestedTool)) {
      ctx.logger.warn(
        { sink: "agent-endpoint", instance, profile, tool: requestedTool, enforced: true },
        "tool-permissions: refused",
      );
      throw new ToolNotPermittedError(toolRefusedMessage(profile, requestedTool));
    }
  }

  // HTTP/CLI agents do not pass through mcp-server.ts, so assign the same
  // durable-operation identity at this ingress before invoking an outbound
  // handler. The returned operation_id lets the CLI report/query the exact
  // accepted operation instead of retrying it as a new tool call.
  const operationId = requestedTool && DURABLE_HTTP_TOOLS.has(requestedTool)
    ? randomUUID()
    : undefined;

  // Schedule CRUD
  if (op.startsWith("schedule-")) {
    const subOp = op.replace("schedule-", "");
    return ctx.handleScheduleCrudHttp(instance, subOp, args);
  }

  // Decision CRUD
  if (op.startsWith("decision-")) {
    const subOp = op.replace("decision-", "");
    return ctx.handleDecisionCrudHttp(instance, subOp, args);
  }

  // Task board
  if (op === "task") {
    return ctx.handleTaskCrudHttp(instance, args);
  }

  // AI subscription usage — same snapshot and cache as /usage and the web panel.
  // Returns the full payload plus a pre-rendered `formatted` text so the CLI can
  // print something readable without owning the formatting.
  if (op === "usage") {
    const { getUsageSnapshot, formatUsageSummary } = await import("./usage/usage-api.js");
    const payload = await getUsageSnapshot(
      args.force === true || args.force === "true",
      ctx.getActiveUsageProviderIds?.(),
    );
    return { formatted: formatUsageSummary(payload), ...payload };
  }

  // Display name / description
  if (op === "rename") {
    return ctx.handleSetDisplayNameHttp(instance, args.name as string ?? args.display_name as string ?? "");
  }
  if (op === "set-description") {
    return ctx.handleSetDescriptionHttp(instance, args.description as string ?? "");
  }
  if (op === "emojis") {
    return ctx.handleListEmojisHttp(instance, args.refresh === true || args.refresh === "true", args);
  }
  if (op === "persona-emoji") {
    return ctx.handleSetPersonaEmojiHttp(instance, args);
  }
  if (op === "emoji-preview") {
    return ctx.handlePreviewEmojisHttp(instance, args);
  }
  if (op === "stickers") {
    return ctx.handleListStickersHttp(instance, args);
  }
  if (op === "sticker-preview") {
    return ctx.handlePreviewStickersHttp(instance, args);
  }

  // Map CLI op to internal tool name
  const tool = OP_MAP[op];
  if (!tool) {
    // 200 with an error body reads as success to anything checking the status,
    // and an unknown op is the caller's mistake.
    throw new UnknownAgentOpError(`Unknown op: ${op}`);
  }

  // Channel tools (reply, react, edit, download)
  const channelTools = new Set(["reply", "react", "edit_message", "download_attachment"]);
  if (channelTools.has(tool)) {
    return (async (): Promise<unknown> => {
      const persisted = readPersistedReplyContext(ctx.dataDir, instance);
      const configuredThreadId = ctx.fleetConfig?.instances[instance]?.topic_id != null
        ? String(ctx.fleetConfig.instances[instance].topic_id)
        : undefined;
      const configuredChatId = ctx.getGroupIdForInstance?.(instance) ?? (ctx.fleetConfig?.channel?.group_id
        ? String(ctx.fleetConfig.channel.group_id)
        : "");
      const classicChannelId = ctx.classicChannels?.getChannelIdByInstance?.(instance);
      const chatId = classicChannelId ?? persisted?.chatId ?? configuredChatId;
      const threadId = classicChannelId ? undefined : (persisted?.threadId ?? configuredThreadId);
      if (tool !== "download_attachment" && !chatId) {
        return { error: "No active chat context — awaiting inbound message" };
      }
      const fullArgs = { ...args, chat_id: chatId, ...(threadId ? { thread_id: threadId } : {}) };
      const adapter = (persisted?.adapterId ? ctx.adapters?.get(persisted.adapterId) : undefined)
        ?? ctx.getAdapterForInstance?.(instance) ?? ctx.adapter!;

      // The same pre-check as the MCP path, before anything is sent: a sticker this channel cannot send
      // (another server's, an id that is not Telegram's) is the reply's error, not a reply without it.
      if (tool === "reply" && ctx.replyStickerProblem) {
        const problem = await ctx.replyStickerProblem(adapter, fullArgs, threadId, persisted?.adapterId);
        if (problem) return { error: problem };
      }

      return new Promise((resolve) => {
        // Reply dedup, same ledger as the MCP path. The HTTP variant of the race:
        // the agent's shell tool kills a slow `agend-agent reply` (the adapter send
        // is waiting out a rate limit and will succeed), the agent re-runs it, and
        // the channel shows the reply twice.
        const ticket = tool === "reply"
          ? ctx.replyDeduper?.begin(
            instance,
            replyDedupText(args as Record<string, unknown>),
            Array.isArray((args as Record<string, unknown>).files) ? (args as Record<string, unknown>).files as string[] : [],
          )
          : undefined;
        if (ticket?.duplicate) {
          ticket.subscribe((result, error) => resolve(error ? { error } : result));
          return;
        }

        const handled = routeToolCall(adapter, tool, fullArgs, threadId, (result, error) => {
          if (ticket && !ticket.duplicate) ticket.complete(result, error);
          // A successful reply retires the instance's cancel button — mirroring the
          // MCP path (handleOutboundFromInstance). HTTP agents (e.g. Antigravity,
          // which replies via POST /agent instead of an MCP tool call) never hit
          // that path, so without this their cancel button would never clear.
          if (!error && tool === "reply") ctx.clearCancelButton?.(instance);
          resolve(error ? { error } : result);
        });
        if (!handled) {
          if (ticket && !ticket.duplicate) ticket.complete(null, "unhandled");
          resolve({ error: `Unhandled channel tool: ${tool}` });
        }
      });
    })();
  }

  // Fleet tools (outbound handlers)
  const handler = outboundHandlers.get(tool);
  if (!handler) {
    return { error: `No handler for tool: ${tool}` };
  }

  return new Promise((resolve) => {
    let settled = false;
    const respond = (result: unknown, error?: string) => {
      if (settled) return;
      settled = true;
      const response = error ? { error } : result;
      if (!operationId) {
        resolve(response);
      } else if (response && typeof response === "object" && !Array.isArray(response)) {
        resolve({ ...(response as Record<string, unknown>), operation_id: operationId });
      } else {
        resolve({ result: response, operation_id: operationId });
      }
    };
    const returned = handler(ctx, args, respond, {
      instanceName: instance,
      requestId: undefined,
      fleetRequestId: undefined,
      senderSessionName: undefined,
      ...(operationId ? { operationId, sourceDaemonBootId: ctx.getDaemonBootId?.(instance) } : {}),
    });
    void Promise.resolve(returned).catch(err => respond(null, (err as Error).message));
  });
}
