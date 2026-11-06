/** Runner-only pre-launch quota proof. A deadline or unknown evidence grants no history exemption. */
import { NativePaneTranscriptReader } from "./runtime-pane-transcript.js";
import type { RuntimePaneLaunch } from "./runtime-pane-protocol.js";
type Reader = Pick<NativePaneTranscriptReader, "quotaReplayHistory" | "close">;
// Optional history never queues work: one shared physical read/cleanup may be outstanding per runner.
// A logical launch deadline cannot release this slot while the filesystem still owns that work.
let readOutstanding = false;
export async function prepareNativePaneQuotaHistory(launch: RuntimePaneLaunch,
  readerFor: () => Reader = () => new NativePaneTranscriptReader("codex", launch.cwd, launch.sessionId!)):
  Promise<Awaited<ReturnType<Reader["quotaReplayHistory"]>>> {
  if (launch.cli !== "codex" || !launch.sessionId || readOutstanding) return null;
  readOutstanding = true;
  let reader: Reader;
  try { reader = readerFor(); } catch { readOutstanding = false; return null; }
  let active = true, timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    try { return await reader.quotaReplayHistory(() => active); }
    finally { try { await reader.close(); } finally { readOutstanding = false; } }
  })();
  try { return await Promise.race([work, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); })]); }
  catch { return null; }
  finally { active = false; clearTimeout(timer); void work.catch(() => {}); }
}
