/** Capture the real 2.1.317 MCP permission card (default mode, an inert local MCP tool) as the chrome for the file-send fixtures. */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openRig, scrub } from "./rig.mts";

const output = resolve(process.argv[2] ?? ".artifacts/cc2317-mcp-card");
const rig = await openRig(output, (_prompt, _n, toolResult) => toolResult
  ? { kind: "text", text: "Done." }
  : { kind: "tool", name: "mcp__mock__send_files", input: { to: "someone@example.com", files: [`${process.env.FIXTURE_CWD ?? "/tmp"}/report.pdf`] } });
try {
  const mcp = JSON.stringify({ mcpServers: { mock: { command: process.execPath, args: [resolve("scripts/manual/claude-2317-file-send/mcp-mock.cjs")] } } });
  rig.launch(["--permission-mode", "default", "--strict-mcp-config", "--mcp-config", mcp]);
  await rig.until(p => /❯/.test(p) && !/trust this folder|Use this API key|Choose the text style/.test(p), "ready");
  rig.tmux("send-keys", "-l", "-t", rig.session, "Send the report.");
  await new Promise(r => setTimeout(r, 300)); rig.tmux("send-keys", "-t", rig.session, "Enter");
  const pane = await rig.until(p => /Do you want to proceed\?/.test(p), "mcp permission card");
  writeFileSync(join(output, "claude-2.1.317-mcp-permission.pane.txt"), scrub(pane, rig));
  console.log(scrub(pane, rig));
} finally { await rig.close(); }
