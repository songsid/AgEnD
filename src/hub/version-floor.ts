/** Private, independently durable revision floor; never create/reset on a missing read. */
import { openSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "../atomic-write.js";
import { ensurePrivateDirectory, readPrivateFile } from "./private-files.js";
import { parseStrictJson, validated, epoch } from "./validation.js";
import type { HubVersionFloor } from "./store.js";
export class HubFileVersionFloor implements HubVersionFloor {
  constructor(private readonly home: string, private readonly suffix: string) {}
  initialize(): void {
    ensurePrivateDirectory(this.home, dirname(this.suffix).replaceAll("\\", "/"));
    const fd = openSync(join(this.home, this.suffix), "wx", 0o600);
    try { writeFileSync(fd, "0", "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  }
  read(): number { return validated(epoch, parseStrictJson(readPrivateFile(this.home, this.suffix, 64))); }
  raise(revision: number): void {
    validated(epoch, revision); if (revision < this.read()) throw Error("Hub revision would decrease");
    atomicWriteFileSync(join(this.home, this.suffix), String(revision), { mode: 0o600 });
  }
}
