/** Ship fixed Windows prebuilds as code assets. No compiler or native-module install on a Linux user's machine. */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ? resolve(process.argv[2]) : join(root, 'dist/runtime-assets');
const compiled = process.argv[3] ? resolve(process.argv[3]) : join(root, 'dist');
const { RUNTIME_PANE_ASSETS, RUNTIME_PANE_MODULES, PANE_NATIVE_SHA256 } = await import(pathToFileURL(join(compiled, 'runtime-pane-assets.js')).href);
export async function copyRuntimePaneAssets(output, assets = RUNTIME_PANE_ASSETS, source = join(root, 'node_modules')) {
  for (const pkg of assets) {
    const directory = join(source, pkg.name);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw Error(`Unverified runtime pane dependency: ${pkg.name}`);
    for (const file of pkg.files) {
      const input = pkg.name === 'node-pty' && file.startsWith('CONPTY-') ? join(root, 'templates/runtime-assets', 'conpty-'+file.slice(7)) : file === "LICENSE" && pkg.name.startsWith("@xterm/") ? join(root, "templates/runtime-assets/xterm-LICENSE") : join(directory, file);
      const dest = join(output, pkg.name, file), stat = await lstat(input);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw Error(`Unsafe runtime pane asset: ${pkg.name}/${file}`);
      if (pkg.name === 'node-pty' && PANE_NATIVE_SHA256[file]) {
        const bytes = await readFile(input);
        const offset = bytes.readUInt32LE(0x3c), expectedMachine = file.includes('win32-arm64/') ? 0xaa64 : 0x8664;
        if (createHash('sha256').update(bytes).digest('hex') !== PANE_NATIVE_SHA256[file]
          || bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset+4) !== expectedMachine
          || file.endsWith('.node') && !bytes.includes(Buffer.from('napi_register_module_v1'))) throw Error(`Unverified native pane prebuild: ${file}`);
      }
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(input, dest);
    }
  }
}
await copyRuntimePaneAssets(target);
for (const file of RUNTIME_PANE_MODULES.filter(file => file.endsWith('.ps1'))) await copyFile(join(root, 'templates/runtime-assets', file), join(compiled, file));
