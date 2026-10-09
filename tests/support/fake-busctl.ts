/**
 * A `busctl` stand-in for built-CLI tests (#1449): answers the D-Bus reads the update's service activation makes, as
 * a reloaded systemd would report the unit file at `unitPath` — its single ExecStart (argv split on spaces, which is
 * all these fixtures use), its Environment= lines, no EnvironmentFile/PassEnvironment/UnsetEnvironment, an empty
 * manager environment, NeedDaemonReload=false. Every call is appended to `log`. It is a node script, so the
 * fixture's PATH must hold `node`.
 */
export function fakeBusctl(log: string, unitPath: string): string {
  return [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const line = process.argv.slice(2).join(' ');",
    `fs.appendFileSync(${JSON.stringify(log)}, 'busctl ' + line + '\\n');`,
    `const text = fs.existsSync(${JSON.stringify(unitPath)}) ? fs.readFileSync(${JSON.stringify(unitPath)}, 'utf8') : '';`,
    "const exec = ((/^ExecStart=(.*)$/m.exec(text) || [])[1] || '').trim();",
    "const env = [...text.matchAll(/^Environment=(.*)$/mg)].map(m => m[1].trim());",
    "const out = (type, data) => process.stdout.write(JSON.stringify({ type, data }) + '\\n');",
    "if (/LoadUnit/.test(line)) out('o', ['/org/freedesktop/systemd1/unit/fake']);",
    "else if (/Service ExecStart$/.test(line)) { const argv = exec.split(/\\s+/); out('a(sasbttttuii)', exec ? [[argv[0], argv, false, 0, 0, 0, 0, 0, 0, 0]] : []); }",
    "else if (/Service EnvironmentFiles$/.test(line)) out('a(sb)', []);",
    "else if (/Service (PassEnvironment|UnsetEnvironment)$/.test(line)) out('as', []);",
    "else if (/Service Environment$/.test(line)) out('as', env);",
    "else if (/Manager Environment$/.test(line)) out('as', []);",
    "else if (/NeedDaemonReload$/.test(line)) out('b', false);",
    "else process.exit(1);",
  ].join("\n") + "\n";
}
