// Production CodexBackend.writeConfig + buildCommand for a scratch instance, pointed at the mock provider; prints the
// launch command. Run with AGEND_HOME and CODEX_HOME set to scratch homes (short paths outside /tmp) and the audited
// codex first on PATH. Args: instDir workDir port [resume|fresh] [trust|untrusted] [nudge]
//   resume    — production resume plan (exact-cwd thread from the state DB); fresh = skipResume
//   untrusted — skip preTrust, so codex asks its own folder-trust question
//   nudge     — drop AgEnD's hide_rate_limit_model_nudge so the rate-limit picker can paint
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexBackend } from "../../../src/backend/codex.js";
const [instDir, workDir, port, resume = "fresh", trust = "trust", nudge = ""] = process.argv.slice(2);
mkdirSync(instDir, { recursive: true }); mkdirSync(workDir, { recursive: true });
// The shared home's config is what writeConfig copies into the instance home: point it at the mock.
const shared = process.env.CODEX_HOME!;
mkdirSync(shared, { recursive: true });
writeFileSync(join(shared, "config.toml"), [
  `model = "mock-model"`, `model_provider = "mock"`,
  `[model_providers.mock]`, `name = "mock"`, `base_url = "http://127.0.0.1:${port}/v1"`,
  `wire_api = "responses"`, `requires_openai_auth = false`, ``,
].join("\n"));
const b = new CodexBackend(instDir);
const config = { workingDirectory: workDir, instanceDir: instDir, instanceName: "audit", mcpServers: {}, skipPermissions: true, skipResume: resume !== "resume" };
b.writeConfig(config as any);
if (trust === "trust") b.preTrust(workDir);
const home = (b as any).isolatedCodexHome as string;
if (nudge === "nudge") {
  const path = join(home, "config.toml");
  writeFileSync(path, readFileSync(path, "utf8").replace(/^(?:notice\.)?hide_rate_limit_model_nudge = true\n/m, ""));
}
process.stdout.write(b.buildCommand(config as any));
