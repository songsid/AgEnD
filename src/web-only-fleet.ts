/**
 * #2910 (the user, 2026-11-01): a web-only fleet — no Discord or Telegram connection at all — is used from the web
 * dashboard. What "web-only" means, and the mode its agents run in, in one place.
 */
/** The two fields that decide it (a narrow shape: every config view in the code base has them, or neither). */
type ChannelShape = { channel?: { mode?: string } | null; channels?: ReadonlyArray<{ mode?: string }> | null };

/** No chat connection of any kind (no `channel`, no `channels`): the fleet is used from the web dashboard. */
export function isWebOnlyFleetConfig(cfg: ChannelShape | null | undefined): boolean {
  return cfg != null && !cfg.channel && !(cfg.channels?.length);
}

/**
 * Whether the fleet's agents run in topic mode — the mode in which they may message each other (send_to_instance,
 * delegate_task, report_result…): a topic-mode chat connection, or (#2910) a web-only fleet, whose agents are reached
 * from the dashboard instead of a topic. One answer for every start path (startup, restart, reload, the web's Start).
 */
export function daemonTopicMode(cfg: ChannelShape | null | undefined): boolean {
  return cfg?.channel?.mode === "topic" || !!cfg?.channels?.some(channel => channel.mode === "topic") || isWebOnlyFleetConfig(cfg);
}
