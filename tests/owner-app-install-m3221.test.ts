import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { connectInstallInfo } from "../src/connect/install.js";
import { connectorPrompt } from "../src/ui/shared/connector-prompt.js";
import { handleSettingsRequest } from "../src/settings-api.js";

const strings: Record<string, Record<string, string>> = {};
runInNewContext(readFileSync("src/ui/settings-connector-strings.js", "utf8").replace(/^import[^\n]+\n/, ""), { register: (_name: string, value: typeof strings) => Object.assign(strings, value) });
describe("owner app install prompt", () => {
  it("uses this Fleet home and the exact WSL distro without exposing environment credentials", () => {
    const info = connectInstallInfo("/home/owner/My Fleet", { WSL_DISTRO_NAME: "Ubuntu 24.04", OPENAI_API_KEY: "not-to-be-copied", AGEND_TOKEN: "also-not-to-be-copied" }, "linux");
    expect(info.windows).toEqual({ command: "wsl.exe", args: ["-d", "Ubuntu 24.04", "--", "agend", "connect", "--home", "/home/owner/My Fleet"] });
    expect(JSON.stringify(info)).not.toMatch(/not-to-be-copied|API_KEY|TOKEN/);
    expect(connectInstallInfo("/scratch", {}, "darwin").windows).toBeNull();
    expect(connectInstallInfo("C:\\scratch", {}, "win32").supported).toBe(false);
  });
  it.each(["en", "zh-TW"])("renders parallel %s Claude Code, Codex and generic prompts with exact arguments", locale => {
    const info = connectInstallInfo("/home/owner/Fleet's space", { WSL_DISTRO_NAME: "Ubuntu" }, "linux");
    for (const app of ["claude", "codex", "generic"]) for (const where of ["local", "windows"]) {
      const prompt = connectorPrompt(info, app, where, (key: string) => strings[locale]![key]!);
      expect(prompt).not.toContain("{app}"); expect(prompt).toContain("Fleet's space");
      expect(prompt).toContain(where === "windows" ? "wsl.exe" : "agend");
      expect(prompt).toContain("--home");
      expect(prompt).toContain(app === "codex" ? "[mcp_servers.agend]" : '"mcpServers"');
    }
    expect(Object.keys(strings.en!).sort()).toEqual(Object.keys(strings["zh-TW"]!).sort());
  });
  it("serves only bounded computer metadata, with no credential lookup and no caching", () => {
    let status = 0, headers: any, body: any;
    const req = { method: "GET" }, res = { writeHead: (s: number, h: any) => { status = s; headers = h; }, end: (v: string) => { body = JSON.parse(v); } };
    const ctx = new Proxy({ dataDir: "/owned-fleet" }, { get: (target, key) => { if (key !== "dataDir") throw Error(`Unexpected context read: ${String(key)}`); return target.dataDir; } });
    expect(handleSettingsRequest(req as never, res as never, new URL("http://localhost/api/settings/connector"), ctx as never)).toBe(true);
    expect(status).toBe(200); expect(headers["Cache-Control"]).toBe("no-store");
    expect(body.local).toEqual({ command: "agend", args: ["connect", "--home", "/owned-fleet"] });
  });
});
