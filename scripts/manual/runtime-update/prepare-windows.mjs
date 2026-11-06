/** After npm run build: node scripts/manual/runtime-update/prepare-windows.mjs <private-output>. No native process or account. */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), output = resolve(process.argv[2]);
if (output === root || root.startsWith(output + '/')) throw Error('Choose a separate scratch output');
const { createRuntimeBundle } = await import(pathToFileURL(join(root, 'dist/runtime-bundle.js')));
mkdirSync(output, { recursive: true, mode: 0o700 });
const identity = [];
for (const [label, version] of [['a', '2.3.5-rehearsal.1'], ['b', '2.3.5-rehearsal.2']]) {
  const bundle = createRuntimeBundle({ moduleDirectory: join(root, 'dist'), wsDirectory: join(root, 'node_modules/ws'),
    licensePath: join(root, 'LICENSE'), packageVersion: version });
  writeFileSync(join(output, `${label}.zip`), bundle.bytes, { mode: 0o600 });
  identity.push({ label, version, sha256: bundle.sha256, bytes: bundle.bytes.length });
}
writeFileSync(join(output, 'inputs.json'), JSON.stringify(identity, null, 2), { mode: 0o600 });
cpSync(join(root, 'node_modules/ws'), join(output, 'ws'), { recursive: true });
cpSync(join(root, 'templates/runtime-install/install.ps1'), join(output, 'install.ps1'));
cpSync(join(root, 'src/ui/runtime-commands.js'), join(output, 'runtime-commands.mjs'));
cpSync(join(root, 'scripts/manual/runtime-update/accept-windows.mjs'), join(output, 'accept-windows.mjs'));
// Record source inputs, without recording a host, account, server address or profile.
const { createHash } = await import('node:crypto');
writeFileSync(join(output, 'source-hashes.json'), JSON.stringify(Object.fromEntries([
  'dist/runtime-update-controller.js', 'dist/runtime-client.js', 'templates/runtime-install/install.ps1',
  'scripts/manual/runtime-update/accept-windows.mjs', 'src/ui/runtime-commands.js',
].map(name => [name, createHash('sha256').update(readFileSync(join(root, name))).digest('hex')])), null, 2), { mode: 0o600 });
console.log(JSON.stringify({ prepared: true, artifacts: identity }));
