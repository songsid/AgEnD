import type { SelfOomEvidence } from "../../src/session-oom.js";
/** Synthetic dominance, never real credentials or a real host allocation. */
export const selfEvidence = (): SelfOomEvidence => ({ policy: 2, scope: "global", ramPages: 1000,
  victimRssPages: 600, victimAnonKiB: 2400, victimTotalRssKiB: 2400, largestOtherRssPages: 100 });
export function selfOomJournal(pid: number, comm: string, at: number): string {
  return [
    `${comm} invoked oom-killer: gfp_mask=0x0, order=0, oom_score_adj=0`, "1000 pages RAM",
    "Tasks state (memory values in pages):", "[  pid  ]   uid  tgid total_vm      rss pgtables_bytes swapents oom_score_adj name",
    `[${pid}] 1000 ${pid} 9999 600 1000 0 0 ${comm}`, "[99999] 0 99999 9999 100 1000 0 0 sibling",
    `oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/fleet,task=${comm},pid=${pid},uid=1000`,
    `Out of memory: Killed process ${pid} (${comm}) total-vm:9999kB, anon-rss:2400kB, file-rss:0kB, shmem-rss:0kB`,
  ].map(MESSAGE => JSON.stringify({ _TRANSPORT: "kernel", __REALTIME_TIMESTAMP: String(at * 1000), MESSAGE })).join("\n");
}
export function collateralOomJournal(pid: number, comm: string, at: number): string {
  return selfOomJournal(pid, comm, at).replace(`9999 600 1000 0 0 ${comm}`, `9999 60 1000 0 0 ${comm}`)
    .replace("9999 100 1000 0 0 sibling", "9999 600 1000 0 0 sibling").replace("anon-rss:2400kB", "anon-rss:240kB");
}
