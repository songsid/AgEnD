/** Mounted-page lease for the pure queue. A navigation, session or request change retires timers and late results. */
import { useEffect, useRef, useState } from "/assets/app-html.js";
import { createJoinApprovalQueue } from "./hub-join-queue.js";
export function useJoinApproval(options) {
  const latest = useRef(options), live = useRef(false), epoch = useRef(0), holder = useRef(null);
  latest.current = options;
  const [phase, setPhase] = useState(null);
  useEffect(() => {
    live.current = true; epoch.current++; setPhase(null);
    return () => { live.current = false; epoch.current++; holder.current?.queue.cancel(); holder.current = null; };
  }, [options.requestId, options.deadline, options.sessionKey]);
  const run = csrf => {
    const mine = epoch.current, { requestId, deadline, sessionKey } = options;
    const current = () => live.current && mine === epoch.current && latest.current.requestId === requestId
      && latest.current.deadline === deadline && latest.current.sessionKey === sessionKey && latest.current.current?.() !== false;
    if (!current()) return Promise.resolve({ ok: false, code: "retired" });
    if (!holder.current || holder.current.csrf !== csrf) {
      holder.current?.queue.cancel();
      holder.current = { csrf, queue: createJoinApprovalQueue({ requestId, deadline, csrf, current, approve: options.approve,
        onChange: event => { if (current()) setPhase(event.phase); } }) };
    }
    return holder.current.queue.run();
  };
  return { run, queued: phase === "queued", busy: phase === "approving" || phase === "queued" };
}
