import { describe, expect, it, vi } from "vitest";
import { PaneContextCache, type PaneContextSource } from "../src/pane-context-cache.js";

function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function drain() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function source(pane = "Context 33% left") {
  let current = true;
  const capture = vi.fn(async () => pane);
  const value: PaneContextSource = { owner: {}, generation: "1", isCurrent: () => current, capture };
  return { value, capture, retire: () => { current = false; } };
}

describe("owned pane context refresh", () => {
  it.each([
    ["codex", "Context 33% left", 67],
    ["kiro-cli", "kiro_default · auto · ◕ 63% · λ", 63],
    ["grok", "67K / 500K │ 0/4 ✓", 13.4],
  ])("uses the existing %s pane parser", async (backend, pane, percent) => {
    const c = new PaneContextCache(), s = source(String(pane));
    expect(c.resolve("/private/data", "one", String(backend), s.value).context).toBeNull();
    await drain();
    expect(c.resolve("/private/data", "one", String(backend), s.value).context).toBeCloseTo(Number(percent));
    expect(s.capture).toHaveBeenCalledOnce();
  });

  it("joins all tabs while a capture is held and refreshes at the monotonic TTL", async () => {
    let now = 0; const c = new PaneContextCache(() => now), s = source(); const pending = held<string>();
    s.capture.mockImplementationOnce(() => pending.promise);
    vi.spyOn(Date, "now").mockImplementation(() => { throw Error("wall clock consulted"); });
    try {
      for (let i = 0; i < 25; i++) expect(c.resolve("/private/data", "one", "codex", s.value).context).toBeNull();
      expect(s.capture).toHaveBeenCalledOnce();
      pending.resolve("Context 33% left"); await drain();
      now = 7_999; expect(c.resolve("/private/data", "one", "codex", s.value).context).toBe(67);
      expect(s.capture).toHaveBeenCalledOnce();
      now = 8_000; expect(c.resolve("/private/data", "one", "codex", s.value).context).toBe(67);
      await drain(); expect(s.capture).toHaveBeenCalledTimes(2);
    } finally { vi.restoreAllMocks(); }
  });

  it.each(["forget", "owner", "generation", "backend", "retire"] as const)("drops a held result after %s", async change => {
    const c = new PaneContextCache(), old = source(), pending = held<string>();
    old.capture.mockImplementationOnce(() => pending.promise);
    c.resolve("/private/data", "one", "codex", old.value);
    const next = source("Context 80% left");
    if (change === "forget") c.forget("one");
    if (change === "retire") old.retire();
    if (change === "generation") next.value = { ...next.value, owner: old.value.owner, generation: "2" };
    const backend = change === "backend" ? "kiro-cli" : "codex";
    if (change === "backend") next.value = { ...next.value, owner: old.value.owner };
    expect(c.resolve("/private/data", "one", backend, next.value).context).toBeNull();
    await drain(); pending.resolve("Context 1% left"); await drain();
    expect(c.resolve("/private/data", "one", backend, next.value).context).toBe(20);
    expect(next.capture).toHaveBeenCalledOnce();
  });

  it("refuses an invalid or missing source and never invokes its capture", async () => {
    const c = new PaneContextCache(), s = source();
    c.resolve("/private/data", "one", "codex", s.value); await drain(); s.retire();
    expect(c.resolve("/private/data", "one", "codex", s.value).context).toBeNull();
    expect(c.resolve("/private/data", "one", "codex").context).toBeNull();
    expect(c.resolve("/private/data", "one", "codex", { ...s.value, isCurrent: () => { throw Error("retired"); } }).context).toBeNull();
    expect(s.capture).toHaveBeenCalledOnce();
  });

  it("rechecks the current owner after a held capture even without another resolve", async () => {
    const c = new PaneContextCache(), s = source(), pending = held<string>();
    s.capture.mockImplementationOnce(() => pending.promise);
    c.resolve("/private/data", "one", "codex", s.value); s.retire(); pending.resolve("Context 1% left"); await drain();
    // Same identity becomes readable again; its revoked result must not be published.
    const replacement = { ...s.value, isCurrent: () => true };
    expect(c.resolve("/private/data", "one", "codex", replacement).context).toBeNull();
    await drain(); expect(c.resolve("/private/data", "one", "codex", replacement).context).toBe(67);
    expect(s.capture).toHaveBeenCalledTimes(2);
  });

  it("keeps same-named instances in distinct data directories separate", async () => {
    const c = new PaneContextCache(), a = source("Context 80% left"), b = source("Context 20% left");
    c.resolve("/private/a", "one", "codex", a.value); c.resolve("/private/b", "one", "codex", b.value); await drain();
    expect(c.resolve("/private/a", "one", "codex", a.value).context).toBe(20);
    expect(c.resolve("/private/b", "one", "codex", b.value).context).toBe(80);
  });

  it("forget revokes a held refresh even when the next owner identity is unchanged", async () => {
    const c = new PaneContextCache(), s = source(), old = held<string>(), next = held<string>();
    s.capture.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
    c.resolve("/private/data", "one", "codex", s.value); c.forget("one");
    c.resolve("/private/data", "one", "codex", s.value); expect(s.capture).toHaveBeenCalledTimes(2);
    old.resolve("Context 1% left"); await drain();
    expect(c.resolve("/private/data", "one", "codex", s.value).context).toBeNull();
    next.resolve("Context 80% left"); await drain();
    expect(c.resolve("/private/data", "one", "codex", s.value).context).toBe(20);
  });

  it("reports failed reads as unknown and retries only at the next TTL", async () => {
    let now = 0; const c = new PaneContextCache(() => now), s = source();
    s.capture.mockRejectedValueOnce(Error("unavailable"));
    c.resolve("/private/data", "one", "codex", s.value); await drain();
    expect(c.resolve("/private/data", "one", "codex", s.value).context).toBeNull();
    expect(s.capture).toHaveBeenCalledOnce(); now = 8_000;
    c.resolve("/private/data", "one", "codex", s.value); await drain();
    expect(c.resolve("/private/data", "one", "codex", s.value).context).toBe(67);
    expect(s.capture).toHaveBeenCalledTimes(2);
  });

  it("an explicit current-owner record supersedes an older background capture", async () => {
    const c = new PaneContextCache(), s = source(), pending = held<string>(); s.capture.mockImplementationOnce(() => pending.promise);
    c.resolve("/private/data", "one", "codex", s.value);
    c.record("/private/data", "one", "codex", { context: 42, tokenRatio: null }, s.value);
    pending.resolve("Context 1% left"); await drain();
    expect(c.resolve("/private/data", "one", "codex", s.value).context).toBe(42);
  });
});
