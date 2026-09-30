import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CodexBackend } from "../src/backend/codex.js";

const RUNTIME_DIRS = ["app-server-daemon", "app-server-control"] as const;
const saved = { AGEND_HOME: process.env.AGEND_HOME, CODEX_HOME: process.env.CODEX_HOME };
let root: string;
let shared: string;
let instance: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-1034-"));
  shared = join(root, "shared");
  instance = join(root, "agend", "instances", "runtime-worker-t1503382598640996543");
  process.env.AGEND_HOME = join(root, "agend");
  process.env.CODEX_HOME = shared;
  mkdirSync(instance, { recursive: true });
  mkdirSync(shared, { recursive: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(backend = new CodexBackend(instance)): string {
  backend.writeConfig({ workingDirectory: instance, instanceDir: instance, instanceName: "runtime-worker", mcpServers: {} });
  return CodexBackend.shortHomeFor(instance);
}

function seedSharedRuntime(): void {
  for (const name of RUNTIME_DIRS) {
    mkdirSync(join(shared, name));
    writeFileSync(join(shared, name, "shared-marker"), name);
  }
}

function expectSharedRuntimeUntouched(): void {
  for (const name of RUNTIME_DIRS) {
    expect(lstatSync(join(shared, name)).isDirectory()).toBe(true);
    expect(readFileSync(join(shared, name, "shared-marker"), "utf8")).toBe(name);
  }
}

describe("Codex app-server runtime home isolation (#1034)", () => {
  it("never mirrors runtime dirs, allows private real dirs, and retains the short physical home", () => {
    seedSharedRuntime();
    const backend = new CodexBackend(instance);
    const home = writeConfig(backend);

    expect(realpathSync(home)).toBe(home);
    expect(lstatSync(home).isDirectory()).toBe(true);
    expect(lstatSync(join(instance, "codex-home")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(instance, "codex-home"))).toBe(home);
    expect(join(home, "app-server-control", "app-server-control.sock").length).toBeLessThan(107);
    for (const name of RUNTIME_DIRS) {
      expect(existsSync(join(home, name)), name).toBe(false);
      mkdirSync(join(home, name), { mode: 0o700 });
      writeFileSync(join(home, name, "private-marker"), name);
    }

    writeConfig(backend);
    for (const name of RUNTIME_DIRS) {
      expect(lstatSync(join(home, name)).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(home, name)).isDirectory()).toBe(true);
      expect(readFileSync(join(home, name, "private-marker"), "utf8")).toBe(name);
    }
    expectSharedRuntimeUntouched();
  });

  it.each([false, true])("detaches old exact shared-entry links, including dangling links (dangling=%s)", dangling => {
    if (!dangling) seedSharedRuntime();
    // Seed the legacy home too: #953 must move it before #1034 detaches links.
    const legacy = join(instance, "codex-home");
    mkdirSync(legacy);
    for (const name of RUNTIME_DIRS) symlinkSync(join(shared, name), join(legacy, name), "dir");

    const backend = new CodexBackend(instance);
    const home = writeConfig(backend);
    for (const name of RUNTIME_DIRS) {
      expect(() => lstatSync(join(home, name))).toThrow(/ENOENT/);
      mkdirSync(join(home, name), { mode: 0o700 });
      expect(lstatSync(join(home, name)).isDirectory()).toBe(true);
    }
    writeConfig(backend); // the migration is idempotent after Codex creates dirs
    if (!dangling) expectSharedRuntimeUntouched();
    else for (const name of RUNTIME_DIRS) expect(existsSync(join(shared, name))).toBe(false);
  });

  it("preserves existing private runtime directories and their contents", () => {
    seedSharedRuntime();
    const backend = new CodexBackend(instance);
    const home = CodexBackend.shortHomeFor(instance);
    for (const name of RUNTIME_DIRS) {
      mkdirSync(join(home, name));
      writeFileSync(join(home, name, "keep"), `private-${name}`);
    }

    writeConfig(backend);
    for (const name of RUNTIME_DIRS) {
      expect(lstatSync(join(home, name)).isDirectory()).toBe(true);
      expect(readFileSync(join(home, name, "keep"), "utf8")).toBe(`private-${name}`);
    }
    expectSharedRuntimeUntouched();
  });

  it.each([false, true])("preserves external runtime symlinks, including dangling ones (dangling=%s)", dangling => {
    seedSharedRuntime();
    const backend = new CodexBackend(instance);
    const home = CodexBackend.shortHomeFor(instance);
    for (const name of RUNTIME_DIRS) {
      const external = join(root, "external", name);
      if (!dangling) {
        mkdirSync(external, { recursive: true });
        writeFileSync(join(external, "keep"), name);
      }
      symlinkSync(external, join(home, name), "dir");
    }

    writeConfig(backend);
    for (const name of RUNTIME_DIRS) {
      expect(lstatSync(join(home, name)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(home, name))).toBe(join(root, "external", name));
      if (!dangling) expect(readFileSync(join(home, name, "keep"), "utf8")).toBe(name);
    }
    expectSharedRuntimeUntouched();
  });

  it("preserves user-created relative links even when they resolve to the shared entry", () => {
    seedSharedRuntime();
    const backend = new CodexBackend(instance);
    const home = CodexBackend.shortHomeFor(instance);
    for (const name of RUNTIME_DIRS) symlinkSync(relative(home, join(shared, name)), join(home, name), "dir");

    writeConfig(backend);
    for (const name of RUNTIME_DIRS) {
      expect(readlinkSync(join(home, name))).toBe(relative(home, join(shared, name)));
      expect(realpathSync(join(home, name))).toBe(join(shared, name));
    }
    expectSharedRuntimeUntouched();
  });

  it("keeps session dirs, state_5.sqlite, and thread-writer-locks shared", () => {
    seedSharedRuntime();
    for (const name of ["sessions", "archived_sessions", "thread-writer-locks"]) {
      mkdirSync(join(shared, name));
      writeFileSync(join(shared, name, "keep"), name);
    }
    writeFileSync(join(shared, "state_5.sqlite"), "shared-db");

    const home = writeConfig();
    for (const name of ["sessions", "archived_sessions", "thread-writer-locks", "state_5.sqlite"]) {
      expect(lstatSync(join(home, name)).isSymbolicLink(), name).toBe(true);
      expect(readlinkSync(join(home, name)), name).toBe(join(shared, name));
    }
    expect(readFileSync(join(home, "state_5.sqlite"), "utf8")).toBe("shared-db");
    for (const name of ["sessions", "archived_sessions", "thread-writer-locks"]) {
      expect(readFileSync(join(home, name, "keep"), "utf8")).toBe(name);
    }
    expectSharedRuntimeUntouched();
  });
});
