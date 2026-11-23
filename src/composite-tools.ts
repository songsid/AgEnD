/**
 * M-2133: which tools are listed as one composite (`action` + `args`), and the names a provider may call. Kept free of
 * imports: the native MCP helper (windows-native-mcp.ts) runs it beside the CLI.
 *
 * A launch's tool ceiling stays the member names. The names a provider sees and may call are that ceiling plus each
 * composite with at least one member in it — a composite call is expanded to its member before any check, so naming it
 * never reaches a tool outside the ceiling.
 */
export const COMPOSITE_ACTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  web_appearance: Object.freeze({
    get: "get_web_appearance", get_theme: "get_web_theme", preview: "preview_web_appearance",
    set_theme: "set_web_theme", set_theme_asset: "set_web_theme_asset", reset_theme: "reset_web_theme",
    set_widget: "set_web_widget", remove_widget: "remove_web_widget",
    set_ambient: "set_web_ambient", clear_ambient: "clear_web_ambient",
  }),
  emoji_sticker: Object.freeze({
    list_emojis: "list_emojis", preview_emojis: "preview_emojis", set_persona_emoji: "set_persona_emoji",
    list_stickers: "list_stickers", preview_stickers: "preview_stickers",
  }),
});

/** The ceiling's names plus every composite one of whose members is in it (members first, in their order). */
export function facingToolNames(members: readonly string[]): string[] {
  const present = new Set(members);
  const composites = Object.entries(COMPOSITE_ACTIONS)
    .filter(([name, actions]) => !present.has(name) && Object.values(actions).some(member => present.has(member)))
    .map(([name]) => name);
  return [...members, ...composites];
}
