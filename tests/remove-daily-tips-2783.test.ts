/**
 * #2783: daily tips are gone. `defaults.tips` is an accepted, ignored key: an older file loads with no error and no
 * warning, nothing removes the value (a downgrade finds it), and what this version writes stays readable by 2.3.1.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { validateFleetConfig } from "../src/config-validator.js";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2783-")); dirs.push(dir);
  const file = join(dir, "fleet.yaml"); writeFileSync(file, text);
  const fm = new FleetManager(dir) as any; fm.loadConfig(file);
  return { fm, file, read: () => yaml.load(readFileSync(file, "utf8")) as any };
}
function put(fm: any, path: string, body: unknown): Promise<number> {
  return new Promise(resolve => {
    const req = Object.assign(new EventEmitter(), { method: "PUT", destroy() {} });
    let code = 0; const res = { writeHead(status: number) { code = status; }, end() { resolve(code); } };
    expect(handleSettingsRequest(req as never, res as never, new URL(path, "http://localhost"), fm)).toBe(true);
    queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
  });
}

describe("#2783 defaults.tips after the daily tips were removed", () => {
  it("an upgrade loads true, false and a legacy dm with no error and no warning", () => {
    for (const tips of [true, false, "dm"]) {
      const result = validateFleetConfig({ defaults: { tips }, instances: {} });
      expect(result.valid, String(tips)).toBe(true);
      expect(result.warnings.filter(w => w.path.startsWith("defaults.tips")), String(tips)).toEqual([]);
      expect(() => rig(`defaults:\n  tips: ${tips}\ninstances: {}\n`), String(tips)).not.toThrow();
    }
  });

  it("startup leaves true and false exactly as written, with no backup", () => {
    for (const tips of [true, false]) {
      const text = `# mine\ndefaults:\n  tips: ${tips}\ninstances: {}\n`;
      const h = rig(text); h.fm.slimFleetConfigAtStartup();
      expect(readFileSync(h.file, "utf8"), String(tips)).toBe(text);
      expect(existsSync(h.file + ".bak"), String(tips)).toBe(false);
    }
  });

  it("a legacy dm is still rewritten to true at startup, because 2.3.1 refuses dm", () => {
    const h = rig("defaults:\n  tips: dm\ninstances: {}\n"); h.fm.slimFleetConfigAtStartup();
    expect(h.read().defaults.tips).toBe(true);
  });

  it("a Settings save of another default keeps the stored value for a downgrade", async () => {
    const h = rig("defaults:\n  tips: false\ninstances: {}\n");
    expect(await put(h.fm, "/api/settings/fleet/defaults", { reply_triggers: true })).toBe(200);
    expect(h.read().defaults).toMatchObject({ tips: false, reply_triggers: true });
  });

  it("a value older AgEnD would refuse is still refused, so the file stays readable after a downgrade", () => {
    for (const tips of [5, "email", { on: true }]) {
      expect(validateFleetConfig({ defaults: { tips }, instances: {} }).valid, JSON.stringify(tips)).toBe(false);
    }
  });
});
