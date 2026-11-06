/** Runner-only pre-launch quota proof. A deadline or unknown evidence grants no history exemption. */
import { NativePaneTranscriptReader } from "./runtime-pane-transcript.js";
import type { RuntimePaneLaunch } from "./runtime-pane-protocol.js";
type Reader = Pick<NativePaneTranscriptReader, "quotaReplayHistory" | "close">;
export async function prepareNativePaneQuotaHistory(launch: RuntimePaneLaunch,
  readerFor: () => Reader = () => new NativePaneTranscriptReader("codex", launch.cwd, launch.sessionId!)):
  Promise<Awaited<ReturnType<Reader["quotaReplayHistory"]>>> {
  if (launch.cli !== "codex" || !launch.sessionId) return null;
  const reader = readerFor(); let active = true, timer: ReturnType<typeof setTimeout> | undefined;
  const read = reader.quotaReplayHistory(() => active);
  try { return await Promise.race([read, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); })]); }
  catch { return null; }
  finally { active = false; clearTimeout(timer); void read.finally(() => reader.close()).catch(() => {}); }
}
