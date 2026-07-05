import { resolve, sep, join } from "node:path";
import { realpathSync, existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { ChannelAdapter } from "./types.js";
import { getAgendHome } from "../paths.js";
import { validateFleetConfig, validateClassicBotConfig } from "../config-validator.js";

const STATE_DIR = resolve(getAgendHome()) + sep;
const INBOX_SEG = sep + "inbox" + sep;

/** Block files inside the state dir (except inbox/) from being sent out. */
function assertSendable(filePath: string): void {
  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    if (!existsSync(filePath)) return; // truly missing — let adapter handle
    throw new Error(`Blocked: cannot resolve path ${filePath}`);
  }
  if (resolved.startsWith(STATE_DIR) && !resolved.includes(INBOX_SEG)) {
    throw new Error(`Blocked: refusing to send state file ${filePath}`);
  }
}

/**
 * Route a channel tool call (reply, react, edit_message, download_attachment)
 * to the adapter. Returns true if handled, false if unknown tool.
 */
export function routeToolCall(
  adapter: ChannelAdapter,
  tool: string,
  args: Record<string, unknown>,
  threadId: string | undefined,
  respond: (result: unknown, error?: string) => void,
): boolean {
  const chatId = args.chat_id as string ?? "";

  switch (tool) {
    case "reply": {
      const files = Array.isArray(args.files) ? args.files as string[] : [];
      if (files.length > 20) {
        respond(null, `reply: too many files (${files.length}); max 20 per message`);
        return true;
      }
      try {
        for (const f of files) assertSendable(f);
      } catch (e: any) {
        respond(null, e.message);
        return true;
      }
      const replyThreadId = args.thread_id as string ?? threadId;
      const format = args.format === "markdown" ? "html" as const : undefined;
      adapter.sendText(chatId, args.text as string ?? "", {
        threadId: replyThreadId,
        replyTo: args.reply_to as string,
        format,
      }).then(async (sent) => {
        for (const filePath of files) {
          await adapter.sendFile(chatId, filePath, { threadId: replyThreadId });
        }
        respond(sent);
      }).catch(e => respond(null, e.message));
      return true;
    }
    case "react":
      // Pass threadId so Discord reacts in the topic thread (a message there
      // lives in the thread's own channel, not chatId). Telegram ignores it.
      adapter.react(chatId, args.message_id as string ?? "", args.emoji as string ?? "", args.thread_id as string ?? threadId)
        .then(() => respond("ok"))
        .catch(e => respond(null, e.message));
      return true;
    case "edit_message":
      adapter.editMessage(chatId, args.message_id as string ?? "", args.text as string ?? "", threadId)
        .then(() => respond("ok"))
        .catch(e => respond(null, e.message));
      return true;
    case "download_attachment":
      adapter.downloadAttachment(args.file_id as string ?? "")
        .then(path => respond(path))
        .catch(e => respond(null, e.message));
      return true;
    case "validate_config": {
      // Stateless — reads the on-disk config; no adapter needed. Any instance
      // (incl. general) can call it to lint fleet.yaml + classicBot.yaml.
      const home = getAgendHome();
      const loadYaml = (p: string): unknown => {
        if (!existsSync(p)) return undefined;
        try { return yaml.load(readFileSync(p, "utf-8")); }
        catch (e) { return { __parseError: (e as Error).message }; }
      };
      const fleetRaw = loadYaml(join(home, "fleet.yaml"));
      const classicRaw = loadYaml(join(home, "classicBot.yaml"));
      const fleet = (fleetRaw && typeof fleetRaw === "object" && "__parseError" in fleetRaw)
        ? { valid: false, errors: [{ path: "fleet.yaml", message: `YAML parse error: ${(fleetRaw as { __parseError: string }).__parseError}` }], warnings: [] }
        : validateFleetConfig(fleetRaw ?? {});
      const classic = (classicRaw && typeof classicRaw === "object" && "__parseError" in classicRaw)
        ? { valid: false, errors: [{ path: "classicBot.yaml", message: `YAML parse error: ${(classicRaw as { __parseError: string }).__parseError}` }], warnings: [] }
        : validateClassicBotConfig(classicRaw);
      respond({ fleet, classic });
      return true;
    }
    default:
      return false;
  }
}
