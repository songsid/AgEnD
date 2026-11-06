import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { RUNTIME_BUNDLE_MODULES } from "../../src/runtime-bundle.js";
import { RUNTIME_PANE_ASSETS, PANE_NATIVE_SHA256 } from "../../src/runtime-pane-assets.js";
import { GENERAL_KNOWLEDGE_FILES } from "../../src/general-role.js";

/** Isolated inputs for createRuntimeBundle(): fixed fake modules, the real ws and the real native pane files, in a temp folder. */
export function runtimeBundleFixture(version = "2.3.5-fixture.1") {
  const root = mkdtempSync(join(tmpdir(), "agend-runtime-fixture-"));
  const moduleDirectory = join(root, "dist"), wsDirectory = join(root, "ws"), licensePath = join(root, "LICENSE");
  mkdirSync(moduleDirectory); cpSync(dirname(createRequire(import.meta.url).resolve("ws/package.json")), wsDirectory, { recursive: true });
  for (const name of RUNTIME_BUNDLE_MODULES) writeFileSync(join(moduleDirectory, name), `// isolated fixture ${name}\nexport {};\n`);
  for (const name of GENERAL_KNOWLEDGE_FILES) { const file = join(moduleDirectory, "general-knowledge", name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "# Fixed bundled General fixture\n"); }
  writeFileSync(licensePath, "MIT License\nRuntime fixture\n");
  for (const pkg of RUNTIME_PANE_ASSETS) for (const file of pkg.files) {
    const target = join(moduleDirectory, "runtime-assets", pkg.name, file); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, pkg.name === "node-pty" && PANE_NATIVE_SHA256[file] ? readFileSync(join("node_modules/node-pty", file)) : file === "package.json" ? JSON.stringify({ name: pkg.name, version: pkg.version }) : "verified fixed program fixture");
  }
  return { root, moduleDirectory, wsDirectory, licensePath, packageVersion: version, cleanup() { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe fixture cleanup"); rmSync(root, { recursive: true, force: true }); } };
}
/** Reads a stored ZIP through its central directory, independently of the code that wrote it. */
export function unzipStored(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50) throw Error("not a ZIP");
  const count = bytes.readUInt16LE(end + 10), files = new Map<string, Buffer>(); let at = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const size = bytes.readUInt32LE(at + 24), length = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + length).toString("utf8"), start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    files.set(name, bytes.subarray(start, start + size)); at += 46 + length + extra + comment;
  }
  return files;
}
