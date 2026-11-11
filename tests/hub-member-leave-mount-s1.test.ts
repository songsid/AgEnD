import { expect, it, vi } from "vitest";
import { HubMount } from "../src/hub/mount.js";
const expected = { hubId: "11111111-1111-4111-8111-111111111111", binding: "a".repeat(64) };
function fixture(leave?: (binding: typeof expected) => Promise<boolean>) {
  const service = { start: vi.fn(async () => {}), fence: vi.fn(), close: vi.fn(async () => {}), ...(leave ? { leave } : {}) };
  const mount = new HubMount({ home: "/nonexistent/inert", planDigest: vi.fn(), createServer: vi.fn(), createMember: async () => service, hold: vi.fn() });
  return { mount, service };
}
it("passes the captured exact binding only to the current mounted member", async () => {
  const leave = vi.fn(async () => true), { mount } = fixture(leave);
  expect(await mount.memberLeave(expected)).toBe(false); expect(leave).not.toHaveBeenCalled();
  await mount.apply({ hub_member: { enabled: true } });
  expect(await mount.memberLeave(expected)).toBe(true); expect(leave).toHaveBeenCalledExactlyOnceWith(expected);
  await mount.close(); expect(await mount.memberLeave(expected)).toBe(false); expect(leave).toHaveBeenCalledTimes(1);
});
it("a retired generation cannot report a successful current leave after its awaited write", async () => {
  let release!: () => void;
  const { mount } = fixture(async () => { await new Promise<void>(resolve => { release = resolve; }); return true; });
  await mount.apply({ hub_member: { enabled: true } }); const running = mount.memberLeave(expected);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await mount.apply({ hub_member: { enabled: true } }); release();
  expect(await running).toBe(false); await mount.close();
});
it("unsupported and failed writes are bounded false results", async () => {
  for (const leave of [undefined, async () => { throw Error("inert write failure"); }, async () => false]) {
    const { mount } = fixture(leave); await mount.apply({ hub_member: { enabled: true } });
    expect(await mount.memberLeave(expected)).toBe(false); await mount.close();
  }
});
