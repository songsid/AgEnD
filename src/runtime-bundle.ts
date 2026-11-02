/** Build the downloadable Windows runtime from this installation's fixed, code-only module set. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_BUNDLE_MODULES = Object.freeze([
  "runtime-cli.js", "runtime-client.js", "runtime-client-store.js", "windows-cli.js", "windows-cli-worker.js",
  "windows-cli-providers.js", "child-process.js", "windows-native-mcp.js", "model-catalog-defaults.js", "atomic-write.js",
]);
const WS_FILES = Object.freeze([
  "package.json", "index.js", "wrapper.mjs", "browser.js", "LICENSE",
  "lib/buffer-util.js", "lib/constants.js", "lib/event-target.js", "lib/extension.js", "lib/limiter.js",
  "lib/permessage-deflate.js", "lib/receiver.js", "lib/sender.js", "lib/stream.js", "lib/subprotocol.js",
  "lib/validation.js", "lib/websocket-server.js", "lib/websocket.js",
]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const ROOT = "agend-runtime/";
const CMD = '@echo off\r\nnode.exe "%~dp0dist\\runtime-cli.js" %*\r\n';
const README = `AgEnD native Windows runtime preview

Requires a supported Windows Node.js version and each coding CLI installed and signed in under this Windows user.

1. Extract this folder on the Windows computer. No npm install or Linux native packages are needed.
2. In a Windows terminal run:
   .\\agend-runtime.cmd connect --server https://your-agend-host
3. Enter the one-time code from AgEnD Settings, then approve the pending machine there.
4. Keep this terminal running. Ctrl+C stops it; .\\agend-runtime.cmd run reconnects the stored profile.

Use status to inspect local pairing and journal state. disconnect forgets a stopped local connection; revoke the machine in AgEnD Settings to invalidate its credential centrally.
The private profile defaults to %USERPROFILE%\\.agend-runtime. Its machine credential is stored as a private file, not encrypted by this preview. Use your Windows user profile and do not share it. CLI login credentials are never uploaded.
Do not install this preview as SYSTEM: it uses the logged-in user's CLI login, PATH, workspaces and devices.
Only loopback origins may use HTTP; remote servers require HTTPS and valid TLS.
`;

export interface RuntimeBundleOptions {
  /** Explicit locations make packaging tests independent of the repository's generated dist folder. */
  moduleDirectory?: string;
  wsDirectory?: string;
  packageVersion?: string;
  licensePath?: string;
}
export interface RuntimeBundle { bytes: Buffer; filename: string; sha256: string }

function readCodeFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("Runtime bundle file is missing, unsafe or too large");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Runtime bundle file exceeded its size limit");
  return bytes;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Stored ZIP records need no platform archive program, temporary output or native package. */
function zip(files: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, centralBytes = 0;
  for (const [name, data] of files) {
    const filename = Buffer.from(ROOT + name, "utf8"), checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0x0021, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(0x0021, 14); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); centralBytes += directory.length + filename.length;
    offset += header.length + filename.length + data.length;
    if (offset + centralBytes + 22 > MAX_ARCHIVE_BYTES) throw new Error("Runtime bundle exceeded its archive size limit");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** Reads only installed program assets. Runtime profiles, CLI logins and user workspaces are never enumerated. */
export function createRuntimeBundle(options: RuntimeBundleOptions = {}): RuntimeBundle {
  const moduleDirectory = options.moduleDirectory ?? dirname(fileURLToPath(import.meta.url));
  const packageDirectory = dirname(moduleDirectory);
  const version = options.packageVersion ?? JSON.parse(readCodeFile(join(packageDirectory, "package.json")).toString("utf8")).version;
  if (typeof version !== "string" || version.length > 64 || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error("Invalid runtime bundle version");
  const wsDirectory = options.wsDirectory ?? dirname(createRequire(import.meta.url).resolve("ws/package.json"));
  const wsPackage = readCodeFile(join(wsDirectory, "package.json"));
  const ws = JSON.parse(wsPackage.toString("utf8"));
  if (ws.name !== "ws" || !["8.22.0", "8.22.1"].includes(ws.version)) throw new Error("This installed WebSocket version has not been verified for the runtime bundle");
  const entries: Array<readonly [string, Buffer]> = [];
  let total = 0;
  const add = (name: string, bytes: Buffer): void => {
    total += bytes.length;
    if (total > MAX_ARCHIVE_BYTES) throw new Error("Runtime bundle exceeded its archive size limit");
    entries.push([name, bytes]);
  };
  for (const file of RUNTIME_BUNDLE_MODULES) add(`dist/${file}`, readCodeFile(join(moduleDirectory, file)));
  for (const file of WS_FILES) add(`node_modules/ws/${file}`, file === "package.json" ? wsPackage : readCodeFile(join(wsDirectory, file)));
  add("LICENSE", readCodeFile(options.licensePath ?? join(packageDirectory, "LICENSE")));
  add("package.json", Buffer.from(JSON.stringify({ name: "@songsid/agend-runtime", version, private: true, type: "module",
    bin: { "agend-runtime": "./dist/runtime-cli.js" }, engines: { node: "^22.14.0 || ^23.6.0 || >=24" }, dependencies: { ws: ws.version } }, null, 2) + "\n"));
  add("agend-runtime.cmd", Buffer.from(CMD)); add("README.txt", Buffer.from(README));
  add("bundle-manifest.json", Buffer.from(JSON.stringify({ version, modules: RUNTIME_BUNDLE_MODULES, ws: ws.version, nativeDependencies: [] }, null, 2) + "\n"));
  const bytes = zip(entries);
  return { bytes, filename: `agend-runtime-windows-${version}.zip`, sha256: createHash("sha256").update(bytes).digest("hex") };
}
