/** Sequential guard reversals. Run without browsers/tests editing the same source. Every original is restored in finally. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const out = resolve(process.env.OUT ?? '.artifacts/connection-reversals'); mkdirSync(out, { recursive: true });
const api = 'tests/hub-connection-card-api.test.ts', ui = 'tests/hub-connection-card-ui.test.ts';
const checks = [
  ['api-owner', 'src/settings-api.ts', 'if (!owner?.current()) { json(res, 403', 'if (false) { json(res, 403', api],
  ['api-late-owner', 'src/settings-api.ts', '!owner.current() || gatewayRequestContext(req) || !guestSettingsCaller', 'gatewayRequestContext(req) || !guestSettingsCaller', api],
  ['api-config', 'src/settings-api.ts', 'ctx.fleetConfig !== cfg || ctx.configPath !== configPath || hubMembershipSettings(ctx.getRawFleetConfig())', 'ctx.configPath !== configPath || hubMembershipSettings(ctx.getRawFleetConfig())', api],
  ['api-path', 'src/settings-api.ts', 'ctx.configPath !== configPath || hubMembershipSettings(ctx.getRawFleetConfig())', 'hubMembershipSettings(ctx.getRawFleetConfig())', api],
  ['api-membership', 'src/settings-api.ts', ' || hubMembershipSettings(ctx.getRawFleetConfig()).enabled !== hubMembershipSettings(raw).enabled', '', api],
  ['passive-late-stop', 'src/fleet-manager.ts', 'this.shuttingDown || this.rawFleetConfig !== raw) throw Error("Hub membership changed")', 'this.rawFleetConfig !== raw) throw Error("Hub membership changed")', api],
  ['passive-late-config', 'src/fleet-manager.ts', 'this.shuttingDown || this.rawFleetConfig !== raw) throw Error("Hub membership changed")', 'this.shuttingDown) throw Error("Hub membership changed")', api],
  ['projection-mark', 'src/ui/settings-hub-connection.js', 'r.body?.connectionCardV1 !== true || ', '', ui],
  ['online-state', 'src/ui/settings-hub-connection.js', 'paired && view.enabled && p.link === "online"', 'paired && view.enabled', ui],
  ['late-read', 'src/ui/settings-hub-connection.js', 'if (!life.current.live || life.current.sequence !== seq) return;', 'if (false) return;', ui],
  ['single-write', 'src/ui/settings-hub-connection.js', ' || life.current.busy || error', ' || error', ui],
  ['public-read', 'src/ui/settings-hub-connection.js', 'if (!publicPage && !fallback) void read();', 'if (!fallback) void read();', ui],
  ['exact-review', 'src/ui/settings-hub-connection.js', 'const card = [...document.querySelectorAll(".pending-card[data-pending]")].find(e => e.getAttribute("data-pending") === pending);', 'const card = null;', ui],
  ['retired-rejoin', 'src/ui/settings-hub-company-join.js', 'const retired = embedded && !bound && view?.state === "saved" && view.outcomeKnown;', 'const retired = false;', ui],
  ['retired-status', 'src/ui/settings-hub-company-join.js', '${view && !retired && (!waiting', '${view && (!waiting', ui],
];
const results = [];
for (const [name, path, from, to, test] of checks) {
  const original = readFileSync(path, 'utf8');
  if (original.split(from).length !== 2) throw Error('Ambiguous reversal: ' + name);
  let run;
  try {
    writeFileSync(path, original.replace(from, to));
    run = spawnSync('npx', ['vitest', 'run', test, '--reporter=json', '--outputFile=' + join(out, name + '.json')], { encoding: 'utf8', timeout: 120000 });
    writeFileSync(join(out, name + '.log'), (run.stdout ?? '') + (run.stderr ?? ''));
  } finally { writeFileSync(path, original); }
  const report = JSON.parse(readFileSync(join(out, name + '.json'), 'utf8'));
  const failed = report.numFailedTests;
  // Vitest counts an assertion-failing suite in numFailedTestSuites; require collected assertion rows instead.
  const assertionFailures = report.testResults.flatMap(s => s.assertionResults ?? []).filter(a => a.status === 'failed');
  results.push({ name, path, test, caught: run.status !== 0 && failed > 0 && assertionFailures.length === failed, failed, collected: report.numTotalTests, exit: run.status });
  console.log(name, results.at(-1).caught ? 'CAUGHT' : 'NOT CAUGHT', failed);
}
writeFileSync(join(out, 'receipt.json'), JSON.stringify({ results, restored: true }, null, 2));
if (results.some(r => !r.caught)) process.exitCode = 1;
