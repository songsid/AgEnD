// M-3770 rig: the real pre-flight of the AgEnD package at argv[2], for the target argv[3] (optional). Prints its result.
const [pkg, target] = process.argv.slice(2);
const { runUpdatePreflight } = await import(`${pkg}/dist/update-readiness.js`);
const r = await runUpdatePreflight({ target: target || null });
console.log(JSON.stringify({ class: r.class, pressHere: r.pressHere, checks: r.checks.map(c => (c.ok ? c.id : `${c.id}:${c.code}${c.detail ? JSON.stringify(c.detail) : ""}`)) }));
