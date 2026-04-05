/**
 * Web UI HTTP API handler.
 * All /ui/* routes are handled here, extracted from fleet-manager.ts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Minimal interface — only what web-api needs from FleetManager. */
export interface WebApiContext {
  readonly webToken: string | null;
  readonly dataDir: string;
  readonly sseClients: Set<ServerResponse>;
  readonly fleetConfig: {
    channel?: { group_id?: number; mode?: string };
    instances: Record<string, { topic_id?: number | string; working_directory: string; description?: string; display_name?: string }>;
  } | null;
  readonly instanceIpcClients: Map<string, { send(msg: unknown): void }>;
  readonly adapter: { sendText(chatId: string, text: string, opts?: { threadId?: string }): Promise<unknown> } | null;
  readonly daemons: Map<string, unknown>;
  readonly eventLog: { logActivity(event: string, sender: string, summary: string, receiver?: string, detail?: string): void; listActivity(opts?: { since?: string; limit?: number }): unknown[] } | null;
  readonly logger: { info(obj: unknown, msg?: string): void; debug(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
  getInstanceDir(name: string): string;
  getInstanceStatus(name: string): "running" | "stopped" | "crashed";
  getUiStatus(): unknown;
  emitSseEvent(event: string, data: unknown): void;
  startInstance(name: string, config: unknown, topicMode: boolean): Promise<void>;
  stopInstance(name: string): Promise<void>;
  removeInstance(name: string): Promise<void>;
  lastInboundUser: Map<string, string>;
  saveFleetConfig(): void;
}

/** Parse JSON body from request. */
function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error("Invalid JSON")); }
    });
  });
}

