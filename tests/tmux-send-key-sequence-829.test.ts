/**
 * #829: sendKeySequence sends muse's clear keys in one call. It must only ever
 * send editing keys — never text, and never a key that submits, cancels or
 * quits. execFile is replaced: no tmux runs here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[][]);
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    execFile: ((cmd: string, args: string[], cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
      calls.push([cmd, ...args]);
      cb(null, { stdout: "", stderr: "" });
    }) as never,
  };
});

import { TmuxManager } from "../src/tmux-manager.js";

afterEach(() => { calls.length = 0; });

describe("TmuxManager.sendKeySequence", () => {
  it("sends the keys in one send-keys call, in order", async () => {
    const tmux = new TmuxManager("agend", "@7");
    expect(await tmux.sendKeySequence(["C-u", "C-k", "BSpace", "DC"])).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(-6)).toEqual(["-t", "agend:@7", "C-u", "C-k", "BSpace", "DC"]);
  });

  it.each([
    [[]],
    [["hello"]],
    [["C-u", "rm -rf ~"]],
    [["C-u", "-l"]],
    [["Enter"]],
    [["C-u", "Escape"]],
    [["C-c"]],
    [["C-d"]],
    [["C-U"]],
  ])("refuses %j without running tmux", async keys => {
    const tmux = new TmuxManager("agend", "@7");
    expect(await tmux.sendKeySequence(keys as string[])).toBe(false);
    expect(calls).toEqual([]);
  });
});
