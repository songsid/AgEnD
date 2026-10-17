import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { helpOption } from "../src/backend/launch-effort.js";

describe("landing CodeQL production regressions", () => {
  it.each(["--x.y", "--a+b", "--f[o]", String.raw`--dir\name`, "--effort"])("helpOption treats %s as a literal flag", flag => {
    expect(helpOption(`  ${flag} <value> (low, high)`, flag)).toEqual({ listed: true, levels: ["low", "high"] });
  });
  it("regex-shaped flags do not match different advertised names", () => {
    expect(helpOption("  --xAy <value>", "--x.y").listed).toBe(false);
    expect(helpOption("  --aaab <value>", "--a+b").listed).toBe(false);
  });
  it("long Muse status fields and malformed tails settle in a bounded child", () => {
    const program = `import { readFileSync } from 'node:fs';
      import { MuseBackend } from './src/backend/muse.ts';
      const panes = JSON.parse(readFileSync(0, 'utf8'));
      const b = new MuseBackend(process.env.AGEND_HOME);
      console.log(JSON.stringify(panes.map(p => b.isPeriodicRedrawIdlePane(p))));`;
    const header = "──────────────\n❯\n──────────────\n  model", fields = "  · !".repeat(20000);
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
      cwd: process.cwd(), input: JSON.stringify([header + fields, header + fields + " ·", header + " · high", header + " · "]), encoding: "utf8", timeout: 5000,
    });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([true, false, true, false]);
  }, 15000);
  it.each(["app-source", "registry", "stage", "product"])("%s native fixture retains errors privately and sends a generic response", stem => {
    const source = readFileSync(`scripts/manual/effect-trial-${stem}-1629.mts`, "utf8");
    expect(source).toContain('res.end("Internal fixture error")'); expect(source).toContain('console.error(e)');
    expect(source).not.toContain('res.end(String(e))'); expect(source).toContain('assert.equal(await fault.text(),"Internal fixture error")');
  });
});
