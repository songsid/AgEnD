/** Read-only retirement evidence. A stop request or elapsed wait is never proof that the old launch is gone. */
export interface RequestContextLaunchRetirement {
  readonly daemonBootId: string;
  readonly spawnGeneration: number;
  readonly launchFenceEpoch: number;
  readonly windowId: string;
  readonly panePid: number | null;
  retired(): Promise<boolean>;
}
/** Includes the original process group so an MCP child outliving the root still blocks. Never sends a signal. */
export function requestContextProcessGroupGone(pid: number, probe: (pid: number, signal: 0) => unknown = process.kill): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  const absent = (id: number): boolean => {
    try { probe(id, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  return absent(pid) && absent(-pid);
}
