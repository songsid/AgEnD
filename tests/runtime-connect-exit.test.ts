import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStopReason } from "../src/runtime-client.js";

const stop = vi.hoisted(() => ({ reason: undefined as RuntimeStopReason | undefined }));
vi.mock("../src/runtime-pane-boot.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/runtime-pane-boot.js")>(), readPaneSystemBootId: async () => "b".repeat(64) }));
vi.mock("../src/runtime-client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/runtime-client.js")>(),
  pairRuntime: vi.fn(),
  rotateRuntimeCredentials: vi.fn(),
  RuntimeClient: class { stopReason = stop.reason; async start() {} async stop() {} async waitUntilStopped() {} },
}));

import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RUNTIME_CONNECT_BAT } from "../src/runtime-connection.js";
import { runtimeMain } from "../src/runtime-cli.js";

const roots: string[] = [], platform = Object.getOwnPropertyDescriptor(process, "platform")!;
function paired(): { home: string; program: string } {
  const root = mkdtempSync(join(tmpdir(), "agend-runtime-exit-")); roots.push(root);
  const home = join(root, "home"), program = join(root, "zip"); mkdirSync(home); mkdirSync(program);
  new RuntimeClientStore(join(home, ".agend-runtime")).saveCredentials({ server: "https://fleet.example.test", machineId: "11111111-2222-3333-4444-555555555555", credential: "a".repeat(64), name: "PC" });
  return { home, program };
}
beforeEach(() => { stop.reason = undefined; Object.defineProperty(process, "platform", { value: "win32" }); vi.spyOn(process.stdout, "write").mockImplementation(() => true); });
afterEach(() => {
  Object.defineProperty(process, "platform", platform); vi.restoreAllMocks();
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test path"); rmSync(root, { recursive: true, force: true }); }
});

describe("connect-agend.bat exit behaviour", () => {
  it.each([["refused", /Settings -> Runtime.*disconnect.*connect-agend\.bat/], ["revoked", /revoked.*disconnect.*connect-agend\.bat/], ["replaced", /one live connection.*Close the other Runtime window/], ["rejected", /rejected a message.*jobs.json.*connect-agend.bat/], ["incompatible", /different versions.*connect-agend.bat/]] as const)(
    "fails with a plain next step when AgEnD ends the connection (%s), so the exit code is non-zero",
    async (kind, next) => {
      stop.reason = { kind }; const { home, program } = paired();
      await expect(runtimeMain(["connect"], { home, programDirectory: program, env: {} })).rejects.toThrow(next);
      await expect(runtimeMain(["run"], { home, programDirectory: program, env: {} })).rejects.toThrow(next);
    });
  it("still returns normally (exit 0) when the person stops it locally", async () => {
    const { home, program } = paired();
    await expect(runtimeMain(["run"], { home, programDirectory: program, env: {} })).resolves.toBeUndefined();
  });
  it("always pauses so the window cannot close before the message is read", () => {
    const lines = RUNTIME_CONNECT_BAT.split("\r\n");
    expect(lines).toContain("pause");
    expect(lines.indexOf("pause")).toBeGreaterThan(lines.findIndex(line => line.includes("runtime-cli.js")));
    expect(lines.indexOf("pause")).toBe(lines.length - 2); // not inside an if-block
    expect(RUNTIME_CONNECT_BAT).toMatch(/AGEND_EXIT=%errorlevel%/);
    expect(lines.indexOf("setlocal")).toBe(1); // the exit-code variable must not leak into a cmd window that ran the bat
    expect(RUNTIME_CONNECT_BAT).not.toMatch(/[^\x00-\x7f]/);
  });
});
