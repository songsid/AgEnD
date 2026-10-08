// Production writeConfig + buildCommand for a scratch instance; prints the launch command.
import { mkdirSync } from "node:fs";
import { ClaudeCodeBackend } from "../../../src/backend/claude-code.js";
const [instDir, workDir, binary, resume] = process.argv.slice(2);
mkdirSync(instDir, { recursive: true }); mkdirSync(workDir, { recursive: true });
const b = new ClaudeCodeBackend(instDir);
(b as any).binaryPath = binary;
const config = { workingDirectory: workDir, instanceDir: instDir, instanceName: "audit", mcpServers: {}, skipPermissions: true, skipResume: resume !== "resume" };
b.preTrust?.(workDir);
b.writeConfig(config as any);
process.stdout.write(b.buildCommand(config as any));
