import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(join(process.cwd(), "src", "ui", "view.html"), "utf-8");

describe("View UI improvements", () => {
  it("renders a backend-specific CLI icon after the context percentage", () => {
    for (const backend of ["claude-code", "kiro-cli", "codex", "grok", "antigravity", "opencode"]) {
      expect(html).toContain(`.cli-${backend}`);
    }
    expect(html).toContain('${it.context_pct ? Math.round(it.context_pct)+"%" : ""}</span>${backendIconHtml(it.backend)}');
  });

  it("persists sidebar sorting only in browser localStorage", () => {
    expect(html).toContain('const SIDEBAR_ORDER_KEY = "agend_view_sidebar_order"');
    expect(html).toContain("localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(orderRows()))");
    expect(html).toContain("header.draggable = true");
    expect(html).toContain("el.draggable = true");
    expect(html).not.toContain('fetch("/api/sort-order"');
    expect(html).not.toContain("probeWrite()");
  });

  it("lets the user reorder usage providers without a token", () => {
    expect(html).toContain('const USAGE_ORDER_KEY = "agend_view_usage_order"');
    expect(html).toContain("localStorage.setItem(USAGE_ORDER_KEY, JSON.stringify(usageOrder))");
    expect(html).toContain('class="u-move"');
    expect(html).toContain("moveUsageProvider(button.dataset.provider");
    expect(html).not.toMatch(/moveUsageProvider[\s\S]{0,500}webToken/);
  });
});
