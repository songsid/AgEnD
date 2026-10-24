import type { FleetDefaults, WebConfig } from "./types.js";

export type NoticeMode = boolean | "dm";
type NoticeConfig = { defaults: FleetDefaults; web?: WebConfig };
/** Old versions see ordinary enabled notices; only new versions interpret the routing preference. */
export const NEW_FLEET_WEB: Readonly<Pick<WebConfig, "notify_login" | "notice_delivery">> = Object.freeze({
  notify_login: true, notice_delivery: Object.freeze({ login: "dm" as const }),
});
export function loginNoticeMode(web?: WebConfig): NoticeMode {
  const enabled = web?.notify_login ?? true;
  return enabled === true && web?.notice_delivery?.login === "dm" ? "dm" : enabled;
}
export function tipNoticeMode(config: NoticeConfig): NoticeMode {
  const enabled = config.defaults.tips ?? true;
  return enabled === true && config.web?.notice_delivery?.tips === "dm" ? "dm" : enabled;
}
/** API choices remain three-way; disk always uses boolean legacy fields plus an optional, ignored routing key. */
export function setNoticeMode(config: NoticeConfig, kind: "login" | "tips", mode: NoticeMode): void {
  const web = config.web = { ...config.web };
  const delivery = { ...web.notice_delivery };
  if (mode === "dm") delivery[kind] = "dm"; else delete delivery[kind];
  if (Object.keys(delivery).length) web.notice_delivery = delivery; else delete web.notice_delivery;
  if (kind === "login") web.notify_login = mode !== false; else config.defaults.tips = mode !== false;
}
/** Accept the short-lived #2581 string form, but never write it back to either legacy boolean key. */
export function normalizeNoticeDelivery(config: NoticeConfig): void {
  if (config.web?.notify_login === "dm") setNoticeMode(config, "login", "dm");
  if (config.defaults.tips === "dm") setNoticeMode(config, "tips", "dm");
}
