import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("AgEnD view responsive terminal", () => {
  const html = readFileSync(join(process.cwd(), "src", "ui", "view.html"), "utf-8");

  it("declares a device-width viewport and full-screen shell", () => {
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toContain("width: 100vw");
    // 100dvh tracks the visible viewport on mobile; 100vh stays as fallback.
    expect(html).toContain("height: 100vh; height: 100dvh");
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

  it("clamps per breakpoint instead of the old 48px ceiling", () => {
    expect(html).toContain("return [8, 14]");   // phone
    expect(html).toContain("return [10, 18]");  // tablet
    expect(html).toContain("return [12, 22]");  // desktop
    expect(html).not.toContain("Math.min(size, 48)");
    expect(html).not.toContain("Math.min(size, 16)");
    // Absolute readability floor survives the density multiplier.
    expect(html).toContain("Math.max(8, Math.min(size, 32))");
  });

  it("refits on container changes, not just window resize", () => {
    expect(html).toContain('window.addEventListener("resize", scheduleFit)');
    expect(html).toContain('window.addEventListener("orientationchange", scheduleFit)');
    expect(html).toContain("new ResizeObserver(scheduleFit)");
  });

  it("turns the mobile sidebar into an overlay drawer", () => {
    // Taking the sidebar out of the flex flow is what gives #main full width.
    expect(html).toMatch(/#sidebar \{ position: fixed;/);
    expect(html).toContain("#sidebar.open { transform: translateX(0); }");
    expect(html).toContain('id="menuBtn"');
    expect(html).toContain('id="sbBackdrop"');
    expect(html).toContain("function setDrawer(open)");
    // Desktop keeps the static 240px sidebar.
    expect(html).toContain("#sidebar { width: 240px; flex: 0 0 240px;");
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
