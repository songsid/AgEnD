/** Deterministic prompt rendering: command/args come from this computer, never a secret-bearing config dump. */
export function connectorPrompt(info, app, where, translate) {
  const server = where === "windows" ? info.windows : info.local;
  if (!server) return "";
  const name = translate(app === "claude" ? "claude" : app === "codex" ? "codex" : "generic");
  const config = app === "codex"
    ? `[mcp_servers.agend]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}`
    : JSON.stringify({ mcpServers: { agend: { command: server.command, args: server.args } } }, null, 2);
  return `${translate("prompt").replace("{app}", name)}\n\n${translate("config")}:\n${config}`;
}
/** A remote app config contains only the canonical Hub URL, never a local command or token. */
export function hubConnectorPrompt(address, app, translate) {
  let url; try { url = new URL(address); } catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") return "";
  const name = translate(app === "claude" ? "claude" : app === "codex" ? "codex" : "generic");
  const config = app === "codex" ? `[mcp_servers.agend_hub]\nurl = ${JSON.stringify(url.href)}`
    : app === "claude" ? JSON.stringify({mcpServers:{agend_hub:{type:"http",url:url.href}}},null,2)
    : JSON.stringify({url:url.href,transport:"streamable-http"},null,2);
  return `${translate("prompt").replace("{app}", name)}\n\n${translate("config")}:\n${config}`;
}
