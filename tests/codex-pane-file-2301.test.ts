import { afterEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkpointCodexPane } from "../src/codex-pane-ownership.js";
import { TranscriptDeltaReader } from "../src/transcript-delta-reader.js";

const ID = "01a15cc0-04d0-74f3-a745-d7cfdb62849f";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "codex-file2301-"));
  roots.push(cwd);
  const sessions = join(cwd, "sessions");
  mkdirSync(sessions);
  const path = join(sessions, `rollout-2026-10-21T04-37-30-${ID}.jsonl`);
  const meta = {
    type: "session_meta",
    payload: { id: ID, cwd, source: "cli" },
  };
  const write = () => writeFileSync(path, JSON.stringify(meta) + "\n");
  write();
  const bind = () => checkpointCodexPane(sessions, ID, cwd);
  return { cwd, sessions, path, meta, write, bind };
}
const user = (text: string) =>
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  }) + "\n";

describe("#2301 exact rollout checkpoint", () => {
  it.each(["cli", "vscode"])(
    "accepts a full root %s metadata id and reads only the post-checkpoint text",
    async (source) => {
      const f = fixture();
      f.meta.payload.source = source;
      f.write();
      appendFileSync(f.path, user("old"));
      const cp = (await f.bind())!;
      expect(cp).not.toBeNull();
      expect(
        await new TranscriptDeltaReader(
          cp.path,
          cp.offset,
          "codex",
          { rawText: "old" },
          cp.identity,
        ).look(),
      ).toBe("no-match");
      appendFileSync(f.path, user("new"));
      expect(
        await new TranscriptDeltaReader(
          cp.path,
          cp.offset,
          "codex",
          { rawText: "new" },
          cp.identity,
        ).look(),
      ).toBe("user");
      expect(await cp.validateFile()).toBe(true);
    },
  );
  it.each(["id", "cwd", "source", "parent_thread_id", "thread_source"])(
    "refuses mismatched or child metadata %s",
    async (key) => {
      const f = fixture();
      (f.meta.payload as any)[key] =
        key === "source" ? { subagent: "worker" } : "foreign";
      f.write();
      expect(await f.bind()).toBeNull();
    },
  );
  it("rejects session_id as a substitute for the actual metadata id", async () => {
    const f = fixture();
    (f.meta.payload as any).session_id = ID;
    f.meta.payload.id = "foreign";
    f.write();
    expect(await f.bind()).toBeNull();
  });
  it("does not choose a newest same-id file when the binding is ambiguous", async () => {
    const f = fixture();
    mkdirSync(join(f.sessions, "other"));
    writeFileSync(
      join(f.sessions, "other", `rollout-copy-${ID}.jsonl`),
      readFileSync(f.path),
    );
    expect(await f.bind()).toBeNull();
  });
  it("does not authorize a partial pre-write record or an oversized metadata line", async () => {
    const f = fixture();
    appendFileSync(f.path, '{"type":"response_item"');
    expect(await f.bind()).toBeNull();
    (f.meta.payload as any).extra = "x".repeat(65536);
    f.write();
    expect(await f.bind()).toBeNull();
  });
  it("rejects a symlink leaf", async () => {
    const f = fixture(),
      original = f.path + ".saved";
    renameSync(f.path, original);
    symlinkSync(original, f.path);
    expect(await f.bind()).toBeNull();
  });
  it("retires an inode replacement permanently, even when the original file returns", async () => {
    const f = fixture(),
      cp = (await f.bind())!,
      original = f.path + ".saved";
    renameSync(f.path, original);
    f.write();
    appendFileSync(f.path, user("new"));
    expect(
      await new TranscriptDeltaReader(
        cp.path,
        cp.offset,
        "codex",
        { rawText: "new" },
        cp.identity,
      ).look(),
    ).toBe("unavailable");
    expect(await cp.validateFile()).toBe(false);
    rmSync(f.path);
    renameSync(original, f.path);
    expect(await cp.validateFile()).toBe(false);
  });
  it("retires changed metadata or a truncation", async () => {
    const f = fixture(),
      cp = (await f.bind())!;
    f.meta.payload.cwd += "/other";
    f.write();
    expect(await cp.validateFile()).toBe(false);
    const g = fixture(),
      second = (await g.bind())!;
    writeFileSync(g.path, "");
    expect(await second.validateFile()).toBe(false);
  });
});
