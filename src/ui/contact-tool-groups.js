// M-3387 (the user, beta.14): switching a ClassicBot room to restricted mode listed ~50 raw AgEnD tool names
// (hub_room_list, get_fleet_status, set_web_theme_asset, office_pack_upload…) as what would stop. They are now said as a
// few kinds, with counts, and the names behind a "show all".
//
// Two layers stop: AgEnD's own tools (every MCP tool outside the restricted ceiling, CLASSIC_RESTRICTED_TOOLS) are taken
// away by the switch itself; the CLI's own tools (its shell, files, web — the backend's names, e.g. Bash) stop only where
// the command-line guard covers the room. A name in TOOL_GROUPS is AgEnD's; any other name in wouldDisable is the CLI's.
// tests/contact-tool-groups-m3387.test.ts pins that every AgEnD MCP tool (src/channel/mcp-tools.ts) outside the ceiling is
// in exactly one group, so a new tool can't be added without being put in one.

/** The kinds of AgEnD tools a restricted room loses, in the order they are shown; each tool in exactly one. */
export const TOOL_GROUPS = Object.freeze([
  { id: "fleet", tools: ["get_fleet_status", "get_fleet_config", "validate_config", "get_effort", "list_models", "kiro_engine_status",
    "update_instance_config", "update_fleet_defaults", "migrate_kiro_instance", "reconcile_kiro_instance", "get_web_settings", "set_web_settings", "propose_contact_change", "contact_state"] },
  { id: "agents", tools: ["create_instance", "delete_instance", "replace_instance", "start_instance", "stop_instance", "restart_instance",
    "pause_instance", "wake_instance", "create_team", "update_team", "delete_team"] },
  { id: "usage", tools: ["get_usage", "get_usage_report", "get_cache_report", "get_instance_logs"] },
  { id: "schedules", tools: ["create_schedule", "list_schedules", "update_schedule", "delete_schedule"] },
  { id: "tasks", tools: ["task", "post_decision", "list_decisions", "update_decision"] },
  { id: "look", tools: ["set_display_name", "set_description", "set_persona_emoji", "list_emojis", "preview_emojis", "list_stickers",
    "preview_stickers", "get_web_theme", "set_web_theme", "set_web_theme_asset", "reset_web_theme", "get_web_appearance",
    "preview_web_appearance", "set_web_widget", "remove_web_widget", "set_web_ambient", "clear_web_ambient", "office_view", "office_set",
    "office_set_style", "office_pack_check", "office_pack_list", "office_pack_upload", "office_pack_delete", "office_pack_restore"] },
  { id: "repos", tools: ["checkout_repo", "release_repo", "deploy_template", "teardown_deployment", "list_deployments"] },
  { id: "hub", tools: ["hub_room_list", "hub_room_post", "hub_room_members", "hub_people_search", "hub_set_intro"] },
].map((g) => Object.freeze({ id: g.id, tools: Object.freeze(g.tools) })));

const GROUP_OF = new Map(TOOL_GROUPS.flatMap((g) => g.tools.map((tool) => [tool, g.id])));

/**
 * `names` (a room's wouldDisable) split by layer: AgEnD's tools by kind (shown order; kinds with none left out) and the
 * CLI's own tools (any other name), each list sorted, nothing twice.
 */
export function groupWouldDisable(names) {
  const unique = [...new Set((names || []).map(String))];
  const groups = TOOL_GROUPS.map((g) => ({ id: g.id, tools: unique.filter((n) => GROUP_OF.get(n) === g.id).sort() })).filter((g) => g.tools.length);
  const cli = unique.filter((n) => !GROUP_OF.has(n)).sort();
  return { groups, cli, agendCount: groups.reduce((sum, g) => sum + g.tools.length, 0) };
}
