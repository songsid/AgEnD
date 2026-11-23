/** Deterministic synthetic text snapshot; no CLI, Fleet or Hub service is started. */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { FleetManager } from "../../src/fleet-manager.js";
import { buildFleetInstructions } from "../../src/instructions.js";
import { listBundledSkills } from "../../src/bundled-skills.js";
import { formatRoomBrief } from "../../src/hub/room-brief-model.js";
const out = process.argv[2] || ".artifacts/m3527/snapshot.json";
const home = mkdtempSync(join(tmpdir(), "instruction-diet-")), previous = process.env.AGEND_HOME;
process.env.AGEND_HOME = home;
const fm = new FleetManager(join(home, "data"));
const params = { instanceName: "example-room", workingDirectory: "/workspace/example", runtimeIdentity: { kind: "classic" as const, backend: "codex", model: "default" }, workflow: false as const };
try {
  const descriptions = new Map(listBundledSkills().map(s => [s.name, s.description]));
  const catalog = (restricted: boolean) => {
    const work = join(home, "workspaces", restricted ? "restricted" : "legacy"); mkdirSync(work, { recursive: true });
    (fm as any).syncRoleSkills(work, "codex", "classic", undefined, restricted);
    return readdirSync(join(work, ".agents/skills")).filter(n => !n.startsWith(".")).sort().map(name => `${name}: ${descriptions.get(name)}`).join("\n");
  };
  const snapshot = { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceHashes: ["src/instructions.ts", "src/fleet-manager.ts", "src/hub/room-brief-model.ts"].map(path => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") })),
    text: {
      restrictedPrompt: buildFleetInstructions({ ...params, restrictedClassic: true } as any),
      restrictedNamedPrompt: buildFleetInstructions({ ...params, displayName: "Example", restrictedClassic: true } as any),
      legacyPrompt: buildFleetInstructions(params),
      workerPrompt: buildFleetInstructions({ ...params, runtimeIdentity: { ...params.runtimeIdentity, kind: "fleet-topic" } }),
      restrictedCatalog: catalog(true), legacyCatalog: catalog(false),
      firstBriefEn: formatRoomBrief({ kind: "first", purpose: "Example purpose", people: 3, agents: 4 }, "en"),
      firstBriefZh: formatRoomBrief({ kind: "first", purpose: "範例用途", people: 3, agents: 4 }, "zh-TW"),
      deltaEn: formatRoomBrief({ kind: "delta", joined: [], left: [], omitted: 0 }, "en"),
      deltaZh: formatRoomBrief({ kind: "delta", joined: [], left: [], omitted: 0 }, "zh-TW"),
    } };
  writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n");
} finally {
  fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); fm.memoryPressure.stop();
  if (previous === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = previous;
  rmSync(home, { recursive: true, force: true });
}
