/**
 * #2799: the Canvas Worker effect code is gone (#2793 had turned it off for good). What stays:
 * - a saved `web.experimental.canvas_worker` (true or false) loads with no error or warning and stays in the file;
 * - no agent is shown the effect tools, and one that still calls them (a resumed session's schema) is told plainly, at
 *   every door: the MCP server's list, the fleet's permission check, its agent endpoint and its typed tool path;
 * - the bundled skills have one text; the status frame and the page carry no Canvas Worker switch;
 * - Settings can't write the switch; effect placements a person's reset meets stay on disk.
 * (Mods that carry effects: web-mods-1629. The tool list, byte for byte as before: the PR's acceptance.)
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { parseWebSettingsBody } from "../src/web-settings-patch.js";
import { CANVAS_WORKER_EXPERIMENTAL_MESSAGE, isCanvasWorkerTool } from "../src/web-experimental.js";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { EARLY_AGENT_OP_TOOLS, TOOL_PROFILES, toolForIpcType } from "../src/tool-permissions.js";
import { dispatchAgentOperation, ToolNotPermittedError } from "../src/agent-endpoint.js";
import { bundledSkillContents, BUNDLED_SKILLS_DIR, listBundledSkills } from "../src/bundled-skills.js";
import { agentWhatsNew } from "../src/agent-whats-new.js";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const CW_TOOLS = ["upload_web_effect", "list_web_effects", "preview_web_effect", "profile_web_effect", "apply_web_effect",
  "remove_web_effect", "delete_web_effect", "export_web_mod", "propose_web_mod"];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2799-")); dirs.push(dir);
  const file = join(dir, "fleet.yaml"); writeFileSync(file, text);
  const fm = new FleetManager(dir) as any; fm.loadConfig(file);
  return { fm, dir, file };
}

describe("#2799 Canvas Worker effects removed", () => {
  it("a saved true or false loads with no error or warning, and startup leaves it in the file", () => {
    for (const value of [true, false]) {
      const result = validateFleetConfig({ defaults: {}, instances: {}, web: { experimental: { canvas_worker: value } } });
      expect(result.valid, String(value)).toBe(true);
      expect(result.warnings.filter(w => w.path.startsWith("web.experimental")), String(value)).toEqual([]);
      const text = `# mine\nweb:\n  experimental:\n    canvas_worker: ${value}\ninstances: {}\n`;
      const h = rig(text); h.fm.slimFleetConfigAtStartup();
      expect(readFileSync(h.file, "utf8"), String(value)).toBe(text);
    }
  });

  it("no tool list names them; a profile can't grant them; the bundled skills and the what's-new notes don't mention them", () => {
    expect(TOOLS.filter(t => isCanvasWorkerTool(t.name)).map(t => t.name)).toEqual([]);
    expect(Object.entries(TOOL_PROFILES).flatMap(([p, tools]) => (tools ?? []).filter((t: string) => CW_TOOLS.includes(t)).map((t: string) => `${p}:${t}`))).toEqual([]);
    expect(CW_TOOLS.every(isCanvasWorkerTool)).toBe(true);
    for (const s of listBundledSkills()) expect(bundledSkillContents(join(BUNDLED_SKILLS_DIR, s.name)), s.name).not.toMatch(/upload_web_effect|apply_web_effect|export_web_mod|Canvas Worker effects with Try/);
    expect(agentWhatsNew().filter(e => /Canvas Worker|upload_web_effect/.test(e.text)).map(e => e.id)).toEqual([]);
  });

  it("an agent that still calls one is told plainly, at the permission check, the agent endpoint and the typed tool path — whatever the config says", async () => {
    const h = rig("web:\n  experimental:\n    canvas_worker: true\ninstances:\n  worker:\n    working_directory: /tmp\n    tool_set: full\n");
    for (const tool of CW_TOOLS) {
      expect(h.fm.checkToolPermission("ipc-typed", "worker", tool), tool).toEqual({ allowed: false, message: CANVAS_WORKER_EXPERIMENTAL_MESSAGE });
      expect(await h.fm.handleWebThemeHttp("worker", tool, {}), tool).toEqual({ error: "canvas_worker_experimental", message: CANVAS_WORKER_EXPERIMENTAL_MESSAGE });
    }
    // A stale MCP process's typed IPC: refused at the permission check, answered on the web-theme lane with the message.
    const sent: unknown[] = [];
    h.fm.instanceIpcClients.set("worker", { send: (m: unknown) => sent.push(m) });
    for (const tool of CW_TOOLS) {
      expect(toolForIpcType(`fleet_${tool}`), tool).toBe(tool);
      h.fm.refuseTypedIpc("worker", { type: `fleet_${tool}`, fleetRequestId: `r-${tool}` }, CANVAS_WORKER_EXPERIMENTAL_MESSAGE);
    }
    expect(sent).toEqual(CW_TOOLS.map(tool => ({ type: "fleet_web_theme_response", fleetRequestId: `r-${tool}`, error: CANVAS_WORKER_EXPERIMENTAL_MESSAGE })));
    // `agend-agent effect …` / `mod export|propose`: the CLI's op names still map to the removed tools, so the endpoint
    // answers with the message before any handler — under the widest profile too.
    const ops = Object.entries(EARLY_AGENT_OP_TOOLS).filter(([, tool]) => isCanvasWorkerTool(tool)).map(([op]) => op);
    expect(ops.sort()).toEqual(["effect-apply", "effect-delete", "effect-list", "effect-preview", "effect-profile", "effect-remove", "effect-upload", "mod-export", "mod-propose"]);
    for (const op of ops) {
      const err = await dispatchAgentOperation({ fleetConfig: h.fm.fleetConfig, logger: { warn: vi.fn() } } as never, "worker", op, {}).catch(e => e as Error);
      expect(err, op).toBeInstanceOf(ToolNotPermittedError);
      expect((err as Error).message, op).toBe(CANVAS_WORKER_EXPERIMENTAL_MESSAGE);
    }
    // The MCP server answers a call to one before any IPC (it is a process of its own; its source is pinned).
    const mcp = readFileSync(join(process.cwd(), "src/channel/mcp-server.ts"), "utf8");
    const handler = mcp.slice(mcp.indexOf("mcp.setRequestHandler(CallToolRequestSchema"));
    expect(handler.indexOf("if (isCanvasWorkerTool(req.params.name))")).toBeGreaterThan(0);
    expect(handler.indexOf("if (isCanvasWorkerTool(req.params.name))")).toBeLessThan(handler.indexOf("ipcRequest("));
    expect(handler).toContain("return { content: [{ type: \"text\", text: CANVAS_WORKER_EXPERIMENTAL_MESSAGE }], isError: true };");
  });

  it("`agend-agent effect …` and `mod export|propose` still ask the fleet (which answers with the message), never 'Unknown op'", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-2799-cli-")); dirs.push(root);
    const requests: Array<{ op: string; args: unknown }> = [];
    const server: Server = createServer((req, res) => {
      let body = ""; req.on("data", c => { body += c; });
      req.on("end", () => { requests.push(JSON.parse(body)); res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: CANVAS_WORKER_EXPERIMENTAL_MESSAGE })); });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    try {
      // The real client, transpiled to a private module tree; only this loopback stub is reachable (as agent-cli-forwards-1756).
      for (const name of ["agent-cli", "cli-flags", "agent-token-header", "agent-file-read", "instance-names", "web-asset-parts", "bundled-skills", "web-experimental"]) {
        const source = readFileSync(join(process.cwd(), "src", name + ".ts"), "utf8");
        writeFileSync(join(root, name + ".js"), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
      }
      symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
      writeFileSync(join(root, "package.json"), '{"type":"module"}');
      const env = { HOME: root, AGEND_HOME: root, AGEND_PORT: String((server.address() as { port: number }).port), AGEND_INSTANCE_NAME: "worker" };
      const calls = [["effect", "list"], ["effect", "upload", "./fx"], ["effect", "apply", "e".repeat(32)], ["mod", "export", "look", "1.0.0"], ["mod", "propose", "look.agendmod.json"]];
      for (const argv of calls) {
        const r = await promisify(execFile)(process.execPath, [join(root, "agent-cli.js"), ...argv], { cwd: root, env, timeout: 10000 }).then(o => o.stdout + o.stderr, (e: { stdout: string; stderr: string }) => e.stdout + e.stderr);
        expect(r, argv.join(" ")).toContain(CANVAS_WORKER_EXPERIMENTAL_MESSAGE);
        expect(r, argv.join(" ")).not.toContain("Unknown op");
      }
      expect(requests.map(q => [q.op, q.args])).toEqual([["effect-list", {}], ["effect-upload", {}], ["effect-apply", {}], ["mod-export", {}], ["mod-propose", {}]]);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });

  it("the status frame and the page carry no Canvas Worker switch; Settings can't write it", () => {
    const h = rig("web:\n  experimental:\n    canvas_worker: true\ninstances: {}\n");
    const status = h.fm.getUiStatus() as Record<string, unknown>;
    expect(Object.hasOwn(status, "canvas_worker")).toBe(false);
    expect(typeof h.fm.canvasWorkerEnabled).toBe("undefined");
    for (const experimental of [{ canvas_worker: true }, { canvas_worker: false }]) {
      expect(parseWebSettingsBody({ experimental })).toEqual({ error: expect.stringMatching(/removed/) });
    }
    expect(parseWebSettingsBody({ office_levels: false })).toMatchObject({ officeLevels: false });
  });

  it("a person's reset keeps the effect placements on disk (a downgrade finds them); the agent's view never shows them", () => {
    const h = rig("instances:\n  alpha:\n    working_directory: /tmp\n");
    const store = h.fm.themeStore;
    const placed = store.setPlacements("alpha", { effects: [{ id: "e".repeat(32), params: {} }] }, "human", () => null);
    expect(placed.ok, JSON.stringify(placed)).toBe(true);
    expect(h.fm.webAppearance.humanReset("alpha")).toMatchObject({ ok: true });
    expect(store.get("alpha").placements.effects.map((e: { id: string }) => e.id)).toEqual(["e".repeat(32)]);
    expect(Object.hasOwn(h.fm.webAppearance.getTheme("alpha"), "effects")).toBe(false);
  });
});
