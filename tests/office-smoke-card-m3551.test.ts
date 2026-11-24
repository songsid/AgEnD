import { describe, expect, it, vi } from "vitest";
import { openOfficePersonCard, closeOfficePersonCard } from "../scripts/manual/smoke-fixture/office-smoke-card.js";
function fixture(options: { shown?: string | null; opens?: string; name?: string | null } = {}) {
  let shown = options.shown ?? null;
  const press = vi.fn(async () => { shown = options.opens ?? "example-agent"; });
  const click = vi.fn(async () => { shown = null; });
  const wait = vi.fn(async (opts?: any) => {
    if (opts?.state === "hidden" ? shown !== null : shown === null) throw new Error("card state not reached");
  });
  const person = { first() { return this; }, getAttribute: async () => options.name === undefined ? "example-agent" : options.name,
    focus: vi.fn(async () => {}), press };
  const mouse = { click: vi.fn(() => { throw new Error("stale canvas point is not a person"); }) };
  const page = { mouse, locator: (selector: string) => {
    if (selector === "button.oo-desk") return person;
    if (selector === ".oo-card") return { count: async () => shown ? 1 : 0, waitFor: wait };
    if (selector === ".oo-card-instance") return { innerText: async () => shown };
    if (selector === ".oo-card-close") return { click };
    throw new Error("unexpected selector: " + selector);
  } };
  return { page, mouse, press, click, wait };
}
describe("Office smoke semantic card entry (M-3551)", () => {
  it("opens the named person without depending on a moving/bubble canvas point", async () => {
    const f = fixture();
    expect(await openOfficePersonCard(f.page)).toBe("example-agent");
    expect(f.press).toHaveBeenCalledExactlyOnceWith("Enter");
    expect(f.mouse.click).not.toHaveBeenCalled();
  });
  it("rejects a wrong opened identity without retrying Enter", async () => {
    const f = fixture({ opens: "another-example" });
    await expect(openOfficePersonCard(f.page)).rejects.toThrow("target mismatch");
    expect(f.press).toHaveBeenCalledTimes(1);
  });
  it("rejects a missing person identity before any activation", async () => {
    const f = fixture({ name: null });
    await expect(openOfficePersonCard(f.page)).rejects.toThrow("no instance identity");
    expect(f.press).not.toHaveBeenCalled();
  });
  it("does not toggle an already-open card or hide an earlier failed precondition", async () => {
    const f = fixture({ shown: "example-agent" });
    await expect(openOfficePersonCard(f.page)).rejects.toThrow("already open");
    expect(f.press).not.toHaveBeenCalled();
  });
  it("closes the actual card and awaits hidden state; missing close fails immediately", async () => {
    const f = fixture({ shown: "example-agent" });
    await closeOfficePersonCard(f.page);
    expect(f.click).toHaveBeenCalledTimes(1);
    expect(f.wait).toHaveBeenCalledWith({ state: "hidden" });
    await expect(closeOfficePersonCard(f.page)).rejects.toThrow("Expected one");
    expect(f.click).toHaveBeenCalledTimes(1);
  });
});
