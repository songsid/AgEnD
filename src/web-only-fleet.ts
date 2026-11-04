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

/**
 * #3008 G1: the agents that are the General — `general_topic` on the agent, or (not set there) in the defaults. On a
 * fleet with no chat connection there may be one (the agent its owner ticked), never two.
 */
export function generalNames(cfg: { defaults?: { general_topic?: unknown } | null; instances?: Record<string, { general_topic?: unknown } | null | undefined> | null } | null | undefined): string[] {
  const fallback = cfg?.defaults?.general_topic === true;
  return Object.entries(cfg?.instances ?? {})
    .filter(([, inst]) => inst?.general_topic === true || (inst?.general_topic === undefined && fallback)).map(([name]) => name);
}
