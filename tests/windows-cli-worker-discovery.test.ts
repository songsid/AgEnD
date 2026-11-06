import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeCliEnvironment, NATIVE_CLI_IDS, npmCliShimTarget, isUsableNativeBinaryFile, isUsableNativeBinarySize, npmNativeExecutable, npmNativeShimTarget, prepareNativeWorkspace, probeNativeClis, validateNativeTask, type NativeCliExecutable, type NativeCliId } from "../src/windows-cli-worker.js";

afterEach(() => vi.unstubAllEnvs());
const workspaces: string[]=[];
afterEach(()=>{for(const path of workspaces.splice(0)){if(!resolve(path).startsWith(resolve(tmpdir())+ (process.platform==="win32" ? "\\" : "/")))throw Error("Unsafe scratch directory");rmSync(path,{recursive:true,force:true});}});
const scratchHome=()=>{const path=mkdtempSync(join(tmpdir(),"agend-native-workspace-"));workspaces.push(path);return path;};
describe("managed native workspace directories",()=>{
  const id="12345678-1234-4321-abcd-123456789012";
  it("creates an agent-specific native directory once and preserves its content on later preparations",()=>{
    const home=scratchHome(), cwd=prepareNativeWorkspace(id,home);
    expect(cwd).toBe(join(home,".agend","workspaces",id));expect(statSync(cwd).isDirectory()).toBe(true);
    writeFileSync(join(cwd,"keep.txt"),"context");
    expect(prepareNativeWorkspace(id,home)).toBe(cwd);expect(readFileSync(join(cwd,"keep.txt"),"utf8")).toBe("context");
  });
  it.each([undefined,null,"",[],"../escape","C:\\elsewhere","12345678-1234-4321-abcd-123456789012/child"])("rejects an invalid agent id %j before creating directories",value=>{
    const home=scratchHome();expect(()=>prepareNativeWorkspace(value,home)).toThrow(/agent id/);expect(existsSync(join(home,".agend"))).toBe(false);
  });
  it("refuses a file in the managed parent chain without overwriting it",()=>{
    const home=scratchHome();writeFileSync(join(home,".agend"),"keep");
    expect(()=>prepareNativeWorkspace(id,home)).toThrow(/real directory/);expect(readFileSync(join(home,".agend"),"utf8")).toBe("keep");
  });
  it.each(["parent","agent"])("refuses %s junctions or symbolic links that redirect managed creation",which=>{
    const home=scratchHome(), outside=join(home,"outside");mkdirSync(outside);
    const link=which==="parent" ? join(home,".agend") : prepareNativeWorkspace(id,home);
    if(which==="agent")rmdirSync(link);
    symlinkSync(outside,link,process.platform==="win32"?"junction":"dir");
    expect(()=>prepareNativeWorkspace(id,home)).toThrow(/real directory/);
    expect(existsSync(join(outside,"workspaces"))).toBe(false);
  });
});
const executable = (id: NativeCliId): NativeCliExecutable => ({ path: `C:\\CLI\\${id}.exe`, command: `C:\\CLI\\${id}.exe`, args: [] });
const help = "--json --sandbox --print --input-format text stream-json --output-format streaming-json --conversation --resume --resume-id --permission-prompts --tools --strict-mcp-config --mcp-config --format json --session --session-id --dir --prompt-file --no-interactive";

