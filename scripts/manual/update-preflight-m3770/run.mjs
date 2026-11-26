// M-3770 rig: the real pre-flight of the AgEnD package at argv[2], for the target argv[3] (optional), on the AgEnD home
// argv[4]. This process stands in for that home's fleet: it writes the home's fleet.lock with its own pid first (the
// way a fleet holds it), so P2 can prove "this home's live fleet is this process". Prints the result.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [pkg, target, home] = process.argv.slice(2);
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "fleet.lock"), JSON.stringify({ pid: process.pid, nonce: "rig", createdAt: new Date().toISOString() }));
const { defaultReadinessDeps, runUpdatePreflight } = await import(`${pkg}/dist/update-readiness.js`);
const r = await runUpdatePreflight({ target: target || null }, { ...defaultReadinessDeps(), home });
console.log(JSON.stringify({ class: r.class, pressHere: r.pressHere, checks: r.checks.map(c => (c.ok ? c.id : `${c.id}:${c.code}${c.detail ? JSON.stringify(c.detail) : ""}`)) }));
