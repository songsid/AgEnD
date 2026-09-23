import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { routeToolCall } from "../../src/channel/tool-router.js";
import type { ChannelAdapter } from "../../src/channel/types.js";

/**
 * `reply` refuses to attach anything under the AgEnD state dir except inbox/
 * downloads — that dir holds fleet config and credentials (#884).
 *
 * Only the refusal's wording changed: it used to say "refusing to send state
 * file <path>", which gave an agent nothing to do, and the usual case is an
 * artifact it built in its own workspace, which lives under the state dir too.
 * These tests hold both halves — the rule is exactly as strict as before, and
 * the answer now names the way out.
 */

// The vitest config points AGEND_HOME at a per-run temp dir, so this is the
// guard's real STATE_DIR, not the operator's ~/.agend.
const stateDir = process.env.AGEND_HOME as string;
const workspaceFile = join(stateDir, "workspaces", "refusal-test", "dist", "report.png");
mkdirSync(join(stateDir, "workspaces", "refusal-test", "dist"), { recursive: true });
writeFileSync(workspaceFile, "png");

const outside = mkdtempSync(join(tmpdir(), "agend-refusal-outside-"));
const outsideFile = join(outside, "report.png");
writeFileSync(outsideFile, "png");
afterAll(() => {
  rmSync(outside, { recursive: true, force: true });
  rmSync(join(stateDir, "workspaces", "refusal-test"), { recursive: true, force: true });
});

function makeAdapter() {
  return {
    sendText: vi.fn(async () => ({ messageId: "text-1", chatId: "chan" })),
    sendFile: vi.fn(async () => ({ messageId: "file-1", chatId: "chan" })),
  } as unknown as ChannelAdapter & { sendText: ReturnType<typeof vi.fn>; sendFile: ReturnType<typeof vi.fn> };
}

function reply(adapter: ChannelAdapter, files: string[]) {
  return new Promise<{ result: unknown; error?: string }>(resolve => {
    routeToolCall(adapter, "reply", { chat_id: "chan", text: "here", files }, undefined,
      (result, error) => resolve({ result, error }));
  });
}

describe("attaching a file from the AgEnD state dir", () => {
  it("still refuses a workspace artifact, and sends nothing at all", async () => {
    expect(stateDir, "AGEND_HOME must be the vitest temp home").toBeTruthy();
    const adapter = makeAdapter();

    const { error } = await reply(adapter, [workspaceFile]);

    expect(error, "the guard must not have been widened").toMatch(/^Blocked: refusing to send/);
    expect(adapter.sendText, "a refused reply must not half-send its text").not.toHaveBeenCalled();
    expect(adapter.sendFile).not.toHaveBeenCalled();
  });

  it("tells the agent why, and how to send an artifact it built", async () => {
    const { error } = await reply(makeAdapter(), [workspaceFile]);

    expect(error).toContain("state directory");
    expect(error, "the way out has to be concrete enough to act on")
      .toContain(`cp '${workspaceFile}' /tmp/`);
    expect(error).toContain("attach the copy under /tmp");
    expect(error, "and it says which files the way out is not for")
      .toContain("Do not do this for config, credentials");
  });

  it("sends the same file once it lives outside the state dir", async () => {
    const adapter = makeAdapter();

    const { error } = await reply(adapter, [outsideFile]);

    expect(error).toBeUndefined();
    expect(adapter.sendFile).toHaveBeenCalledWith("chan", outsideFile, expect.anything());
  });
});
