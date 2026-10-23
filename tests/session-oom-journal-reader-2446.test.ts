import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { confirmedCliOom } from "../src/session-oom.js";
import { registerExecutableFixture } from "./support/process-guard.js";
import { selfOomJournal } from "./helpers/self-oom-evidence.js";

let scratch: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); if (scratch) rmSync(scratch, { recursive: true, force: true }); });

it.skipIf(process.platform !== "linux").each(["real report", "4096 tasks"])("collects %s through the actual execFile wrapper beyond the old 256KiB limit", async kind => {
  scratch = mkdtempSync(join(tmpdir(), "agend-kernel-reader-"));
  const report = readFileSync(new URL("./fixtures/oom-2026-10-23/global-oom-0112.txt", import.meta.url), "utf8");
  let messages = report.split("\n").filter(line => line.includes(" kernel: ")).map(line => {
    const [stamp, , ...words] = line.split(" ");
    return { __REALTIME_TIMESTAMP: String(Date.parse(stamp!) * 1000), MESSAGE: words.join(" ").replace(/^kernel: /, "") };
  });
  if (kind === "4096 tasks") {
    messages = selfOomJournal(123, "claude", 1000).split("\n").map(line => JSON.parse(line));
    messages.splice(5, 0, ...Array.from({ length: 4094 }, (_, i) => ({ __REALTIME_TIMESTAMP: "1000000",
      MESSAGE: `[${200000 + i}] 1000 ${200000 + i} 9999 1 1000 0 0 ordinary task` })));
  }
  const rows = messages.map((row, i) => {
    return { __CURSOR: `s=${"a".repeat(32)};i=${i};b=${"b".repeat(32)};m=123456789;t=123456789;x=${"c".repeat(16)}`,
      _BOOT_ID: "b".repeat(32), _MACHINE_ID: "d".repeat(32), _HOSTNAME: "fixture-host",
      __REALTIME_TIMESTAMP: row.__REALTIME_TIMESTAMP, __MONOTONIC_TIMESTAMP: "123456789", _SOURCE_MONOTONIC_TIMESTAMP: "123456788",
      _TRANSPORT: "kernel", SYSLOG_FACILITY: "0", SYSLOG_IDENTIFIER: "kernel", PRIORITY: "6",
      MESSAGE: row.MESSAGE };
  });
  const output = rows.map(row => JSON.stringify(row)).join("\n");
  expect(Buffer.byteLength(output)).toBeGreaterThan(256 * 1024);
  const fixture = join(scratch, "journalctl"), argsFile = join(scratch, "args.json"), dataFile = join(scratch, "journal.jsonl");
  writeFileSync(dataFile, output);
  // Absolute Node interpreter, private executable and data; never runs the host journalctl.
  // Intentionally return all fields even when projection was requested: prove the buffer too.
  writeFileSync(fixture, `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2))); process.stdout.write(fs.readFileSync(${JSON.stringify(dataFile)}));\n`, { mode: 0o700 });
  registerExecutableFixture(fixture);
  vi.stubEnv("PATH", scratch + delimiter + process.env.PATH);
  const at = Math.max(...rows.map(row => Number(row.__REALTIME_TIMESTAMP) / 1000));
  const pid = kind === "real report" ? 1456326 : 123, comm = kind === "real report" ? "apache2" : "claude";
  const result = await confirmedCliOom({ pid, comm, start: "123", observedAt: at - 60_000 }, at, join(scratch, "absent-proc"));
  expect(result).toMatchObject({ pid, attribution: "self", evidence: { victimAnonKiB: kind === "real report" ? 28607512 : 2400 } });
  const args = JSON.parse(readFileSync(argsFile, "utf8"));
  expect(args).toContain("--output-fields=MESSAGE,_TRANSPORT,__REALTIME_TIMESTAMP");
  expect(args).toContain("--lines=8192");
});
