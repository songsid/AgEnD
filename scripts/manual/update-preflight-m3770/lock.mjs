// M-3770 rig: the home lock between real processes. `hold <pkg> <home> <prefix>`: take it as `agend update` would and
// keep it (until killed). `start <pkg> <home> <ownPrefix>`: a fleet start's admission, printed (released at once).
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const [mode, pkg, home, prefix] = process.argv.slice(2);
const { acquireHomeUpdateLock, admitFleetStart } = await import(`${pkg}/dist/home-update-lock.js`);
const a = createRequire(`${pkg}/package.json`)("./launcher/install-admission.cjs");
const deps = { pid: process.pid, processStart: a.processStart, startTicks: a.startTicks, bootId: a.bootId,
  newToken: () => randomBytes(16).toString("hex"), now: () => new Date(), log: m => console.log(m) };
if (mode === "hold") {
  const lock = acquireHomeUpdateLock(home, { spec: "@songsid/agend@rig", installPrefix: prefix }, deps);
  console.log(JSON.stringify({ held: lock.ok, pid: process.pid, ...(lock.ok ? {} : { reason: lock.reason }) }));
  if (lock.ok) setInterval(() => {}, 1 << 30);
} else {
  const r = admitFleetStart(home, prefix, deps);
  console.log(JSON.stringify(r.ok ? { admitted: true, ...(r.note ? { note: r.note } : {}) } : { admitted: false, reason: r.reason }));
  if (r.ok) r.release();
}
