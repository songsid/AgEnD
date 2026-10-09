import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #1490: a SQLite driver that cannot load (built for another Node.js) used to make the fleet move events.db aside —
 * a file it never even read. The driver is replaced here by one that fails exactly as a wrong-ABI native module does.
 */
vi.mock("better-sqlite3", () => ({
  default: class {
    constructor() {
      throw Object.assign(new Error("The module '/x/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137."), { code: "ERR_DLOPEN_FAILED" });
    }
  },
}));

const { FleetManager } = await import("../src/fleet-manager.js");

describe("events.db with a driver that does not load", () => {
  it("is left untouched and the reason is reported", () => {
    const d = mkdtempSync(join(tmpdir(), "agend-eventsdb-abi-1490-"));
    const path = join(d, "events.db");
    writeFileSync(path, "pretend history bytes");
    const fm = new FleetManager(d) as unknown as { openEventLog(): unknown; notifyFleetError(text: string): boolean };
    const notices: string[] = [];
    fm.notifyFleetError = (text: string) => { notices.push(text); return true; };

    expect(fm.openEventLog()).toBeNull();
    expect(readdirSync(d).filter(f => f.includes(".corrupt-"))).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("pretend history bytes");
    expect(notices.join("\n")).toContain("npm rebuild better-sqlite3");
  });
});
