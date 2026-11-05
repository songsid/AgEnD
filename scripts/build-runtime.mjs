/** Build a portable Windows runtime folder from compiled modules, without AgEnD's Linux native dependencies. */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.argv[2] || '.artifacts/runtime-bundle');
// An isolated compiled directory is accepted for release/CI smoke checks.
const compiled = process.argv[3] ? resolve(process.argv[3]) : join(root, 'dist');
const { GENERAL_KNOWLEDGE_FILES } = await import(pathToFileURL(join(compiled, 'general-role.js')).href);
const { RUNTIME_PANE_ASSETS } = await import(pathToFileURL(join(compiled, 'runtime-pane-assets.js')).href);
const { RUNTIME_CONNECT_BAT, RUNTIME_SERVER_FILE, runtimeServerOrigin } = await import(pathToFileURL(join(compiled, 'runtime-connection.js')).href);
const serverOrigin = process.argv[4] === undefined ? undefined : runtimeServerOrigin(process.argv[4]);
if (output === root || root.startsWith(output + '/') || root.startsWith(output + '\\')) throw new Error('Choose a dedicated runtime bundle directory');
const { RUNTIME_BUNDLE_MODULES: files, runtimeCodeBuildId } = await import(pathToFileURL(join(compiled, 'runtime-build-info.js')).href);
await mkdir(join(output, 'dist'), { recursive: true });
await copyFile(join(root, 'LICENSE'), join(output, 'LICENSE'));
for (const file of files) await copyFile(file.endsWith('.ps1') ? join(root, 'templates/runtime-assets', file) : join(compiled, file), join(output, 'dist', file));
for (const file of GENERAL_KNOWLEDGE_FILES) { const dest = join(output, 'dist/general-knowledge', file); await mkdir(dirname(dest), { recursive: true }); await copyFile(join(compiled, 'general-knowledge', file), dest); }
const wsRoot = join(root, 'node_modules/ws');
const ws = JSON.parse(await readFile(join(wsRoot, 'package.json'), 'utf8'));
if (ws.version !== '8.22.0') throw new Error('The standalone runtime must bundle the reviewed ws 8.22.0 version');
await mkdir(join(output, 'node_modules/ws/lib'), { recursive: true });
for (const file of ['package.json', 'index.js', 'wrapper.mjs', 'browser.js', 'LICENSE']) await copyFile(join(wsRoot, file), join(output, 'node_modules/ws', file));
for (const file of await readdir(join(wsRoot, 'lib'))) if (/^[a-z0-9-]+\.js$/.test(file)) await copyFile(join(wsRoot, 'lib', file), join(output, 'node_modules/ws/lib', file));
execFileSync(process.execPath, [join(root, 'scripts/build-runtime-assets.mjs'), join(output, 'node_modules'), compiled], { stdio: 'pipe' });
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(output, 'package.json'), JSON.stringify({ name: '@songsid/agend-runtime', version: pkg.version, private: true,
  type: 'module', bin: { 'agend-runtime': './dist/runtime-cli.js' }, engines: { node: '^22.14.0 || ^23.6.0 || >=24' },
  dependencies: { ws: '8.22.0', ...Object.fromEntries(RUNTIME_PANE_ASSETS.map(pkg => [pkg.name, pkg.version])) } }, null, 2) + '\n');
