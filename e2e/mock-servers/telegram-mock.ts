/**
 * Mock Telegram Bot API server for E2E testing.
 *
 * Mimics the Telegram Bot API endpoints that grammy calls.
 * Provides a control API for tests to inject messages and inspect call logs.
 *
 * Usage:
 *   const mock = createTelegramMock({ port: 8443 });
 *   await mock.start();
 *   // ... run tests ...
 *   await mock.stop();
 *
 * Control API (same port, /control/ prefix):
 *   POST /control/send-message   — inject an inbound message (simulates user sending)
 *   GET  /control/calls           — get all API call logs
 *   GET  /control/calls/:method   — get calls for a specific method
 *   POST /control/reset           — clear all state
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface TelegramMockOptions {
  port?: number;
  botId?: number;
  botUsername?: string;
}

export interface ApiCall {
  method: string;
  params: Record<string, unknown>;
  timestamp: number;
}

export interface PendingUpdate {
  update_id: number;
  message?: Record<string, unknown>;
  callback_query?: Record<string, unknown>;
}

export interface TelegramMock {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Inject a message as if a user sent it to the bot */
  injectMessage(opts: {
    text: string;
    chatId: number;
    userId: number;
    username?: string;
    threadId?: number;
    replyToMessageId?: number;
    replyToText?: string;
    /** Attach a photo (Telegram sends several sizes; the last is the largest). */
    photo?: Array<{ fileId: string; size?: number }>;
    /** Attach a document. */
    document?: { fileId: string; fileName?: string; mimeType?: string; size?: number };
  }): void;
  /**
   * Make a file id downloadable: `getFile` answers with `filePath`, and `/file/bot<token>/<filePath>` serves
   * `body` with `contentType` (or fails with `status`). An unregistered id keeps the old behaviour: a fake jpeg.
   */
  registerFile(file: { fileId: string; filePath?: string; body?: Buffer | string; contentType?: string; status?: number }): void;
  /** Paths requested from the file endpoint, in order. */
  getFileDownloads(): string[];
  /** Inject a callback query (inline button press) */
  injectCallbackQuery(opts: {
    data: string;
    chatId: number;
    messageId: number;
    threadId?: number;
    userId?: number;
    username?: string;
  }): void;
  /** Get all recorded API calls */
  getCalls(): ApiCall[];
  /** Get calls for a specific method */
  getCallsFor(method: string): ApiCall[];
  /** Clear all state */
  reset(): void;
  /** Get the port the server is listening on */
  readonly port: number;
}

