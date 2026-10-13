import { GrammyError } from "grammy";
import { DiscordAPIError } from "discord.js";

/** Telegram's explicit unchanged-content refusal confirms the requested edit is already present. */
export function isTelegramEditNotModified(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 400
    && typeof err.description === "string"
    && /^Bad Request: message is not modified(?::|$)/.test(err.description);
}

/** Provider evidence that an existing message/destination or its edit permission is unavailable.
 * Network uncertainty, invalid content, rate limits and server errors never authorize a replacement post. */
export function isMessageEditLoss(err: unknown): boolean {
  if (err instanceof GrammyError) {
    if (typeof err.description !== "string") return false;
    if (err.error_code === 403 && err.description.startsWith("Forbidden:")) return true;
    return err.error_code === 400 && /^Bad Request: (?:message to edit not found|chat not found|message thread not found|TOPIC_ID_INVALID|not enough rights to (?:edit|send) (?:text )?messages)(?:$|[.:])/.test(err.description);
  }
  return err instanceof DiscordAPIError
    && typeof err.code === "number"
    && ((err.status === 404 && [10003, 10008].includes(err.code))
      || (err.status === 403 && [50001, 50013].includes(err.code)));
}
