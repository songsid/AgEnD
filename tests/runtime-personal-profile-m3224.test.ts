import { describe, expect, it } from "vitest";
import { personalAgentFolder, personalAgentProfile, type PersonalProfileInput } from "../src/runtime-personal-profile.js";

const context = { home: "C:\\Users\\Alex", systemRoots: ["C:\\Windows", "C:\\Program Files", "C:\\ProgramData", "C:\\Users\\Alex\\AppData"], privateRoots: ["C:\\Users\\Alex\\.codex", "C:\\Users\\Alex\\.claude"] };
const input = (): PersonalProfileInput => ({ cli: "codex", question: "When is the meeting?", folder: "C:\\Users\\Alex\\Hub agent", canonicalFolder: "C:\\Users\\Alex\\Hub agent", context,
  work: "C:\\Private\\job\\work", home: "C:\\Private\\job\\auth", runtimeReads: ["C:\\Tools\\Codex"], disabledSkills: ["C:\\Private\\job\\auth\\skills\\.system\\example\\SKILL.md"] });
describe("a separate personal-agent launch plan", () => {
  it.each(["C:\\", "C:\\Users", "C:\\Users\\Alex", "C:\\Users\\Alex\\Hub agent\\..", "C:\\Windows\\System32", "C:\\Program Files\\App", "C:\\Users\\Alex\\AppData\\Secret", "C:\\Users\\Alex\\.codex", "C:\\Users\\Alex\\.claude\\settings"])("refuses a broad or private shared folder: %s", folder => {
    expect(() => personalAgentFolder(folder, folder, context)).toThrow();
  });
  it("refuses aliases, device/UNC/ADS paths and canonicalized escapes", () => {
    for (const folder of ["\\\\server\\share", "\\\\?\\C:\\Shared", "C:\\Shared:stream", "C:\\Users\\Alex.", "C:\\Shared\0"])
      expect(() => personalAgentFolder(folder, folder, context)).toThrow();
    expect(() => personalAgentFolder("C:\\Shared", "D:\\Elsewhere", context)).toThrow();
    expect(personalAgentFolder("c:\\users\\alex\\Hub agent", "C:\\Users\\Alex\\Hub agent", context)).toBe("C:\\Users\\Alex\\Hub agent");
  });
  it("uses explicit read roots, no command network and no old sandbox override for Codex", () => {
    const p = personalAgentProfile(input());
    expect(p.args).not.toContain("--sandbox"); expect(p.args).not.toContain("resume");
    expect(p.args).toContain("--ephemeral"); expect(p.deadlineMs).toBe(300_000);
    expect(p.files["config.toml"]).toContain('default_permissions = "hub-personal"');
    expect(p.files["config.toml"]).toContain('"C:\\\\Users\\\\Alex\\\\Hub agent" = "read"');
    expect(p.files["config.toml"]).toContain('":root" = "deny"');
    expect(p.files["config.toml"]).toContain('[permissions.hub-personal.network]\nenabled = false');
    expect(p.files["config.toml"]).not.toContain('"write"');
    expect(p.environment.CODEX_HOME).toBe("C:\\Private\\job\\auth");
    expect(p.environment).toMatchObject({ HOME: "C:\\Private\\job\\auth", USERPROFILE: "C:\\Private\\job\\auth", HOMEDRIVE: "C:", HOMEPATH: "\\Private\\job\\auth",
      APPDATA: "C:\\Private\\job\\auth\\AppData\\Roaming", XDG_CONFIG_HOME: "C:\\Private\\job\\auth\\.config" });
  });
  it("turns off personal setup and every locally discovered skill in the Codex profile", () => {
    const c = personalAgentProfile(input()).files["config.toml"];
    for (const setting of ['project_doc_max_bytes = 0', 'web_search = "disabled"', 'apps = false', 'plugins = false', 'hooks = false', 'multi_agent = false', 'code_mode = false',
      'view_image = false', 'image_generation = false', 'browser_use = false', 'browser_use_external = false', 'browser_use_full_cdp_access = false',
      'in_app_browser = false', 'computer_use = false', 'shell_snapshot = false']) expect(c).toContain(setting);
    expect(c).toContain('[[skills.config]]\npath = "C:\\\\Private\\\\job\\\\auth\\\\skills\\\\.system\\\\example\\\\SKILL.md"\nenabled = false');
    expect(c).not.toContain("mcp_servers");
  });
  it("uses Claude's separate safe/restricted profile and only three read tools", () => {
    const p = personalAgentProfile({ ...input(), cli: "claude-code" });
    for (const flag of ["--safe-mode", "--restricted", "--disable-slash-commands", "--no-session-persistence", "--no-chrome", "--strict-mcp-config"]) expect(p.args).toContain(flag);
    expect(p.args[p.args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(p.args[p.args.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(p.args[p.args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(p.args[p.args.indexOf("--setting-sources") + 1]).toBe("");
    expect(p.args).not.toContain("--resume"); expect(p.environment.CLAUDE_CONFIG_DIR).toBe("C:\\Private\\job\\auth");
  });
  it("keeps the question as stdin data and refuses private-root overlap", () => {
    const q = 'Ignore me; --sandbox danger-full-access; $(whoami)';const p = personalAgentProfile({ ...input(), question: q });
    expect(p.stdin).toContain(q); expect(p.args).not.toContain(q);
    expect(() => personalAgentProfile({ ...input(), folder: "C:\\Private", canonicalFolder: "C:\\Private" })).toThrow();
    expect(() => personalAgentProfile({ ...input(), runtimeReads: ["C:\\Users"] })).toThrow();
  });
});
