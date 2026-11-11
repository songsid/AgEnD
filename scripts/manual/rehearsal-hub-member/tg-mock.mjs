// e2e/mock-servers/telegram-mock.ts
import { createServer } from "node:http";
function createTelegramMock(opts = {}) {
  const port = opts.port ?? 8443;
  const botId = opts.botId ?? 123456789;
  const botUsername = opts.botUsername ?? "test_bot";
  let server;
  let calls = [];
  let pendingUpdates = [];
  let updateIdCounter = 1;
  let messageIdCounter = 1e3;
  let topicIdCounter = 100;
  const files = /* @__PURE__ */ new Map();
  let fileDownloads = [];
  let pollResolvers = [];
  // Like Telegram: an update stays until a later getUpdates acknowledges it (offset > its update_id), so a poll that
  // dies with its process (a restart) loses nothing — the next poller gets it again.
  let ackedBelow = 0;
  const unacked = () => pendingUpdates.filter((u) => u.update_id >= ackedBelow);
  function flushUpdates() {
    const ups = unacked();
    if (ups.length > 0 && pollResolvers.length > 0) {
      for (const resolver of pollResolvers.splice(0)) resolver(ups);
    }
  }
  function recordCall(method, params) {
    calls.push({ method, params, timestamp: Date.now() });
  }
  function nextMessageId() {
    return ++messageIdCounter;
  }
  async function parseBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("error", reject);
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve(JSON.parse(body));
        } catch {
          const params = {};
          for (const [k, v] of new URLSearchParams(body)) {
            params[k] = v;
          }
          resolve(params);
        }
      });
    });
  }
  function jsonResponse(res, data, ok = true) {
    const body = JSON.stringify({ ok, result: data });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  }
  async function handleBotApi(method, params, res) {
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
          supports_inline_queries: false
        });
        break;
      case "getUpdates": {
        if (params.offset != null) { ackedBelow = Math.max(ackedBelow, Number(params.offset)); pendingUpdates = pendingUpdates.filter((u) => u.update_id >= ackedBelow); }
        if (unacked().length > 0) {
          jsonResponse(res, unacked());
        } else {
          const timeoutSec = Number(params.timeout ?? 30);
          const timeout = Math.min(timeoutSec, 5) * 1e3;
          const timer = setTimeout(() => {
            pollResolvers = pollResolvers.filter((r) => r !== resolver);
            jsonResponse(res, []);
          }, timeout);
          const resolver = (updates) => {
            clearTimeout(timer);
            jsonResponse(res, updates);
          };
          pollResolvers.push(resolver);
        }
        break;
      }
      case "sendMessage": {
        const msgId = nextMessageId();
        calls[calls.length - 1].messageId = msgId;   // #3034 rig: a callback must name the message it was posted as
        jsonResponse(res, {
          message_id: msgId,
          from: { id: botId, is_bot: true, first_name: "Test Bot", username: botUsername },
          chat: { id: Number(params.chat_id), type: "supergroup" },
          date: Math.floor(Date.now() / 1e3),
          text: params.text,
          message_thread_id: params.message_thread_id
        });
        break;
      }
      case "editMessageText":
        jsonResponse(res, {
          message_id: Number(params.message_id),
          from: { id: botId, is_bot: true },
          chat: { id: Number(params.chat_id), type: "supergroup" },
          date: Math.floor(Date.now() / 1e3),
          text: params.text
        });
        break;
      case "editMessageReplyMarkup":
        jsonResponse(res, {
          message_id: Number(params.message_id),
          from: { id: botId, is_bot: true },
          chat: { id: Number(params.chat_id), type: "supergroup" },
          date: Math.floor(Date.now() / 1e3)
        });
        break;
      case "sendPhoto":
      case "sendDocument": {
        const msgId = nextMessageId();
        jsonResponse(res, {
          message_id: msgId,
          from: { id: botId, is_bot: true },
          chat: { id: Number(params.chat_id), type: "supergroup" },
          date: Math.floor(Date.now() / 1e3),
          message_thread_id: params.message_thread_id
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
        if (registered && registered.filePath === void 0) {
          jsonResponse(res, { file_id: params.file_id, file_unique_id: `unique_${params.file_id}`, file_size: registered.body.length });
          break;
        }
        jsonResponse(res, {
          file_id: params.file_id,
          file_unique_id: `unique_${params.file_id}`,
          file_size: registered?.body.length ?? 1024,
          file_path: registered?.filePath ?? `photos/file_${params.file_id}.jpg`
        });
        break;
      }
      case "createForumTopic": {
        const topicId = ++topicIdCounter;
        jsonResponse(res, {
          message_thread_id: topicId,
          name: params.name,
          icon_color: 7322096
        });
        break;
      }
      case "deleteForumTopic":
        // #3054 rig: thread 403 = a bot without the Manage Topics admin right, as Telegram answers it.
        if (Number(params.message_thread_id) === 403) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: not enough rights to manage topics" }));
        } else jsonResponse(res, true);
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
      case "deleteWebhook": {
        const drop = params.drop_pending_updates === true || params.drop_pending_updates === "true"
          || params.drop_pending_updates === 1 || params.drop_pending_updates === "1";
        if (drop) {
          pendingUpdates = [];
          ackedBelow = 0;
          for (const resolver of pollResolvers.splice(0)) resolver([]);
        }
        jsonResponse(res, true);
        break;
      }
      default:
        jsonResponse(res, true);
        break;
    }
  }
  async function handleControlApi(path, req, res) {
    if (path === "/control/send-message" && req.method === "POST") {
      const body = await parseBody(req);
      injectMessage({
        text: String(body.text ?? ""),
        chatId: Number(body.chat_id ?? -1001234567890),
        userId: Number(body.user_id ?? 111222333),
        username: body.username,
        threadId: body.thread_id != null ? Number(body.thread_id) : void 0,
        replyToMessageId: body.reply_to_message_id != null ? Number(body.reply_to_message_id) : void 0,
        replyToText: body.reply_to_text
      });
      jsonResponse(res, { injected: true });
    } else if (path === "/control/inject-callback" && req.method === "POST") {
      const body = await parseBody(req);
      injectCallbackQuery({
        data: String(body.data),
        chatId: Number(body.chat_id ?? -1001234567890),
        messageId: Number(body.message_id ?? 1),
        threadId: body.thread_id != null ? Number(body.thread_id) : void 0
      });
      jsonResponse(res, { injected: true });
    } else if (path === "/control/calls" && req.method === "GET") {
      jsonResponse(res, calls);
    } else if (path.startsWith("/control/calls/") && req.method === "GET") {
      const method = path.split("/control/calls/")[1];
      jsonResponse(res, calls.filter((c) => c.method === method));
    } else if (path === "/control/reset" && req.method === "POST") {
      reset();
      jsonResponse(res, { reset: true });
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  }
  function injectMessage(opts2) {
    const update = {
      update_id: updateIdCounter++,
      message: {
        message_id: nextMessageId(),
        from: {
          id: opts2.userId,
          is_bot: false,
          first_name: opts2.username ?? "TestUser",
          username: opts2.username ?? "testuser"
        },
        chat: {
          id: opts2.chatId,
          type: "supergroup",
          title: "Test Group"
        },
        date: Math.floor(Date.now() / 1e3),
        ...opts2.photo || opts2.document ? { caption: opts2.text } : { text: opts2.text },
        ...opts2.photo ? {
          photo: opts2.photo.map((p, i) => ({ file_id: p.fileId, file_unique_id: `unique_${p.fileId}`, width: 100 * (i + 1), height: 100 * (i + 1), ...p.size != null ? { file_size: p.size } : {} }))
        } : {},
        ...opts2.document ? {
          document: {
            file_id: opts2.document.fileId,
            file_unique_id: `unique_${opts2.document.fileId}`,
            ...opts2.document.fileName ? { file_name: opts2.document.fileName } : {},
            ...opts2.document.mimeType ? { mime_type: opts2.document.mimeType } : {},
            ...opts2.document.size != null ? { file_size: opts2.document.size } : {}
          }
        } : {},
        ...opts2.threadId != null ? { message_thread_id: opts2.threadId } : {},
        ...opts2.replyToMessageId != null ? {
          reply_to_message: {
            message_id: opts2.replyToMessageId,
            chat: { id: opts2.chatId, type: "supergroup" },
            date: Math.floor(Date.now() / 1e3),
            text: opts2.replyToText ?? ""
          }
        } : {}
      }
    };
    pendingUpdates.push(update);
    flushUpdates();
  }
  function injectCallbackQuery(opts2) {
    const update = {
      update_id: updateIdCounter++,
      callback_query: {
        id: String(Date.now()),
        from: { id: opts2.userId ?? 111222333, is_bot: false, first_name: opts2.username ?? "TestUser", username: opts2.username ?? "testuser" },
        message: {
          message_id: opts2.messageId,
          chat: { id: opts2.chatId, type: "supergroup" },
          date: Math.floor(Date.now() / 1e3),
          ...opts2.threadId != null ? { message_thread_id: opts2.threadId } : {}
        },
        data: opts2.data
      }
    };
    pendingUpdates.push(update);
    flushUpdates();
  }
  function reset() {
    calls = [];
    pendingUpdates = [];
    pollResolvers.forEach((r) => r([]));
    pollResolvers = [];
    files.clear();
    fileDownloads = [];
  }
  return {
    port,
    async start() {
      return new Promise((resolve) => {
        server = createServer(async (req, res) => {
          try {
            const url = new URL(req.url ?? "/", `http://localhost:${port}`);
            const path = url.pathname;
            if (path.startsWith("/control/")) {
              await handleControlApi(path, req, res);
              return;
            }
            if (path.startsWith("/file/bot")) {
              const filePath = path.replace(/^\/file\/bot[^/]+\//, "");
              fileDownloads.push(filePath);
              const served = [...files.values()].find((f) => f.filePath === filePath);
              if (served) {
                res.writeHead(served.status, { "Content-Type": served.contentType });
                res.end(served.status === 200 ? served.body : "");
                return;
              }
              res.writeHead(200, { "Content-Type": "image/jpeg" });
              res.end(Buffer.from("fake-image-data"));
              return;
            }
            const botMatch = path.match(/^\/bot[^/]+\/(\w+)$/);
            if (botMatch) {
              const method = botMatch[1];
              const params = req.method === "GET" ? Object.fromEntries(url.searchParams) : await parseBody(req);
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
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
    injectMessage,
    registerFile(file) {
      files.set(file.fileId, {
        filePath: file.filePath,
        body: Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body ?? "fake-image-data"),
        contentType: file.contentType ?? "application/octet-stream",
        status: file.status ?? 200
      });
    },
    getFileDownloads: () => [...fileDownloads],
    injectCallbackQuery,
    getCalls: () => [...calls],
    getCallsFor: (method) => calls.filter((c) => c.method === method),
    reset
  };
}

// ../../.cache/agend-rh-b16/tg-entry.ts
var m = createTelegramMock({ port: Number(process.env.TG_PORT ?? 18443) });
await m.start();
console.log("tg-mock up");
