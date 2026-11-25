// AGEND-138 (PR #3553 review): the four roles a sign-in can have, and the session menu's "Manage devices" word — in a module of
// their own on purpose. The session menu (app-session.js, statically imported by the shell) and Settings → Devices read them; a
// tab that still holds the previous web-authorize.js / app-i18n.js must not be linked against a NEW named export or a missing
// key (an ESM `import { roleName }` from the old file is a SyntaxError that stops the whole shell). This file's URL is new, so
// no tab holds an older copy of it; web-authorize.js and app-i18n.js no longer carry these words (a key lives in one file).
// The pattern is settings-shared-strings.js / settings-access-strings.js (#3087, #3061).
import { register, t } from "./app-i18n.js";

register("webauth", {
  en: { role: "Role", roleOwner: "Owner ✓", roleAdminUnverified: "Admin · not verified", roleGuest: "Guest", roleGuestVerified: "Guest · Verified until {0}", roleRead: "Read-only" },
  "zh-TW": { role: "角色", roleOwner: "擁有者 ✓", roleAdminUnverified: "管理員 · 未驗證", roleGuest: "訪客", roleGuestVerified: "訪客 · 驗證有效至 {0}", roleRead: "唯讀" },
});
register("app", {
  en: { manageDevices: "Manage devices" },
  "zh-TW": { manageDevices: "管理裝置" },
});

/**
 * A sign-in's role as one of four words — the session menu's and Settings → Devices' alike. `tier` is the session's (admin /
 * read / guest); `verified`: its owner authorization is valid now (this computer's code sign-in or a chat account's confirm).
 * Only an admin can be an owner; an admin without that is "Admin · not verified". M-3651: a guest verified as its account
 * (its private code) is "Guest · Verified until …" when `until` (the time, as shown) is given — who it is, never an owner.
 */
export function roleName(tier, verified, until) {
  if (tier === "guest") return verified && until ? t("webauth.roleGuestVerified", until) : t("webauth.roleGuest");
  if (tier === "read") return t("webauth.roleRead");
  return verified ? t("webauth.roleOwner") : t("webauth.roleAdminUnverified");
}
