import { TmuxManager } from "./tmux-manager.js";
import type { GeneralHostOwner } from "./general-binding.js";

/** Read-only exit barrier after the existing owned stop. Missing/unreadable evidence is never exit. */
export async function confirmGeneralHostExit(owner: GeneralHostOwner, session: string,
  deps: { windows(): Promise<Array<{ id: string }>>; probe(pid: number): unknown }
    = { windows: () => TmuxManager.listWindows(session), probe: (pid: number) => process.kill(-pid, 0) }): Promise<boolean> {
  if (!/^@\d+$/.test(owner.windowId) || !Number.isSafeInteger(owner.pid) || owner.pid <= 1) return false;
  let windows: Array<{ id: string }>;
  try { windows = await deps.windows(); }
  catch (err) {
    const detail = String((err as { stderr?: unknown })?.stderr ?? (err as Error).message ?? "");
    if (!/can't find session|no server running/.test(detail)) return false;
    windows = [];
  }
  if (windows.some(row => row.id === owner.windowId)) return false;
  try { deps.probe(owner.pid); return false; }
  catch (err) { return (err as NodeJS.ErrnoException).code === "ESRCH"; }
}
