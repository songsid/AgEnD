import { createServer, type Server } from "node:http";
import type { MessageBus } from "../channel/message-bus.js";

const SAFE_TOOLS = new Set([
  "Read", "Edit", "Write", "Glob", "Grep",
  "Bash(*)", "WebFetch", "WebSearch", "Agent", "Skill",
  "mcp__plugin_ccd-channel_ccd-channel__reply",
  "mcp__plugin_ccd-channel_ccd-channel__react",
  "mcp__plugin_ccd-channel_ccd-channel__edit_message",
  "mcp__plugin_ccd-channel_ccd-channel__download_attachment",
]);

const SAFE_PREFIXES = [
  "mcp__plugin_ccd-channel_ccd-channel__",
];

const DANGER_PATTERNS = [
  /^rm\s+-rf\s+[\/~]/,
  /git\s+push.*--force/,
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-f/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\bsudo\b/,
];

function isSafeTool(toolName: string): boolean {
  if (SAFE_TOOLS.has(toolName)) return true;
  for (const prefix of SAFE_PREFIXES) {
    if (toolName.startsWith(prefix)) return true;
  }
  return false;
}

function isDangerousCommand(command: string): boolean {
  return DANGER_PATTERNS.some(pattern => pattern.test(command));
}

export class ApprovalServer {
  private server: Server | null = null;

  constructor(private messageBus: MessageBus, private port: number) {}

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/approve") {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }

        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", async () => {
          try {
            const { tool_name, tool_input } = JSON.parse(body) as {
              tool_name: string;
              tool_input: Record<string, unknown>;
            };

            let permissionDecision: "allow" | "deny";

            if (isSafeTool(tool_name)) {
              permissionDecision = "allow";
            } else if (tool_name === "Bash" && typeof tool_input?.command === "string" && isDangerousCommand(tool_input.command)) {
              permissionDecision = "deny";
            } else {
              const prompt = `Tool: ${tool_name}\nInput: ${JSON.stringify(tool_input, null, 2)}`;
              const approval = await this.messageBus.requestApproval(prompt);
              permissionDecision = approval.decision === "approve" ? "allow" : "deny";
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ hookSpecificOutput: { permissionDecision } }));
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Bad request" }));
          }
        });
      });

      this.server.on("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => {
        const address = this.server!.address();
        const actualPort = typeof address === "object" && address !== null ? address.port : this.port;
        resolve(actualPort);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = null;
    });
  }
}
