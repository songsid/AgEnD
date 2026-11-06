// Every reversal must compile and fail an assertion; temporary source changes are always restored.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const preview = "src/hub/preview.ts", parent = "src/ui/shared/preview.js", shim = "src/web-preview.ts", e = "tests/hub-preview.test.ts";
const cases = [
  ["same-origin", preview, "origin.origin === dashboardOrigin ||", "false ||", e],
  ["ignore-reload", preview, 'return Object.prototype.hasOwnProperty.call(value, "preview_port") ? JSON.stringify(["port", value.preview_port]) : "off";', 'return "off";', e],
  ["ignore-path", preview, 'req.url !== "/frame"', "false", e],
  ["ignore-host", preview, "req.headers.host.toLowerCase() !== host", "false", e],
  ["ignore-fence", preview, "if (!current())", "if (false)", e],
  ["read-cookie", preview, "res.writeHead(200, response.headers);", "void req.headers.cookie; res.writeHead(200, response.headers);", e],
  ["same-origin-sandbox", shim, '"sandbox allow-scripts",', '"sandbox allow-scripts allow-same-origin",', e],
  ["owner-ineligible", "src/hub/rooms.ts", 'if (!ownerId || !(await this.core.eligible(personFromString(ownerId)))) throw new HubProtocolError("revoked");\n    await ctx.current();\n    return { asker, room };', 'if (!ownerId) throw new HubProtocolError("revoked");\n    await ctx.current();\n    return { asker, room };', e],
  ["wrong-room-file", "src/hub/rooms.ts", "row.room_id !== roomId ||", "false ||", e],
  ["parent-boot", parent, "if (d.boot !== cfg.boot)", "if (false)", "tests/web-preview-card-1306.test.ts"],
  ["parent-channel", parent, "if (d.ch !== card.ch || !card.rendered) return;", "if (!card.rendered) return;", "tests/preview-errors-chip-2911.test.ts"],
  ["parent-single-post", parent, 'if (d.ch !== null || typeof d.boot !== "string" || card.rendered) return;', 'if (d.ch !== null || typeof d.boot !== "string") return;', "tests/web-preview-card-1306.test.ts"],
  ["shim-source", shim, "done || e.source !== window.parent ||", "done || false ||", "tests/web-preview-1306.test.ts"],
  ["shim-origin", shim, "ORIGINS.indexOf(e.origin) < 0", "false", "tests/web-preview-1306.test.ts"],
  ["shim-single-render", shim, "if (done || e.source", "if (false || e.source", "tests/web-preview-1306.test.ts"],
];
const selected = process.argv.length > 2 ? cases.filter(([name]) => process.argv.slice(2).includes(name)) : cases;
if (!selected.length) throw Error("No matching mutation names");
const out = ".artifacts/hub-preview-mutations"; mkdirSync(out, { recursive: true });
const summary = join(out, "results.json");
const previous = process.argv.length > 2 && existsSync(summary) ? JSON.parse(readFileSync(summary, "utf8")) : [];
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
  } finally {
    writeFileSync(path, original);
    const merged = new Map(previous.map(r => [r.name, r])); for (const result of results) merged.set(result.name, result);
    writeFileSync(summary, JSON.stringify([...merged.values()], null, 2) + "\n");
  }
}
if (results.length !== selected.length || results.some(r => r.status !== "KILLED")) process.exitCode = 1;
