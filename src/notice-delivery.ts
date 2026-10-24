import type { WebConfig } from "./types.js";

/** Written only when creating a fleet; never materialize this default in an existing file. */
export const NEW_FLEET_WEB: Readonly<Pick<WebConfig, "notify_login">> = Object.freeze({ notify_login: "dm" });
