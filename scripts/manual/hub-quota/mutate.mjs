// Compiles each semantic reversal before requiring a targeted assertion failure; always restores the source.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const member = "src/hub/member/quota.ts", server = "src/hub/quota.ts";
const cases = [
  ["near-boundary", member, "m.used! >= 80", "m.used! > 80", "tests/hub-quota.test.ts"],
  ["exhausted-boundary", member, "m.used! >= 100", "m.used! > 100", "tests/hub-quota.test.ts"],
  ["latest-reset", member, "Math.min(...resets)", "Math.max(...resets)", "tests/hub-quota.test.ts"],
  ["unrounded-reset", member, "Math.round(Math.min(...resets) / ROUND_MS) * ROUND_MS", "Math.min(...resets)", "tests/hub-quota.test.ts"],
  ["trust-stale", member, "&& !provider.stale", "&& true", "tests/hub-quota.test.ts"],
  ["ignore-capability", member, "!captured.features?.has(HUB_QUOTA_CAPABILITY)", "false", "tests/hub-quota.test.ts"],
  ["repeat-same-band", member, "if (sent.get(entry.exposureId) === quota.band) continue;", "if (false) continue;", "tests/hub-quota.test.ts"],
  ["unlimited-updates", member, "if (at >= lastRead && at - lastRead < HUB_QUOTA_INTERVAL_MS) return;", "if (false) return;", "tests/hub-quota.test.ts"],
  ["ignore-owner", server, "if (!e || e.owner !== owner)", "if (!e)", "tests/hub-quota-server.test.ts"],
  ["ignore-hide", server, "if (setting?.visible === 0) return {};", "if (false) return {};", "tests/hub-quota-server.test.ts"],
  ["wrong-login", "src/fleet-manager.ts", "snapshot.providers.find(p => p.id === id)", 'snapshot.providers.find(p => p.id === "codex")', "tests/hub-quota-fleet.test.ts"],
  ["drop-jittered-change", server, "try { this.receive(input, link); } catch", "try { /* lost */ } catch", "tests/hub-quota-server.test.ts"],
  ["allow-extra-usage-fields", "src/hub/protocol.ts", 'z.strictObject({ band: z.enum(["available", "near_limit", "unknown"]) })', 'z.object({ band: z.enum(["available", "near_limit", "unknown"]) })', "tests/hub-quota.test.ts"],
  ["drop-access-fallback", "src/ui/hub-quota.js", 'if (!quota || quota.band === "available") return fallback;', 'if (!quota || quota.band === "available") return null;', "tests/hub-quota-ui.test.ts"],
];
const selected = process.argv.length > 2 ? cases.filter(([name]) => process.argv.slice(2).includes(name)) : cases;
if (!selected.length) throw Error("No matching mutation names");
const out = ".artifacts/hub-quota-mutations"; mkdirSync(out, { recursive: true });
const results = [];
for (const [name, path, before, after, suite] of selected) {
  const original = readFileSync(path, "utf8");
  if (original.split(before).length !== 2) throw Error(`${name}: expected exactly one target`);
  try {
    writeFileSync(path, original.replace(before, after));
    const compile = spawnSync("npx", ["--no-install", "tsc", "--noEmit", "--pretty", "false"], { encoding: "utf8", timeout: 120_000 });
    writeFileSync(join(out, `${name}.compile.log`), (compile.stdout ?? "") + (compile.stderr ?? ""));
    let status = "INVALID_BUILD";
    if (!compile.error && compile.status === 0) {
      const test = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", suite, "--maxWorkers=1"], { encoding: "utf8", timeout: 60_000 });
      const log = (test.stdout ?? "") + (test.stderr ?? ""); writeFileSync(join(out, `${name}.test.log`), log);
      status = !test.error && test.status !== null && test.status !== 0 && /AssertionError/.test(log) && /FAIL /.test(log)
        && !/Transform failed|No test files found/.test(log) ? "KILLED" : "SURVIVED_OR_INVALID";
    }
    results.push({ name, status }); console.log(JSON.stringify(results.at(-1)));
  } finally { writeFileSync(path, original); writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2) + "\n"); }
}
if (results.length !== selected.length || results.some(r => r.status !== "KILLED")) process.exitCode = 1;