/** Send JSON response. */
function json(res: ServerResponse, status: number, data: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

/**
 * Handle a Web UI request. Returns true if handled, false to pass through.
 */
export function handleWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: WebApiContext,
): boolean {
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Auth check for all /ui routes
  if (path.startsWith("/ui")) {
    const token = url.searchParams.get("token");
    if (token !== ctx.webToken) {
      json(res, 401, { error: "Unauthorized" });
      return true;
    }
  } else {
    return false;
  }

  // ── Static files ───────────────────────────────────────

  if (method === "GET" && path === "/ui") {
    try {
      const html = readFileSync(join(__dirname, "ui", "dashboard.html"), "utf-8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.writeHead(200);
      res.end(html);
    } catch {
      json(res, 500, { error: "dashboard.html not found" });
    }
    return true;
  }

  // Serve JS modules
  if (method === "GET" && path.startsWith("/ui/js/")) {
    const fileName = path.slice("/ui/js/".length);
    if (!/^[a-z0-9_-]+\.js$/.test(fileName)) {
      json(res, 400, { error: "Invalid file name" });
      return true;
    }
    try {
      const js = readFileSync(join(__dirname, "ui", fileName), "utf-8");
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.writeHead(200);
      res.end(js);
    } catch {
      json(res, 404, { error: "File not found" });
    }
    return true;
  }

  // ── SSE ────────────────────────────────────────────────

  if (method === "GET" && path === "/ui/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: status\ndata: ${JSON.stringify(ctx.getUiStatus())}\n\n`);
    ctx.sseClients.add(res);
    req.on("close", () => ctx.sseClients.delete(res));
    const interval = setInterval(() => {
      res.write(`event: status\ndata: ${JSON.stringify(ctx.getUiStatus())}\n\n`);
    }, 10_000);
    req.on("close", () => clearInterval(interval));
    return true;
  }

  // ── Send message ───────────────────────────────────────

  if (method === "POST" && path === "/ui/send") {
    handleSendMessage(req, res, ctx);
    return true;
  }

  // ── Instance operations ────────────────────────────────

  const stopMatch = path.match(/^\/ui\/stop\/(.+)$/);
  if (method === "POST" && stopMatch) {
    const name = decodeURIComponent(stopMatch[1]);
    if (!ctx.fleetConfig?.instances[name]) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    (async () => {
      try {
        await ctx.stopInstance(name);
        ctx.emitSseEvent("status", ctx.getUiStatus());
        json(res, 200, { stopped: name });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    })();
    return true;
  }

  const startMatch = path.match(/^\/ui\/start\/(.+)$/);
  if (method === "POST" && startMatch) {
    const name = decodeURIComponent(startMatch[1]);
    const config = ctx.fleetConfig?.instances[name];
    if (!config) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    const topicMode = ctx.fleetConfig?.channel?.mode === "topic";
    (async () => {
      try {
        await ctx.startInstance(name, config, topicMode ?? false);
        ctx.emitSseEvent("status", ctx.getUiStatus());
        json(res, 200, { started: name });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    })();
    return true;
  }

  const deleteMatch = path.match(/^\/ui\/instances\/(.+)\/delete$/);
  if (method === "POST" && deleteMatch) {
    const name = decodeURIComponent(deleteMatch[1]);
    if (!ctx.fleetConfig?.instances[name]) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    (async () => {
      try {
        const body = await parseBody(req);
        if (body.confirm !== `delete ${name}`) {
          json(res, 400, { error: `Confirmation required: { "confirm": "delete ${name}" }` });
          return;
        }
        await ctx.removeInstance(name);
        ctx.emitSseEvent("status", ctx.getUiStatus());
        json(res, 200, { deleted: name });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    })();
    return true;
  }

  // ── Instance detail ────────────────────────────────────

  const detailMatch = path.match(/^\/ui\/instance\/(.+)$/);
  if (method === "GET" && detailMatch) {
    const name = decodeURIComponent(detailMatch[1]);
    const config = ctx.fleetConfig?.instances[name];
    if (!config) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    const statusFile = join(ctx.getInstanceDir(name), "statusline.json");
    let statusline: Record<string, unknown> = {};
    try { statusline = JSON.parse(readFileSync(statusFile, "utf-8")); } catch { /* */ }

    const activity = ctx.eventLog?.listActivity({ since: new Date(Date.now() - 3600_000).toISOString(), limit: 50 }) ?? [];
    const instanceActivity = (activity as { sender?: string; receiver?: string }[]).filter(
      a => a.sender === name || a.receiver === name,
    );

    json(res, 200, {
      name,
      status: ctx.getInstanceStatus(name),
      description: config.description,
      display_name: config.display_name,
      working_directory: config.working_directory,
      statusline,
      recent_activity: instanceActivity.slice(0, 20),
    });
    return true;
  }

  // Not handled
  json(res, 404, { error: "not found" });
  return true;
}

/** Handle POST /ui/send — extracted for readability. */
function handleSendMessage(req: IncomingMessage, res: ServerResponse, ctx: WebApiContext): void {
  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", () => {
    try {
      const { instance, message } = JSON.parse(body) as { instance: string; message: string };
      const ipc = ctx.instanceIpcClients.get(instance);
      if (!ipc) {
        json(res, 404, { error: `Instance not found: ${instance}` });
        return;
      }
      const ts = new Date().toISOString();
      // Use real Telegram context so daemon's lastChatId/lastThreadId are set,
      // enabling reply tool even when first message comes from Web UI.
      // Pure Web UI mode (no channel config) leaves these empty — TODO: needs
      // a separate reply path for that case.
      const groupId = ctx.fleetConfig?.channel?.group_id;
      const topicId = ctx.fleetConfig?.instances[instance]?.topic_id;
      ipc.send({
        type: "fleet_inbound",
        content: message,
        targetSession: instance,
        meta: {
          chat_id: groupId ? String(groupId) : "",
          message_id: `web-${Date.now()}`,
          user: "web-user", user_id: "web-user",
          ts,
          thread_id: topicId != null ? String(topicId) : "",
          source: "web",
        },
      });
      ctx.lastInboundUser.set(instance, "web-user");
      ctx.eventLog?.logActivity("message", "web-user", message.slice(0, 200), instance);
      ctx.emitSseEvent("message", { instance, sender: "web-user", text: message, ts });
      // Sync to Telegram
      if (ctx.adapter && ctx.fleetConfig?.channel?.group_id) {
        const topicId = ctx.fleetConfig.instances[instance]?.topic_id;
        const preview = message.length > 500 ? message.slice(0, 500) + " [...]" : message;
        ctx.adapter.sendText(
          String(ctx.fleetConfig.channel.group_id),
          `🌐 web-user: ${preview}`,
          { threadId: topicId != null ? String(topicId) : undefined },
        ).catch(e => ctx.logger.debug({ err: e }, "Web→Telegram sync failed"));
      }
      json(res, 200, { sent: true });
    } catch {
      json(res, 400, { error: "Invalid JSON" });
    }
  });
}
