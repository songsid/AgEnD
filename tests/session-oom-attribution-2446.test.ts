import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseKernelOoms } from "../src/session-oom.js";

const globalText = readFileSync(new URL("./fixtures/oom-2026-10-23/global-oom-0112.txt", import.meta.url), "utf8");
const memcgText = readFileSync(new URL("./fixtures/oom-2026-10-23/memcg-oom-0156.txt", import.meta.url), "utf8");
function journal(text: string) {
  return text.split("\n").filter(line => line.includes(" kernel: ")).map(line => {
    const [stamp, , ...words] = line.split(" ");
    return JSON.stringify({ _TRANSPORT: "kernel", __REALTIME_TIMESTAMP: String(Date.parse(stamp!) * 1000), MESSAGE: words.join(" ").replace(/^kernel: /, "") });
  }).join("\n");
}
/** Reconstructed collateral CLI: actual 10-23 table/RAM, replace victim with a small existing node task. */
function collateral() {
  const line = globalText.split("\n").find(line => /\[\s*\d+\].* node$/.test(line))!;
  const row = /\[\s*(\d+)\]\s+\d+\s+\d+\s+\d+\s+(\d+)/.exec(line)!;
  const pid = row[1]!, rssKiB = Number(row[2]) * 4;
  return globalText.replace(/task=apache2,pid=1456326/, `task=node,pid=${pid}`)
    .replace(/Killed process 1456326 \(apache2\).*$/m, `Killed process ${pid} (node) total-vm:999999kB, anon-rss:${rssKiB}kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:1024kB oom_score_adj:0`);
}

describe("OOM victim is not OOM cause", () => {
  it("retains the real global apache2 report and duplicate Mem-Info blocks as self-dominance evidence", () => {
    const [r] = parseKernelOoms(journal(globalText));
    expect(r).toMatchObject({ pid: 1456326, comm: "apache2", attribution: "self", evidence: { ramPages: 8388255, victimAnonKiB: 28607512 } });
  });
  it("a small CLI substituted into the real table is collateral while the 28.6GB apache2 stays present", () => {
    const [r] = parseKernelOoms(journal(collateral()));
    expect(r).toMatchObject({ comm: "node", attribution: "collateral" });
    expect(r?.evidence).toBeUndefined();
  });
  it("the real capped tsc memcg kill cannot prove an individual instance caused it", () => {
    expect(parseKernelOoms(journal(memcgText))[0]).toMatchObject({ comm: "tsc", attribution: "unknown" });
  });
  it.each([
    ["missing table", globalText.replace(/.*Tasks state.*\n/, "")],
    ["missing RAM", globalText.replace(/^.*pages RAM.*\n/gm, "")],
    ["truncated beginning", globalText.slice(globalText.indexOf("Tasks state"))],
    ["missing context", globalText.replace(/^.*oom-kill:.*\n/gm, "")],
    ["mismatched context", globalText.replace("task=apache2,pid=1456326", "task=apache2,pid=999")],
  ])("%s is not self proof", (_, text) => {
    expect(parseKernelOoms(journal(text))[0]?.attribution).not.toBe("self");
  });
});

import { selfEvidence, selfOomJournal } from "./helpers/self-oom-evidence.js";
import { selfOomEvidence } from "../src/session-oom.js";
it("synthetic dominant CLI provides self proof, including 16/64KiB page kernels", () => {
  const [r] = parseKernelOoms(selfOomJournal(123, "claude", 1000));
  expect(r).toMatchObject({ attribution: "self", evidence: selfEvidence() });
  for (const pageKiB of [4, 16, 64]) expect(selfOomEvidence({ ...selfEvidence(), victimAnonKiB: 600 * pageKiB, victimTotalRssKiB: 600 * pageKiB })).toBe(true);
});
it("pins both dominance thresholds, anonymous rather than total RSS, and sane units", () => {
  expect(selfOomEvidence({ ...selfEvidence(), victimRssPages: 500, victimTotalRssKiB: 2000, victimAnonKiB: 2000, largestOtherRssPages: 250 })).toBe(true);
  expect(selfOomEvidence({ ...selfEvidence(), victimRssPages: 499, victimTotalRssKiB: 1996, victimAnonKiB: 1996 })).toBe(false);
  expect(selfOomEvidence({ ...selfEvidence(), largestOtherRssPages: 301 })).toBe(false);
  expect(selfOomEvidence({ ...selfEvidence(), largestOtherRssPages: 300 })).toBe(true);
  expect(selfOomEvidence({ ...selfEvidence(), victimAnonKiB: 1200 })).toBe(false);
  expect(selfOomEvidence({ ...selfEvidence(), victimTotalRssKiB: 2400000 })).toBe(false);
});
it("another report or malformed task row cannot supply a missing hog", () => {
  const self = selfOomJournal(123, "claude", 1000);
  expect(parseKernelOoms(self.replace('"MESSAGE":"oom-kill:', '"MESSAGE":"another invoked oom-killer:')).at(-1)?.attribution).toBe("unknown");
  const lines = self.split("\n"); lines.splice(5, 0, "damaged json");
  expect(parseKernelOoms(lines.join("\n"))[0]?.attribution).toBe("unknown");
});
