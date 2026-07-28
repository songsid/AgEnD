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

  it("fits pane text against width and height and responds to resizing", () => {
    expect(html).toContain("const widthFit =");
    expect(html).toContain("const heightFit =");
    expect(html).toContain("Math.min(widthFit, heightFit)");
    expect(html).toContain('window.addEventListener("resize"');
    expect(html).not.toContain("Math.min(size, 16)");
  });
});
