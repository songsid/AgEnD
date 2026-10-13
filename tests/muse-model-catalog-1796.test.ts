/**
 * #1796: AgEnD's /model reads muse's on-disk provider catalog instead of a
 * frozen list, so new models (muse-wonder-1.0) show up. Fixture catalog dirs
 * only — except one explicitly conditional host check.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseBackend, readMuseModelCatalog } from "../src/backend/muse.js";

const row = (model_id: string, extra: Record<string, unknown> = {}) => ({
  model_id, display_label: model_id, provider_id: "meta", profile_id: "tbh",
  visibility: "visible", release_date: "2026-10-12", display_order: null,
  is_current: false, is_default: false, roles: [], context_limit: 1007997,
  output_limit: 128000, description: null, cost: null,
  reasoning_effort_variants: [], supports_video: false,
  supports_image_generation: false, ...extra,
});
const catalogFile = (dir: string, name: string, rows: unknown[]) => {
  mkdirSync(join(dir, "model-catalog"), { recursive: true });
  writeFileSync(join(dir, "model-catalog", name),
    JSON.stringify({ schema_version: 2, provider_id: "meta", profile_id: "tbh", source: "provider_catalog", rows }));
};
const withDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "agend-1796-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const ids = (dir: string) => readMuseModelCatalog(dir).map(o => o.id);

describe("#1796: /model reads the on-disk catalog", () => {
  it("new models appear; hidden and image-only rows are excluded, order kept", () => {
    withDir(dir => {
      catalogFile(dir, "meta__tbh.json", [
        row("muse-wonder-1.0"),
        row("muse-wonder-1.0-contributor", { visibility: "hidden", description: "shares content" }),
        row("muse-spark-1.3"),
        row("muse-spark-1.3-contributor", { visibility: "hidden" }),
        row("muse-image-1.0", { display_label: "Muse Image", visibility: "hidden", context_limit: null, output_limit: null, reasoning_effort_variants: null, supports_image_generation: true }),
        row("muse-future-9.9", { context_limit: null }),
        row("muse-oddball-1.0-contributor", {}),
      ]);
      // The 1.4.7 picker follows visibility: hidden -contributor siblings and
      // the image model are not listed — and a -contributor suffix is never a
      // model, even if some profile marks it visible.
      expect(ids(dir)).toEqual(["muse-wonder-1.0", "muse-spark-1.3"]);
      const labels = Object.fromEntries(readMuseModelCatalog(dir).map(o => [o.id, o.label]));
      expect(labels["muse-wonder-1.0"]).toBe("muse-wonder-1.0");
    });
  });

  it("dedupes across files and survives bad files", () => {
    withDir(dir => {
      catalogFile(dir, "a.json", [row("muse-wonder-1.0"), row("muse-spark-1.3")]);
      catalogFile(dir, "b.json", [row("muse-wonder-1.0"), row("muse-spark-1.2")]);
      mkdirSync(join(dir, "model-catalog"), { recursive: true });
      writeFileSync(join(dir, "model-catalog", "c.json"), "{ not json");
      writeFileSync(join(dir, "model-catalog", "d.json"), JSON.stringify({ rows: "nope" }));
      expect(ids(dir)).toEqual(["muse-wonder-1.0", "muse-spark-1.3", "muse-spark-1.2"]);
    });
  });

  it("missing or empty catalog falls back to the visible set, no -contributor ids", () => {
    withDir(dir => {
      expect(ids(dir)).toEqual(["muse-wonder-1.0", "muse-spark-1.3", "muse-spark-1.2"]);
      catalogFile(dir, "empty.json", []);
      expect(ids(dir)).toEqual(["muse-wonder-1.0", "muse-spark-1.3", "muse-spark-1.2"]);
    });
  });

  it("listModels delegates to the catalog reader", async () => {
    // Hermetic via XDG_DATA_HOME (the binary's own root): a frozen fallback
    // cannot produce the fixture-only id.
    const prev = process.env.XDG_DATA_HOME;
    const dir = mkdtempSync(join(tmpdir(), "agend-1796-xdg-"));
    try {
      process.env.XDG_DATA_HOME = dir;
      mkdirSync(join(dir, "muse", "model-catalog"), { recursive: true });
      writeFileSync(join(dir, "muse", "model-catalog", "m.json"),
        JSON.stringify({ rows: [row("muse-wonder-1.0"), row("muse-custom-9.9")] }));
      const backend = new MuseBackend("/tmp/agend-muse-1796");
      expect((await backend.listModels()).map(o => o.id)).toEqual(["muse-wonder-1.0", "muse-custom-9.9"]);
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("host catalog (when muse runs here) includes the new model", () => {
    const host = join(process.env.HOME ?? "/nonexistent", ".local", "share", "muse");
    if (!existsSync(join(host, "model-catalog"))) return;
    expect(readMuseModelCatalog().map(o => o.id)).toContain("muse-wonder-1.0");
  });
});
