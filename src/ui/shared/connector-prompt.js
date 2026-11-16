/** Deterministic prompt rendering: command/args come from this computer, never a secret-bearing config dump. */
export function connectorPrompt(info, app, where, translate) {
  const server = where === "windows" ? info.windows : info.local;
  if (!server) return "";
  const name = app === "claude" ? "Claude Code" : app === "codex" ? "Codex" : translate("generic");
  const config = app === "codex"
    ? `[mcp_servers.agend]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}`
    : JSON.stringify({ mcpServers: { agend: { command: server.command, args: server.args } } }, null, 2);
  return `${translate("prompt").replace("{app}", name)}\n\n${translate("config")}:\n${config}`;
}
