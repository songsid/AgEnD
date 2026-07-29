import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("AgEnD view responsive terminal", () => {
  const html = readFileSync(join(process.cwd(), "src", "ui", "view.html"), "utf-8");

  it("declares a device-width viewport and full-screen shell", () => {
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toContain("width: 100vw");
    expect(html).toContain("height: 100vh");
  });

  it("sizes the font from the pane's cell grid, not from the captured text", () => {
    expect(html).toContain("const widthFit = innerW / (paneCols * glyphRatio())");
    expect(html).toContain("const heightFit = innerH / (paneRows * lineH)");
    expect(html).toContain("Math.min(widthFit, heightFit)");
    expect(html).toContain('r.headers.get("X-Pane-Cols")');
    expect(html).toContain('r.headers.get("X-Pane-Rows")');
    // The old text-derived column count and the one-shot latch are both gone.
    expect(html).not.toContain("let fitted =");
    expect(html).not.toMatch(/lines\.reduce\(\(m, l\) => Math\.max/);
  });

  it("clamps to a single desktop range instead of the old 48px ceiling", () => {
    expect(html).toContain("const MIN_PX = 12, MAX_PX = 22");
    expect(html).toContain("Math.max(MIN_PX, Math.min(size, MAX_PX))");
    expect(html).not.toContain("Math.min(size, 48)");
    expect(html).not.toContain("Math.min(size, 16)");
    // Absolute readability floor survives the density multiplier.
    expect(html).toContain("Math.max(8, Math.min(size, 32))");
  });

  it("refits on container changes, not just window resize", () => {
    expect(html).toContain('window.addEventListener("resize", scheduleFit)');
    expect(html).toContain("new ResizeObserver(scheduleFit)");
  });

  it("keeps the desktop sidebar layout untouched", () => {
    expect(html).toContain("#sidebar { width: 240px; flex: 0 0 240px;");
    // Mobile drawer was dropped from scope — /view is desktop-only.
    expect(html).not.toContain('id="menuBtn"');
    expect(html).not.toContain("setDrawer");
  });

  it("offers a persisted font density control", () => {
    expect(html).toContain("const DENSITY = { fit: 1, comfortable: 1.25, compact: 0.8 }");
    expect(html).toContain('localStorage.getItem("agend_view_density")');
    expect(html).toContain('localStorage.setItem("agend_view_density", density)');
    expect(html).toContain('id="densityBtn"');
  });

  it("gives the terminal back height: compact card and small padding", () => {
    expect(html).toContain("padding: 5px 6px");          // #term
    expect(html).toContain('id="cardToggle"');
    expect(html).toContain("#card.expanded");
    expect(html).toContain("#cardBody .desc { display: none; }");
  });
});
