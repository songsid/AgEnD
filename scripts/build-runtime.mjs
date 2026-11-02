/** Build a portable Windows runtime folder from compiled modules, without AgEnD's Linux native dependencies. */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.argv[2] || '.artifacts/runtime-bundle');
// An isolated compiled directory is accepted for release/CI smoke checks.
const compiled = process.argv[3] ? resolve(process.argv[3]) : join(root, 'dist');
if (output === root || root.startsWith(output + '/') || root.startsWith(output + '\\')) throw new Error('Choose a dedicated runtime bundle directory');
const files = ['runtime-cli.js', 'runtime-client.js', 'runtime-client-store.js', 'windows-cli.js', 'windows-cli-worker.js',
  'windows-cli-providers.js', 'child-process.js', 'windows-native-mcp.js', 'model-catalog-defaults.js', 'atomic-write.js'];
await mkdir(join(output, 'dist'), { recursive: true });
await copyFile(join(root, 'LICENSE'), join(output, 'LICENSE'));
for (const file of files) await copyFile(join(compiled, file), join(output, 'dist', file));
const wsRoot = join(root, 'node_modules/ws');
const ws = JSON.parse(await readFile(join(wsRoot, 'package.json'), 'utf8'));
if (ws.version !== '8.22.0') throw new Error('The standalone runtime must bundle the reviewed ws 8.22.0 version');
await mkdir(join(output, 'node_modules/ws/lib'), { recursive: true });
for (const file of ['package.json', 'index.js', 'wrapper.mjs', 'browser.js', 'LICENSE']) await copyFile(join(wsRoot, file), join(output, 'node_modules/ws', file));
for (const file of await readdir(join(wsRoot, 'lib'))) if (/^[a-z0-9-]+\.js$/.test(file)) await copyFile(join(wsRoot, 'lib', file), join(output, 'node_modules/ws/lib', file));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(output, 'package.json'), JSON.stringify({ name: '@songsid/agend-runtime', version: pkg.version, private: true,
  type: 'module', bin: { 'agend-runtime': './dist/runtime-cli.js' }, engines: { node: '^22.14.0 || ^23.6.0 || >=24' },
  dependencies: { ws: '8.22.0' } }, null, 2) + '\n');
await writeFile(join(output, 'agend-runtime.cmd'), '@echo off\r\nnode.exe "%~dp0dist\\runtime-cli.js" %*\r\n');
await writeFile(join(output, 'README.txt'), `AgEnD native Windows runtime preview\n\nRequires Windows Node.js 22.14+ (or a supported newer release), and each coding CLI installed and signed in under this Windows user.\n\n1. Extract this folder on the Windows computer. No npm install or Linux native packages are needed.\n2. In a Windows terminal run:\n   .\\agend-runtime.cmd connect --server https://your-agend-host\n3. Enter the one-time code from AgEnD Settings, then approve the pending machine there.\n4. In Settings -> Runtime, press Refresh CLI inventory for this computer. Only this explicit detection starts the installed CLIs; connecting or opening a page does not.\n5. Keep this terminal running. Ctrl+C stops it; .\\agend-runtime.cmd run reconnects the stored profile.\n\nUse status to inspect local pairing and journal state. disconnect forgets a stopped local connection; revoke the machine in AgEnD Settings to invalidate its credential centrally.\nThe private profile defaults to %USERPROFILE%\\.agend-runtime. Its machine credential is stored as a private file, not encrypted by this preview. Use your Windows user profile and do not share it. CLI login credentials are never uploaded.\nDo not install this preview as SYSTEM: it uses the logged-in user's CLI login, PATH, workspaces and devices.\nOnly loopback origins may use HTTP; remote servers require HTTPS and valid TLS.\n`);
await writeFile(join(output, 'bundle-manifest.json'), JSON.stringify({ version: pkg.version, modules: files, ws: ws.version, nativeDependencies: [] }, null, 2) + '\n');
process.stdout.write(`Standalone runtime bundle: ${output}\n`);