await writeFile(join(output,'connect-agend.bat'),RUNTIME_CONNECT_BAT);
if(serverOrigin) await writeFile(join(output,RUNTIME_SERVER_FILE),JSON.stringify({server:serverOrigin},null,2)+'\n');
else await unlink(join(output,RUNTIME_SERVER_FILE)).catch(error=>{if(error.code !== 'ENOENT')throw error;});
await writeFile(join(output, 'agend-runtime.cmd'), '@echo off\r\nnode.exe "%~dp0dist\\runtime-cli.js" %*\r\n');
await writeFile(join(output, 'README.txt'), `AgEnD native Windows runtime preview\n\nRequires Windows Node.js 22.14+ (or a supported newer release), and each coding CLI installed and signed in under this Windows user.\n\n1. Extract this folder on the Windows computer. No npm install or Linux native packages are needed. If agend-server.json is included, double-click connect-agend.bat; it uses that AgEnD address and asks for a pairing code only for a new profile.\n2. In a Windows terminal run:\n   .\\agend-runtime.cmd connect --server https://your-agend-host\n3. Enter the one-time code from AgEnD Settings, compare the pairing fingerprint on both screens, then approve the pending machine there.\n4. In Settings -> Runtime, press Refresh CLI inventory for this computer. Only this explicit detection starts the installed CLIs; connecting or opening a page does not.\n5. Keep this terminal running. Ctrl+C stops it; .\\agend-runtime.cmd run reconnects the stored profile. If AgEnD ends the connection (the computer was revoked or is not recognised, another Runtime took over the same pairing, or a message was rejected), the window stays open and explains the reason and next step. If it says this profile still holds jobs from a different AgEnD server, delete jobs.json in the profile folder (after checking no CLI it started is still running) or disconnect and pair again. If pairing itself reports an unfinished job from another pairing, delete jobs.json the same way and pair again.\n\nStop the runtime before using rotate to replace its machine credential without pairing again, then use run to reconnect. A saved interrupted rotation is completed before run connects.\nUse --version to inspect the installed Runtime version, code Build ID and supported protocol.\nUse status to inspect local pairing and journal state. disconnect forgets a stopped local connection; revoke the machine in AgEnD Settings to invalidate its credential centrally.\nUsing one computer with more than one AgEnD server: connect-agend.bat keeps the existing pairing and, when this folder's server differs from the default profile's, pairs a separate profile under %USERPROFILE%\\.agend-runtime\\profiles\\<host>-<port>. The same bat and run/status/rotate/disconnect run from this folder find it again. Use --profile DIRECTORY (or AGEND_RUNTIME_HOME) to choose a profile yourself; that always wins. After connecting with --profile, pass the same --profile to run, status, rotate and disconnect.\nThe private profile defaults to %USERPROFILE%\\.agend-runtime. Its machine credential is stored as a private file, not encrypted by this preview. Use your Windows user profile and do not share it. CLI login credentials are never uploaded.\nDo not install this preview as SYSTEM: it uses the logged-in user's CLI login, PATH, workspaces and devices.\nOnly loopback origins may use HTTP; remote servers require HTTPS and valid TLS.\n`);
const manifestFiles = [...files.map(file => 'dist/'+file), ...GENERAL_KNOWLEDGE_FILES.map(file => 'dist/general-knowledge/'+file), 'LICENSE', 'package.json', 'agend-runtime.cmd', 'connect-agend.bat', ...(serverOrigin ? [RUNTIME_SERVER_FILE] : []), 'README.txt',
  ...['package.json', 'index.js', 'wrapper.mjs', 'browser.js', 'LICENSE', ...(await readdir(join(wsRoot,'lib'))).filter(file=>/^[a-z0-9-]+\.js$/.test(file)).map(file=>'lib/'+file)].map(file=>'node_modules/ws/'+file),
  ...RUNTIME_PANE_ASSETS.flatMap(pkg=>pkg.files.map(file=>'node_modules/'+pkg.name+'/'+file))];
const hashes = Object.fromEntries(await Promise.all(manifestFiles.map(async file=>[file,createHash('sha256').update(await readFile(join(output,file))).digest('hex')])));
await writeFile(join(output, 'bundle-manifest.json'), JSON.stringify({ version: pkg.version, buildId: runtimeCodeBuildId(pkg.version, await Promise.all(files.map(async file=>[file,await readFile(join(output,'dist',file))]))), modules: files, ws: ws.version,
  nativeDependencies: [{ name: 'node-pty', version: '1.1.0', platforms: ['win32-x64', 'win32-arm64'], backend: 'ConPTY' }], sha256: hashes }, null, 2) + '\n');
process.stdout.write(`Standalone runtime bundle: ${output}\n`);
