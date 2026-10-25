import type { FleetDefaults, WebConfig } from "./types.js";

/** A legacy "dm" (#2581) is still accepted as input and means true: notices are never sent by DM (hmsg-d1809f2a, hmsg-3b8ac2af). */
export type NoticeMode = boolean | "dm";
type NoticeConfig = { defaults: FleetDefaults; web?: WebConfig };
/** Sign-in notices post in the topic unless turned off; a legacy "dm" or `notice_delivery.login` route reads as on. */
export function loginNoticeMode(web?: WebConfig): boolean {
  return web?.notify_login !== false;
}
/** Daily tips always post in the General topic; an old "dm" reads as on. */
export function tipNoticeMode(config: NoticeConfig): boolean {
  return config.defaults.tips !== false;
}
/** Disk keeps only the boolean field; setting it clears the stale `notice_delivery` route #2591 stored beside it. */
export function setNoticeMode(config: NoticeConfig, kind: "login" | "tips", mode: NoticeMode): void {
  const web = config.web = { ...config.web };
  const delivery = { ...web.notice_delivery };
  delete delivery[kind];
  if (Object.keys(delivery).length) web.notice_delivery = delivery; else delete web.notice_delivery;
  if (kind === "login") web.notify_login = mode !== false; else config.defaults.tips = mode !== false;
}
/** Accept the short-lived #2581 string form and #2591's routes, but write back only booleans. */
export function normalizeNoticeDelivery(config: NoticeConfig): void {
  if (config.web?.notify_login === "dm" || config.web?.notice_delivery?.login) setNoticeMode(config, "login", config.web.notify_login !== false);
  if (config.defaults.tips === "dm" || config.web?.notice_delivery?.tips) setNoticeMode(config, "tips", config.defaults.tips !== false);
  // Even an empty `notice_delivery: {}` is dropped, or the startup migration would rewrite the file on every start.
  if (config.web && Object.hasOwn(config.web, "notice_delivery")) { config.web = { ...config.web }; delete config.web.notice_delivery; }
}
