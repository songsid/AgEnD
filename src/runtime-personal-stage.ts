/** Private authentication-only staging, owned by the Windows worker rather than the Hub. */
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { personalAgentFolder, personalAgentProfile, type PersonalProfilePlan } from "./runtime-personal-profile.js";
import { isPersonalAgentCli, type PersonalAgentCli } from "./runtime-personal-answer.js";
import { protectRuntimeProfileDirectorySync } from "./runtime-pane-private.js";

export class PersonalAgentStageError extends Error {
  constructor(readonly reason: "unsupported-platform" | "folder-invalid" | "authentication-unavailable" | "profile-unavailable") { super(`Personal agent: ${reason}`); }
}
export interface PersonalStageHost {
  platform: string;
  userHome: string;
  environment: NodeJS.ProcessEnv;
  realDirectory(path: string): string;
  readPrivate(path: string): string;
  create(): { work: string; home: string; cleanup(): void };
  writePrivate(path: string, value: string): void;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function environmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const values = [...new Set(Object.entries(env).filter(([k,v]) => k.toUpperCase() === key && v !== undefined).map(([,v]) => v!))];
  if (values.length > 1) throw new PersonalAgentStageError("profile-unavailable");
  return values[0];
}
/** The known authentication fields only; settings, hooks, plugins and model/provider config cannot hitchhike. */
function authentication(cli: PersonalAgentCli, text: string): string {
  let v: unknown; try { v = JSON.parse(text); } catch { throw new PersonalAgentStageError("authentication-unavailable"); }
  if (!object(v)) throw new PersonalAgentStageError("authentication-unavailable");
  if (cli === "codex") {
    const source = object(v.tokens) ? v.tokens : null;
    const tokens = source ? Object.fromEntries(["id_token", "access_token", "refresh_token", "account_id"].filter(k => typeof source[k] === "string").map(k => [k, source[k]])) : undefined;
    if (!tokens?.access_token && !(typeof v.OPENAI_API_KEY === "string" && v.OPENAI_API_KEY.trim())) throw new PersonalAgentStageError("authentication-unavailable");
    return JSON.stringify({ ...(typeof v.auth_mode === "string" ? { auth_mode: v.auth_mode } : {}),
      ...(typeof v.OPENAI_API_KEY === "string" ? { OPENAI_API_KEY: v.OPENAI_API_KEY } : {}), ...(tokens ? { tokens } : {}),
      ...(typeof v.last_refresh === "string" ? { last_refresh: v.last_refresh } : {}) });
  }
  if (!object(v.claudeAiOauth) || typeof v.claudeAiOauth.accessToken !== "string" || !v.claudeAiOauth.accessToken) throw new PersonalAgentStageError("authentication-unavailable");
  const source = v.claudeAiOauth;
  const oauth = Object.fromEntries(["accessToken", "refreshToken", "expiresAt", "scopes", "subscriptionType", "rateLimitTier"].filter(k => source[k] !== undefined).map(k => [k, source[k]]));
  return JSON.stringify({ claudeAiOauth: oauth });
}
export interface PersonalStageInput { cli: PersonalAgentCli; folder: string; question: string; model?: string; runtimeReads: readonly string[] }
export interface PersonalStage { plan: PersonalProfilePlan; cleanup(): void }

export function stagePersonalAgent(input: PersonalStageInput, host: PersonalStageHost): PersonalStage {
  if (host.platform !== "win32") throw new PersonalAgentStageError("unsupported-platform");
  if (!isPersonalAgentCli(input.cli)) throw new PersonalAgentStageError("profile-unavailable");
  const ownHome = host.realDirectory(host.userHome), env = host.environment;
  const codexHome = environmentValue(env, "CODEX_HOME") || win32.join(ownHome, ".codex");
  const claudeHome = environmentValue(env, "CLAUDE_CONFIG_DIR") || win32.join(ownHome, ".claude");
  const context = { home: ownHome,
    systemRoots: ["SYSTEMROOT", "WINDIR", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "APPDATA", "LOCALAPPDATA"].map(k => environmentValue(env, k)).filter((v): v is string => !!v),
    privateRoots: [codexHome, claudeHome, win32.join(ownHome, ".agend-runtime")] };
  let folder: string;
  try { folder = personalAgentFolder(input.folder, host.realDirectory(input.folder), context); }
  catch { throw new PersonalAgentStageError("folder-invalid"); }
  const stage = host.create();
  try {
    const sourceHome = input.cli === "codex" ? codexHome : claudeHome;
    const filename = input.cli === "codex" ? "auth.json" : ".credentials.json";
    let auth: string;
    try { auth = authentication(input.cli, host.readPrivate(win32.join(sourceHome, filename))); }
    catch { throw new PersonalAgentStageError("authentication-unavailable"); }
    host.writePrivate(win32.join(stage.home, filename), auth);
    // These are the bundled system skills observed in the approved step-0 CLI. The final prompt check still
    // refuses a newly introduced skill; a static list is never a substitute for that check.
    const skills = ["imagegen", "openai-docs", "review-agent", "skill-creator", "skill-installer"].map(name => win32.join(stage.home, "skills", ".system", name, "SKILL.md"));
    const plan = personalAgentProfile({ ...input, canonicalFolder: folder, context, work: stage.work, home: stage.home, disabledSkills: skills });
    for (const [name, content] of Object.entries(plan.files)) {
      if (name !== "config.toml") throw new PersonalAgentStageError("profile-unavailable");
      host.writePrivate(win32.join(stage.home, name), content);
    }
    if (input.cli === "codex") plan.args.splice(1, 0, "--strict-config");
    return { plan, cleanup: stage.cleanup };
  } catch (error) { stage.cleanup(); throw error instanceof PersonalAgentStageError ? error : new PersonalAgentStageError("profile-unavailable"); }
}

/** Actual filesystem port. No source authentication/config file is changed or logged out. */
export function windowsPersonalStageHost(environment: NodeJS.ProcessEnv): PersonalStageHost {
  return { platform: process.platform, userHome: homedir(), environment,
    realDirectory(path) {
      const entry = lstatSync(path); if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error("Personal folder is not a real directory");
      return realpathSync(path);
    },
    readPrivate(path) {
      const before = lstatSync(path); if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024) throw Error("Authentication unavailable");
      const value = readFileSync(path, "utf8"), after = lstatSync(path);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || Buffer.byteLength(value) > 64 * 1024) throw Error("Authentication changed during staging");
      return value;
    },
    writePrivate(path, value) { writeFileSync(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" }); },
    create() {
      if (process.platform !== "win32") throw new PersonalAgentStageError("unsupported-platform");
      const root = mkdtempSync(join(tmpdir(), "agend-personal-")), marker = randomUUID(), identity = lstatSync(root);
      // Windows ignores chmod modes. Verify the inherited private NTFS ACL before copying any authentication.
      try { protectRuntimeProfileDirectorySync(root); } catch { rmSync(root, { recursive: true }); throw new PersonalAgentStageError("profile-unavailable"); }
      writeFileSync(join(root, ".owned"), marker, { mode: 0o600, flag: "wx" });
      const work = join(root, "work"), home = join(root, "auth");
      mkdirSync(work, { mode: 0o700 }); mkdirSync(join(work, ".git"), { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
      return { work, home, cleanup() {
        const current = lstatSync(root);
        if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || readFileSync(join(root, ".owned"), "utf8") !== marker) throw Error("Private personal-agent directory identity changed");
        rmSync(root, { recursive: true });
      } };
    } };
}
