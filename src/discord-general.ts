/**
 * Discord general_channel_id location helper.
 *
 * The wizard wrote general_channel_id at the connection top level from c25045b0
 * until #1552 fixed it to write under channel.options.  Runtime code uses this
 * helper so that existing fleet.yaml files with the old top-level field keep
 * working; options is authoritative when both are present.
 */

/**
 * Return the Discord General channel id from a connection, or null.
 * Reads channel.options.general_channel_id first (canonical location),
 * falls back to the legacy top-level channel.general_channel_id for files
 * written by the wizard from c25045b0 until #1552.
 */
export function discordGeneralChannelId(ch: Record<string, unknown>): string | null {
  const fromOptions = (ch.options as Record<string, unknown> | undefined)?.general_channel_id;
  if (fromOptions != null && String(fromOptions)) return String(fromOptions);
  const legacy = ch.general_channel_id;
  if (legacy != null && String(legacy)) return String(legacy);
  return null;
}
