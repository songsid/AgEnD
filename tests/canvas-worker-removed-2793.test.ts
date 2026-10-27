/**
 * #2793: Canvas Worker effects were removed. A saved `web.experimental.canvas_worker` (true or false) still loads, is
 * left in the file and turns nothing on: no tools, no switch write, no fleet-side permission. Ambient stays.
 * (The MCP menu over a saved true: canvas-worker-mcp-gate-2275; the Settings card: canvas-worker-ui-2275.)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { parseWebSettingsBody } from "../src/web-settings-patch.js";
import { canvasWorkerEnabled, readCanvasWorkerEnabled } from "../src/web-experimental.js";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const CW_TOOLS = ["upload_web_effect", "list_web_effects", "preview_web_effect", "profile_web_effect", "apply_web_effect",
  "remove_web_effect", "delete_web_effect", "export_web_mod", "propose_web_mod"];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2793-")); dirs.push(dir);
  const file = join(dir, "fleet.yaml"); writeFileSync(file, text);
  const fm = new FleetManager(dir) as any; fm.loadConfig(file);
  return { fm, dir, file };
}

describe("#2793 Canvas Worker effects removed", () => {
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

  it("a saved true turns nothing on: the switch, the disk reader and the fleet all say off", () => {
    expect(canvasWorkerEnabled({ experimental: { canvas_worker: true } })).toBe(false);
    const h = rig("web:\n  experimental:\n    canvas_worker: true\ninstances: {}\n");
    expect(readCanvasWorkerEnabled(h.dir)).toBe(false);
    expect(h.fm.canvasWorkerEnabled()).toBe(false);
    for (const tool of CW_TOOLS) expect(h.fm.checkToolPermission("ipc-typed", "worker", tool).allowed, tool).toBe(false);
  });

  it("the switch can't be written: Settings refuses experimental, and the rest of a web save still parses", () => {
    for (const experimental of [{ canvas_worker: true }, { canvas_worker: false }]) {
      expect(parseWebSettingsBody({ experimental })).toEqual({ error: expect.stringMatching(/removed/) });
    }
    expect(parseWebSettingsBody({ office_levels: false })).toMatchObject({ officeLevels: false });
  });
});