describe("native Windows CLI discovery", () => {
  it("starts discovery of all providers concurrently, including missing native installations", async () => {
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const started = new Set<NativeCliId>();
    const pending = probeNativeClis({ find: async id => { started.add(id); await gate; return null; } });
    expect([...started]).toEqual([...NATIVE_CLI_IDS]);
    release();
    const result = await pending;
    expect(result.hostname).toBe(hostname());
    expect(result.clis).toHaveLength(7);
    expect(result.clis.every(row => row.path === null && !row.runnable && row.authenticated === null && /not installed/.test(row.reason ?? ""))).toBe(true);
  });

  it("distinguishes signed out from unknown authentication and never probes unsupported auth commands", async () => {
    const calls: string[] = [];
    const result = await probeNativeClis({
      find: async id => ["codex", "claude-code", "antigravity"].includes(id) ? executable(id) : null,
      run: async (entry, args) => {
        const id = entry.path.split("\\").at(-1)!.replace(/\.exe$/, "");
        calls.push(`${id}:${args.join(" ")}`);
        if (args.includes("--help")) return { ok: true, text: help };
        if (args.includes("--version")) return { ok: true, text: "1.2.3" };
        if (args.join(" ").endsWith("login status")) return { ok: false, text: "Not logged in" };
        if (args.join(" ") === "auth status") return { ok: false, text: "unsupported status response" };
        return { ok: true, text: "gemini-3.1-pro-high  Gemini 3.1 Pro (High)" };
      },
    });
    expect(result.clis.find(row => row.id === "codex")).toMatchObject({ authenticated: false, runnable: false });
    expect(result.clis.find(row => row.id === "claude-code")).toMatchObject({ authenticated: null, runnable: true, readOnlySupport: true });
    expect(result.clis.find(row => row.id === "antigravity")).toMatchObject({ authenticated: null, runnable: true, readOnlySupport: false, models: [{ id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" }] });
    expect(calls.filter(call => call.startsWith("antigravity:")).sort()).toEqual(["antigravity:--help", "antigravity:--version", "antigravity:models"].sort());
  });

  it("M-2239 P1-2: every probe argv carries the CLI's own update switch, and muse is never started", async () => {
    const home = scratchHome(); writeFileSync(join(home, ".muse-version"), "1.4.6\n");
    const calls: string[][] = [];
    const result = await probeNativeClis({
      find: async id => id === "muse" ? { path: join(home, "muse.exe"), command: join(home, "muse.exe"), args: [] } : ["codex", "grok", "opencode"].includes(id) ? executable(id) : null,
      run: async (entry, args) => { calls.push([entry.path.split(/[\\/]/).at(-1)!, ...args]); return { ok: true, text: args.includes("--version") ? "1.0.0" : help }; },
      readModels: () => [],
    });
    const of = (bin: string) => calls.filter(c => c[0] === bin).map(c => c.slice(1));
    expect(of("codex.exe").length).toBeGreaterThan(0);
    for (const args of of("codex.exe")) expect(args.slice(0, 2)).toEqual(["-c", "check_for_update_on_startup=false"]);
    expect(of("grok.exe").length).toBeGreaterThan(0);
    for (const args of of("grok.exe")) expect(args[0]).toBe("--no-auto-update");
    expect(of("muse.exe")).toEqual([]);
    expect(result.clis.find(row => row.id === "muse")).toMatchObject({ version: "1.4.6", runnable: true });
  });

  it("M-2239 P1-2: every Windows CLI run carries the env update switches", () => {
    expect(nativeCliEnvironment()).toMatchObject({ DISABLE_AUTOUPDATER: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", NO_UPDATE_NOTIFIER: "1", KIRO_NO_AUTO_UPDATE: "1", MUSE_UPDATE_INTERVAL_SECONDS: "31536000" });
  });

  it("does not mark an outdated CLI ready merely because its executable and version exist", async () => {
    const result = await probeNativeClis({
      find: async id => id === "grok" ? executable(id) : null,
      run: async (_entry, args) => ({ ok: true, text: args.includes("--version") ? "1.0.0" : "Usage: grok --help --model" }),
    });
    expect(result.clis.find(row => row.id === "grok")).toMatchObject({ runnable: false, supports: { execution: false }, reason: expect.stringContaining("required headless JSON") });
  });

  it("serializes one binary's probes and retries an empty successful capture without treating it as an old CLI", async () => {
    let active = 0, maxActive = 0, versions = 0;
    const result = await probeNativeClis({
      find: async id => id === "grok" ? executable(id) : null,
      run: async (_entry, args) => {
        active++; maxActive = Math.max(active, maxActive);
        await new Promise(done => setTimeout(done, 1));
        active--;
        if (args.includes("--version")) return { ok: true, text: ++versions === 1 ? "" : "grok 1.0.46" };
        return { ok: true, text: help };
      },
    });
    expect(maxActive).toBe(1);
    expect(versions).toBe(2);
    expect(result.clis.find(row => row.id === "grok")).toMatchObject({ version: "grok 1.0.46", runnable: true });
  });

  it("keeps persistently empty help output unavailable with a capture failure reason", async () => {
    const result = await probeNativeClis({
      find: async id => id === "grok" ? executable(id) : null,
      run: async (_entry, args) => ({ ok: true, text: args.includes("--version") ? "grok 1.0.46" : "" }),
    });
    expect(result.clis.find(row => row.id === "grok")).toMatchObject({ runnable: false, reason: "The Windows CLI help check returned no usable output" });
  });

  it("withholds read-only capability when Claude cannot disable configured MCP tools", async () => {
    const result = await probeNativeClis({
      find: async id => id === "claude-code" ? executable(id) : null,
      run: async (_entry, args) => ({ ok: true, text: args.includes("--help") ? "--print --output-format --input-format --permission-prompts --tools" : args.includes("--version") ? "2.1.299" : '{"loggedIn":true}' }),
    });
    expect(result.clis.find(row => row.id === "claude-code")).toMatchObject({ runnable: true, readOnlySupport: false });
  });
});

describe("native Node shims and environment", () => {
  it("recognizes known npm script targets without treating arbitrary batch launchers or the Kiro IDE as a coding CLI", () => {
    const shim = '@ECHO off\nSET "_prog=node"\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*';
    expect(npmCliShimTarget("codex", shim)).toBe("node_modules/@openai/codex/bin/codex.js");
    expect(npmCliShimTarget("codex", shim.replace("@openai\\codex", "unknown\\codex"))).toBeNull();
    expect(npmCliShimTarget("codex", shim.replace("node_modules", "..\\node_modules"))).toBeNull();
    expect(npmCliShimTarget("kiro-cli", 'SET ELECTRON_RUN_AS_NODE=1\n"%dp0%\\..\\Kiro.exe" cli.js %*')).toBeNull();
    expect(npmCliShimTarget("grok", shim)).toBeNull();
  });

  describe("npm Claude Code", () => {
    const legacy = '@ECHO off\nSET "_prog=node"\n"%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*';
    const modern = '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\n';
    const dir = "C:\\Users\\u\\AppData\\Roaming\\npm";
    const pkg = `${dir}\\node_modules\\@anthropic-ai\\claude-code`;
    const nested = `${pkg}\\node_modules\\@anthropic-ai\\claude-code-win32-x64\\claude.exe`;
    const bin = `${pkg}\\bin\\claude.exe`;
    const fs = (files: Record<string, number>) => [(p: string) => p in files, (p: string) => files[p]] as const;
    it("keeps the legacy cli.js shim on the node path and recognizes the new native shim", () => {
      expect(npmCliShimTarget("claude-code", legacy)).toBe("node_modules/@anthropic-ai/claude-code/cli.js");
      expect(npmNativeShimTarget("claude-code", legacy)).toBeNull();
      expect(npmCliShimTarget("claude-code", modern)).toBeNull();
      expect(npmNativeShimTarget("claude-code", modern)).toBe("node_modules/@anthropic-ai/claude-code/bin/claude.exe");
    });
    it("only recognizes the exact known path shape, for Claude Code only", () => {
      expect(npmNativeShimTarget("codex", modern)).toBeNull();
      expect(npmNativeShimTarget("claude-code", modern.replace("claude-code", "evil"))).toBeNull();
      expect(npmNativeShimTarget("claude-code", modern.replace("node_modules", "..\\node_modules"))).toBeNull();
      expect(npmNativeShimTarget("claude-code", '@echo off\ncalc.exe "%dp0%\\other.exe" %*')).toBeNull();
      expect(npmNativeShimTarget("claude-code", modern + " ".repeat(33 * 1024))).toBeNull();
    });
    it("prefers the nested platform executable and ignores the ignore-scripts placeholder", () => {
      const [exists, size] = fs({ [nested]: 200_000_000, [bin]: 500 });
      expect(npmNativeExecutable("claude-code", dir, exists, size, "x64")).toBe(nested);
    });
    it("uses bin\\claude.exe when it is the real binary", () => {
      const [exists, size] = fs({ [bin]: 200_000_000 });
      expect(npmNativeExecutable("claude-code", dir, exists, size, "x64")).toBe(bin);
    });
    it("finds a hoisted platform package", () => {
      const hoisted = `${dir}\\node_modules\\@anthropic-ai\\claude-code-win32-x64\\claude.exe`;
      const [exists, size] = fs({ [hoisted]: 200_000_000, [bin]: 500 });
      expect(npmNativeExecutable("claude-code", dir, exists, size, "x64")).toBe(hoisted);
    });
    const MiB = 1024 * 1024;
    const arm = `${pkg}\\node_modules\\@anthropic-ai\\claude-code-win32-arm64\\claude.exe`;
    it("selects the platform package for the machine architecture", () => {
      expect(npmNativeExecutable("claude-code", dir, ...fs({ [nested]: 200 * MiB, [arm]: 200 * MiB }), "arm64")).toBe(arm);
      expect(npmNativeExecutable("claude-code", dir, ...fs({ [nested]: 200 * MiB }), "arm64")).toBe(nested);
      expect(npmNativeExecutable("claude-code", dir, ...fs({ [arm]: 200 * MiB }), "x64")).toBeNull();
      expect(npmNativeExecutable("claude-code", dir, ...fs({ [nested]: 200 * MiB, [arm]: 200 * MiB }), "x64")).toBe(nested);
    });
    it("treats 1 MiB as the smallest real binary", () => {
      expect(npmNativeExecutable("claude-code", dir, ...fs({ [nested]: MiB - 1 }), "x64")).toBeNull();
      expect(npmNativeExecutable("claude-code", dir, ...fs({ [nested]: MiB }), "x64")).toBe(nested);
      expect(isUsableNativeBinarySize("claude-code", MiB - 1)).toBe(false);
      expect(isUsableNativeBinarySize("claude-code", MiB)).toBe(true);
      expect(isUsableNativeBinarySize("codex", 10)).toBe(true);
    });
    it("treats a file whose size cannot be read as not usable instead of throwing", () => {
      const gone = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
      expect(isUsableNativeBinaryFile("claude-code", bin, gone)).toBe(false);
      expect(isUsableNativeBinaryFile("claude-code", bin, () => 500)).toBe(false);
      expect(isUsableNativeBinaryFile("claude-code", bin, () => 200 * MiB)).toBe(true);
      expect(npmNativeExecutable("claude-code", dir, () => true, gone, "x64")).toBeNull();
    });
    it("returns null when a hoisted package is a placeholder and the nested one is missing", () => {
      const hoisted = `${dir}\\node_modules\\@anthropic-ai\\claude-code-win32-x64\\claude.exe`;
      expect(npmNativeExecutable("claude-code", dir, ...fs({ [hoisted]: 500 }), "x64")).toBeNull();
      expect(npmNativeExecutable("claude-code", dir, ...fs({ [hoisted]: 500, [bin]: 500 }), "x64")).toBeNull();
    });
    it("recognizes a shim with CRLF line endings", () => {
      expect(npmNativeShimTarget("claude-code", modern.replace(/\n/g, "\r\n"))).toBe("node_modules/@anthropic-ai/claude-code/bin/claude.exe");
      expect(npmCliShimTarget("claude-code", legacy.replace(/\n/g, "\r\n"))).toBe("node_modules/@anthropic-ai/claude-code/cli.js");
    });
    it("reports nothing when only a placeholder or nothing is installed", () => {
      expect(npmNativeExecutable("claude-code", dir, ...fs({ [bin]: 500 }), "x64")).toBeNull();
      expect(npmNativeExecutable("claude-code", dir, ...fs({}), "x64")).toBeNull();
      expect(npmNativeExecutable("codex", dir, ...fs({ [bin]: 200_000_000 }), "x64")).toBeNull();
    });
  });

  it("drops inherited Linux instance paths and Node injection while keeping Windows login configuration", () => {
    vi.stubEnv("CODEX_HOME", "/home/linux/.codex");
    vi.stubEnv("KIRO_HOME", "/home/linux/.kiro");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "C:\\Users\\Windows\\.claude");
    vi.stubEnv("NODE_OPTIONS", "--require unexpected.js");
    vi.stubEnv("ANTIGRAVITY_CONVERSATION_ID", "unrelated-conversation");
    vi.stubEnv("AGEND_INSTANCE_NAME", "linux-instance");
    vi.stubEnv("AGEND_API_TOKEN", "test-daemon-token");
    vi.stubEnv("Agend_Custom_Parameter", "test-instance-parameter");
    const env = nativeCliEnvironment();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.KIRO_HOME).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ANTIGRAVITY_CONVERSATION_ID).toBeUndefined();
    expect(Object.keys(env).filter(key => /^AGEND_/i.test(key))).toEqual([]);
    expect(env.CLAUDE_CONFIG_DIR).toBe("C:\\Users\\Windows\\.claude");
  });

  it("M-2239 P3-6: an allowlist — Windows' own variables, proxy, certificates and locale pass; nothing else does", () => {
    const env = nativeCliEnvironment({
      SystemRoot: "C:\\Windows", Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE", USERPROFILE: "C:\\Users\\U",
      APPDATA: "C:\\Users\\U\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\U\\AppData\\Local", "ProgramFiles(x86)": "C:\\Program Files (x86)",
      HTTPS_PROXY: "http://proxy:8080", NODE_EXTRA_CA_CERTS: "C:\\certs\\corp.pem", LANG: "zh_TW.UTF-8", LC_ALL: "C.UTF-8",
      CODEX_HOME: "D:\\codex-home", GEMINI_HOME: "/home/linux/.gemini",
      // none of these may reach a native CLI
      AGEND_BOT_TOKEN: "123:abc", DISCORD_BOT_TOKEN: "x", MY_TELEGRAM_TOKEN: "y", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", XAI_API_KEY: "k",
      CLOUDFLARE_TUNNEL_TOKEN: "t", GITHUB_TOKEN: "g", NODE_OPTIONS: "--require x.js", NODE_PATH: "/x", HOME: "/home/linux", WSLENV: "X/u",
      CLAUDE_CODE_SESSION_ID: "s", SOME_RANDOM_SECRET: "r",
    });
    expect(Object.keys(env).sort()).toEqual([
      "APPDATA", "CODEX_HOME", "DISABLE_AUTOUPDATER", "HTTPS_PROXY", "KIRO_NO_AUTO_UPDATE", "LANG", "LC_ALL", "LOCALAPPDATA", "MUSE_UPDATE_INTERVAL_SECONDS",
      "NODE_EXTRA_CA_CERTS", "NO_UPDATE_NOTIFIER", "OPENCODE_DISABLE_AUTOUPDATE", "PATHEXT", "Path", "ProgramFiles(x86)", "SystemRoot", "USERPROFILE",
    ].sort());
    expect(env.Path).toBe("C:\\Windows\\System32;C:\\Program Files\\nodejs");
  });

  it("accepts literal model selection and rejects providers that cannot enforce the requested policy", () => {
    const task = { requestId: "windows-task-12345678", cli: "antigravity", cwd: "J:\\Project\\Game", prompt: "Inspect the project", sandbox: "workspace-write", model: "gemini-3.1-pro-high" };
    expect(validateNativeTask(task)).toEqual(task);
    expect(() => validateNativeTask({ ...task, sandbox: "read-only" })).toThrow(/read-only/);
    expect(() => validateNativeTask({ ...task, cli: "kiro-cli" })).toThrow();
    expect(() => validateNativeTask({ ...task, model: "good; powershell evil" })).toThrow(/model/i);
  });
});
