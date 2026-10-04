/**
 * #1174 review: kiro_engine_status is a tool call on the fleet's event loop.
 * It must not run a process — no `which`, no `kiro-cli --version`, no
 * `chat --help` — and reads only what the last kiro launch already probed.
 */
import { describe, expect, it, vi } from "vitest";

const ran = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => ((cmd: unknown) => { ran.push(`${name} ${String(cmd)}`); throw new Error("no process may run here"); }) as never;
  return { ...real, execFileSync: refuse("execFileSync"), execSync: refuse("execSync"), spawnSync: refuse("spawnSync"), execFile: refuse("execFile"), spawn: refuse("spawn"), exec: refuse("exec") };
});

import { outboundHandlers } from "../src/outbound-handlers.js";

describe("kiro_engine_status", () => {
  it("runs no process, and with nothing probed yet says so", async () => {
    const handler = outboundHandlers.get("kiro_engine_status")!;
    const ctx = { fleetConfig: { defaults: { backend: "kiro-cli" }, instances: { a: {} } }, classicChannels: null } as any;
    const result = await new Promise<any>(resolve => handler(ctx, {} as never, (r: any) => resolve(r), undefined as never));
    expect(ran).toEqual([]);
    expect(result.instances[0]).toMatchObject({ name: "a", next_launch: { unknown: expect.stringContaining("has not been probed") } });
  });
});
