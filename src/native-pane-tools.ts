/** Until an owned runner file-transfer port exists, never interpret a Windows path on the coordinator. */
const RUNNER_ONLY = new Set([
  "checkout_repo", "release_repo", "get_usage", "download_attachment", "set_web_theme_asset", "preview_web_appearance",
  "preview_emojis", "preview_stickers", "office_pack_check", "office_pack_upload",
]);
export function nativePaneToolAvailable(tool: string): boolean { return !RUNNER_ONLY.has(tool); }
export function nativePaneToolRefusal(tool: string, args: Record<string, unknown>): string | null {
  if (!nativePaneToolAvailable(tool)) return "This tool is unavailable for native panes; coordinator files and accounts are not the Windows workspace";
  if (tool === "reply" && args.files !== undefined && (!Array.isArray(args.files) || args.files.length > 0))
    return "Native pane file transfer is unavailable; use a text reply without files";
  return null;
}
