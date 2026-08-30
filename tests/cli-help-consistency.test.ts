import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("CLI help language and descriptions", () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "agend-help-"));
    writeFileSync(join(dataDir, "fleet.yaml"), "defaults:\n  locale: zh-TW\ninstances: {}\n");
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const help = (...args: string[]): string => execFileSync(
    join(process.cwd(), "node_modules", ".bin", "tsx"),
    [join(process.cwd(), "src", "cli.ts"), ...args, "--help"],
    {
      encoding: "utf8",
      env: { ...process.env, AGEND_HOME: dataDir },
    },
  );

  it("keeps top-level command help in English even when the fleet locale is zh-TW", () => {
    const output = help();

    expect(output).toContain("Install the AgEnD system service and start it by default");
    expect(output).toContain("Remove the AgEnD system service");
    expect(output).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("documents the full doctor diagnostic and the optional MCP deep check", () => {
    const output = help("doctor");

    expect(output).toContain("backends, tmux, service, D-Bus, fleet, IPC, and network");
    expect(output).toContain("Optional deep check: mcp (omit for the full fleet diagnostic)");
    expect(output).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("keeps localized runtime behavior out of uninstall option help", () => {
    const output = help("uninstall");

    expect(output).toContain("Skip confirmation (for CI/automation)");
    expect(output).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
