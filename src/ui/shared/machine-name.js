// A paired computer's display name. A module of its own, imported by the sidebar (instance-nav.js) and by the lazy
// chat panel. A tab opened before an upgrade keeps the old shell, whose instance-nav.js has no `machineName`; the new
// chat panel imports it from here instead, a module that tab loads fresh, so Chat still opens (as #2978 did for
// settings-width.js). It registers its own words so it does not depend on the shell's older string tables.
import { register, t } from "./app-i18n.js";

register("machine", {
  "en": { "short": "Computer {value}" },
  "zh-TW": { "short": "電腦 {value}" },
});

/** A remote computer by its name; with no name yet, by the start of its id, never the whole id. The 8-character cut matches `shortId` in src/ui/settings-agent-filters.js; keep the two in step. */
export const machineName = (id, name) => name || t("machine.short").split("{value}").join(String(id).slice(0, 8));