export function createTelegramMock(opts: TelegramMockOptions = {}): TelegramMock {
  const port = opts.port ?? 8443;
  const botId = opts.botId ?? 123456789;
  const botUsername = opts.botUsername ?? "test_bot";

  let server: Server;
  let calls: ApiCall[] = [];
  let pendingUpdates: PendingUpdate[] = [];
  let updateIdCounter = 1;
  let messageIdCounter = 1000;
  let topicIdCounter = 100;
  const files = new Map<string, { filePath?: string; body: Buffer; contentType: string; status: number }>();
  let fileDownloads: string[] = [];

  // Pending long-poll resolvers — grammy uses getUpdates with long polling
  let pollResolvers: Array<(updates: PendingUpdate[]) => void> = [];

  function flushUpdates(): void {
    if (pendingUpdates.length > 0 && pollResolvers.length > 0) {
      const resolver = pollResolvers.shift()!;
      const updates = [...pendingUpdates];
      pendingUpdates = [];
      resolver(updates);
    }
  }

  function recordCall(method: string, params: Record<string, unknown>): void {
    calls.push({ method, params, timestamp: Date.now() });
  }

  function nextMessageId(): number {
    return ++messageIdCounter;
  }

  // Parse request body (JSON or multipart form data for file uploads)
  async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("error", reject);
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve(JSON.parse(body));
        } catch {
          // Try URL-encoded
          const params: Record<string, unknown> = {};
          for (const [k, v] of new URLSearchParams(body)) {
            params[k] = v;
          }
          resolve(params);
        }
      });
    });
  }

  function jsonResponse(res: ServerResponse, data: unknown, ok = true): void {
    const body = JSON.stringify({ ok, result: data });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  }

  // Route: /bot<token>/<method>
  async function handleBotApi(method: string, params: Record<string, unknown>, res: ServerResponse): Promise<void> {
    recordCall(method, params);

    switch (method) {
      case "getMe":
        jsonResponse(res, {
          id: botId,
          is_bot: true,
          first_name: "Test Bot",
          username: botUsername,
          can_join_groups: true,
          can_read_all_group_messages: true,
          supports_inline_queries: false,
        });
        break;

      case "getUpdates": {
        // Long polling: if we have pending updates, return immediately.
        // Otherwise, wait up to timeout seconds.
        if (pendingUpdates.length > 0) {
          const updates = [...pendingUpdates];
          pendingUpdates = [];
          jsonResponse(res, updates);
        } else {
          const timeoutSec = Number(params.timeout ?? 30);
          const timeout = Math.min(timeoutSec, 5) * 1000; // Cap at 5s for tests
          const timer = setTimeout(() => {
            // Remove this resolver and return empty
            pollResolvers = pollResolvers.filter(r => r !== resolver);
            jsonResponse(res, []);
          }, timeout);

          const resolver = (updates: PendingUpdate[]) => {
            clearTimeout(timer);
            jsonResponse(res, updates);
          };
          pollResolvers.push(resolver);
        }
        break;
      }

      case "sendMessage": {
        const msgId = nextMessageId();
        jsonResponse(res, {
          message_id: msgId,
          from: { id: botId, is_bot: true, first_name: "Test Bot", username: botUsername },
          chat: { id: Number(params.chat_id), type: "supergroup" },
          date: Math.floor(Date.now() / 1000),
          text: params.text,
          message_thread_id: params.message_thread_id,
        });
        break;
      }

      case "editMessageText":
        jsonResponse(res, {
          message_id: Number(params.message_id),
          from: { id: botId, is_bot: true },
          chat: { id: Number(params.chat_id), type: "supergroup" },
          date: Math.floor(Date.now() / 1000),
          text: params.text,
        });
        break;

      case "editMessageReplyMarkup":
        jsonResponse(res, {
          message_id: Number(params.message_id),
          from: { id: botId, is_bot: true },
          chat: { id: Number(params.chat_id), type: "supergroup" },
          date: Math.floor(Date.now() / 1000),
        });
        break;

      case "sendPhoto":
      case "sendDocument": {
        const msgId = nextMessageId();
        jsonResponse(res, {
          message_id: msgId,
          from: { id: botId, is_bot: true },
          chat: { id: Number(params.chat_id), type: "supergroup" },
          date: Math.floor(Date.now() / 1000),
          message_thread_id: params.message_thread_id,
        });
        break;
      }

      case "setMessageReaction":
        jsonResponse(res, true);
        break;

      case "deleteMessage":
        jsonResponse(res, true);
        break;

      case "getFile": {
        const registered = files.get(String(params.file_id));
        if (registered && registered.filePath === undefined) {
          jsonResponse(res, { file_id: params.file_id, file_unique_id: `unique_${params.file_id}`, file_size: registered.body.length });
          break;
        }
        jsonResponse(res, {
          file_id: params.file_id,
          file_unique_id: `unique_${params.file_id}`,
          file_size: registered?.body.length ?? 1024,
          file_path: registered?.filePath ?? `photos/file_${params.file_id}.jpg`,
        });
        break;
      }

      case "createForumTopic": {
        const topicId = ++topicIdCounter;
        jsonResponse(res, {
          message_thread_id: topicId,
          name: params.name,
          icon_color: 7322096,
        });
        break;
      }

      case "deleteForumTopic":
        jsonResponse(res, true);
        break;

      case "closeForumTopic":
        jsonResponse(res, true);
        break;

      case "reopenForumTopic":
        jsonResponse(res, true);
        break;

      case "editForumTopic":
        jsonResponse(res, true);
        break;

      case "getForumTopicIconStickers":
        jsonResponse(res, []);
        break;

      case "answerCallbackQuery":
        jsonResponse(res, true);
        break;

      case "setMyCommands":
        jsonResponse(res, true);
        break;

      default:
        // Unknown method — return ok:true with empty result (safe default)
        jsonResponse(res, true);
        break;
    }
  }

  // Handle control API for test injection
  async function handleControlApi(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (path === "/control/send-message" && req.method === "POST") {
      const body = await parseBody(req);
      injectMessage({
        text: String(body.text ?? ""),
        chatId: Number(body.chat_id ?? -1001234567890),
        userId: Number(body.user_id ?? 111222333),
        username: body.username as string | undefined,
        threadId: body.thread_id != null ? Number(body.thread_id) : undefined,
        replyToMessageId: body.reply_to_message_id != null ? Number(body.reply_to_message_id) : undefined,
        replyToText: body.reply_to_text as string | undefined,
      });
      jsonResponse(res, { injected: true });
    } else if (path === "/control/inject-callback" && req.method === "POST") {
      const body = await parseBody(req);
      injectCallbackQuery({
        data: String(body.data),
        chatId: Number(body.chat_id ?? -1001234567890),
        messageId: Number(body.message_id ?? 1),
        threadId: body.thread_id != null ? Number(body.thread_id) : undefined,
      });
      jsonResponse(res, { injected: true });
    } else if (path === "/control/calls" && req.method === "GET") {
      jsonResponse(res, calls);
    } else if (path.startsWith("/control/calls/") && req.method === "GET") {
      const method = path.split("/control/calls/")[1];
      jsonResponse(res, calls.filter(c => c.method === method));
    } else if (path === "/control/reset" && req.method === "POST") {
      reset();
      jsonResponse(res, { reset: true });
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  }

  function injectMessage(opts: {
    text: string;
    chatId: number;
    userId: number;
    username?: string;
    threadId?: number;
    replyToMessageId?: number;
    replyToText?: string;
    photo?: Array<{ fileId: string; size?: number }>;
    document?: { fileId: string; fileName?: string; mimeType?: string; size?: number };
  }): void {
    const update: PendingUpdate = {
      update_id: updateIdCounter++,
      message: {
        message_id: nextMessageId(),
        from: {
          id: opts.userId,
          is_bot: false,
          first_name: opts.username ?? "TestUser",
          username: opts.username ?? "testuser",
        },
        chat: {
          id: opts.chatId,
          type: "supergroup",
          title: "Test Group",
        },
        date: Math.floor(Date.now() / 1000),
        ...(opts.photo || opts.document ? { caption: opts.text } : { text: opts.text }),
        ...(opts.photo ? {
          photo: opts.photo.map((p, i) => ({ file_id: p.fileId, file_unique_id: `unique_${p.fileId}`, width: 100 * (i + 1), height: 100 * (i + 1), ...(p.size != null ? { file_size: p.size } : {}) })),
        } : {}),
        ...(opts.document ? {
          document: {
            file_id: opts.document.fileId, file_unique_id: `unique_${opts.document.fileId}`,
            ...(opts.document.fileName ? { file_name: opts.document.fileName } : {}),
            ...(opts.document.mimeType ? { mime_type: opts.document.mimeType } : {}),
            ...(opts.document.size != null ? { file_size: opts.document.size } : {}),
          },
        } : {}),
        ...(opts.threadId != null ? { message_thread_id: opts.threadId } : {}),
        ...(opts.replyToMessageId != null ? {
          reply_to_message: {
            message_id: opts.replyToMessageId,
            chat: { id: opts.chatId, type: "supergroup" },
            date: Math.floor(Date.now() / 1000),
            text: opts.replyToText ?? "",
          },
        } : {}),
      },
    };
    pendingUpdates.push(update);
    flushUpdates();
  }

  function injectCallbackQuery(opts: {
    data: string;
    chatId: number;
    messageId: number;
    threadId?: number;
    userId?: number;
    username?: string;
  }): void {
    const update: PendingUpdate = {
      update_id: updateIdCounter++,
      callback_query: {
        id: String(Date.now()),
        from: { id: opts.userId ?? 111222333, is_bot: false, first_name: opts.username ?? "TestUser", username: opts.username ?? "testuser" },
        message: {
          message_id: opts.messageId,
          chat: { id: opts.chatId, type: "supergroup" },
          date: Math.floor(Date.now() / 1000),
          ...(opts.threadId != null ? { message_thread_id: opts.threadId } : {}),
        },
        data: opts.data,
      },
    };
    pendingUpdates.push(update);
    flushUpdates();
  }

  function reset(): void {
    calls = [];
    pendingUpdates = [];
    pollResolvers.forEach(r => r([]));
    pollResolvers = [];
    files.clear();
    fileDownloads = [];
  }

  return {
    port,

    async start() {
      return new Promise<void>((resolve) => {
        server = createServer(async (req, res) => {
          try {
            const url = new URL(req.url ?? "/", `http://localhost:${port}`);
            const path = url.pathname;

            // Control API
            if (path.startsWith("/control/")) {
              await handleControlApi(path, req, res);
              return;
            }

            // File download: /file/bot<token>/<path>
            if (path.startsWith("/file/bot")) {
              const filePath = path.replace(/^\/file\/bot[^/]+\//, "");
              fileDownloads.push(filePath);
              const served = [...files.values()].find(f => f.filePath === filePath);
              if (served) {
                res.writeHead(served.status, { "Content-Type": served.contentType });
                res.end(served.status === 200 ? served.body : "");
                return;
              }
              res.writeHead(200, { "Content-Type": "image/jpeg" });
              res.end(Buffer.from("fake-image-data"));
              return;
            }

            // Bot API: /bot<token>/<method>
            const botMatch = path.match(/^\/bot[^/]+\/(\w+)$/);
            if (botMatch) {
              const method = botMatch[1];
              const params = req.method === "GET"
                ? Object.fromEntries(url.searchParams)
                : await parseBody(req);
              await handleBotApi(method, params, res);
              return;
            }

            res.writeHead(404);
            res.end("Not found");
          } catch (err) {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: String(err) }));
            }
          }
        });

        server.listen(port, "0.0.0.0", () => {
          resolve();
        });
      });
    },

    async stop() {
      reset();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },

    injectMessage,
    registerFile(file) {
      files.set(file.fileId, {
        filePath: file.filePath,
        body: Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body ?? "fake-image-data"),
        contentType: file.contentType ?? "application/octet-stream",
        status: file.status ?? 200,
      });
    },
    getFileDownloads: () => [...fileDownloads],
    injectCallbackQuery,
    getCalls: () => [...calls],
    getCallsFor: (method: string) => calls.filter(c => c.method === method),
    reset,
  };
}
