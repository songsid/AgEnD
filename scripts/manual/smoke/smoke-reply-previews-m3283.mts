// Actual product HTTP + browser, inert agents. No Fleet/CLI lifecycle or external requests.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";
const before = process.env.STAGE === "before", tag = `smoke-reply-previews-m3283-${before ? "before" : "after"}`;
const project = mkdtempSync(join(tmpdir(), "reply-preview-project-"));
mkdirSync(join(project, "src"));
writeFileSync(join(project, "src/app.ts"), Array.from({ length: 1050 }, (_, i) => `export const line${i + 1} = ${i === 999 ? '"Updated example"' : i + 1};`).join("\n") + "\n");
writeFileSync(join(project, "README.md"), "# Example project\n\nA **Markdown** preview.\n");
// Small valid one-page PDF, with byte offsets and a visible text object.
const pdfObjects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
const pdfText = "BT /F1 20 Tf 40 240 Td (Example PDF preview) Tj ET\n";
pdfObjects.push(`<< /Length ${Buffer.byteLength(pdfText)} >>\nstream\n${pdfText}endstream`);
let pdf = "%PDF-1.4\n", offsets = [0];
for (const [i, body] of pdfObjects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; }
const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(join(project, "example.pdf"), pdf);
if (process.env.DEBUG_PDF) writeFileSync(join(process.env.OUT!, "fixture.pdf"), pdf);
// The legacy headless shell omits the native PDF viewer. Use full Chromium in headless mode.
if (!process.env.CHROME && process.env.PW_ENGINE !== "webkit") process.env.CHROME = createRequire(process.env.PW_DIR + "/")("playwright-core").chromium.executablePath();
const fx = await bootFixture({ port: Number(process.env.HP ?? 49180), classic: false, roster: [{ name: "agent-alpha", displayName: "Example helper", backend: "codex" }] });
const results: unknown[] = [];
try {
  fx.fm.fleetConfig.instances["agent-alpha"].working_directory = project;
  writeFileSync(join(project, "picture.png"), await fx.picture("avatarTransparent"));
  fx.fm.emitSseEvent("message", { instance: "agent-alpha", sender: "Example helper", role: "agent", text: "I updated src/app.ts at line 1000. Preview the changed lines or the supporting files.", ts: new Date().toISOString(),
    previews: [{ path: "src/app.ts", line: 1000, endLine: 1002 }, { path: "README.md" }, { path: "picture.png" }, { path: "example.pdf" }, { path: "missing.txt" }] });
  for (const device of ["desk", "phone"] as const) {
    if (process.env.DEVICES && !process.env.DEVICES.split(",").includes(device)) continue;
    const c = { device, theme: device === "desk" ? "dark" as const : "light" as const, lang: device === "desk" ? "en" as const : "zh-TW" as const };
    const { ctx, page } = await fx.page(c, { path: "/ui/chat/agent-alpha", host: true });
    const diagnostic: unknown[] = [];
    page.on("console", (m: any) => { if (m.type() === "error") diagnostic.push({ console: m.text() }); });
    page.on("requestfailed", (r: any) => diagnostic.push({ failed: r.url(), reason: r.failure() }));
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      await page.getByText("I updated src/app.ts at line 1000.", { exact: false }).first().waitFor();
      if (!process.env.RETAKE) await page.screenshot({ path: shotPath(tag, `${device}-${c.lang}`, "reply") });
      if (!before) {
        if (!process.env.RETAKE) {
        await page.locator('[data-reply-preview="0"]').click();
        await page.locator('.pv-panel .ws-line[data-line="1000"].hl-read').waitFor();
        const hl = await page.locator(".pv-panel .ws-line.hl-read").count();
        if (hl !== 3) throw Error(`expected 3 highlighted lines, got ${hl}`);
        await page.screenshot({ path: shotPath(tag, `${device}-${c.lang}`, "code-line1000") });
        await page.keyboard.press("Escape");
        }
        await page.locator('[data-reply-preview="1"]').click(); await page.locator(".pv-panel .pv-md").getByText("Example project", { exact: true }).waitFor();
        await page.screenshot({ path: shotPath(tag, `${device}-${c.lang}`, "markdown") });
        await page.keyboard.press("Escape");
        if (!process.env.RETAKE) {
        await page.locator('[data-reply-preview="2"]').click(); await page.locator("dialog.lb[open]").waitFor();
        await page.waitForFunction(() => { const img = document.querySelector("dialog.lb img.lb-img") as HTMLImageElement; return img?.naturalWidth > 0; });
        await page.screenshot({ path: shotPath(tag, `${device}-${c.lang}`, "image") });
        await page.keyboard.press("Escape");
        }
        const pdfResponse = page.waitForResponse((r: any) => r.url().includes("/ui/reply-preview?") && r.url().includes("op=raw") && r.url().includes("example.pdf"));
        await page.locator('[data-reply-preview="3"]').click(); await page.locator('.pv-panel iframe[data-reply-pdf]').waitFor();
        if ((await pdfResponse).status() !== 200) throw Error("PDF raw response failed");
        await page.waitForTimeout(1200); // Let the browser-native PDF viewer finish its first paint.
        if (process.env.DEBUG_PDF) {
          for (const frame of page.frames()) {
            try { diagnostic.push({ frame: frame.url(), html: (await frame.content()).slice(0, 4000) }); } catch (e) { diagnostic.push({ frame: frame.url(), error: String(e) }); }
          }
          writeFileSync(join(process.env.OUT!, `pdf-diagnostic-${device}.json`), JSON.stringify(diagnostic, null, 2));
        }
        if (diagnostic.some((row: any) => row.console && /Refused to (?:display|frame|load)/.test(row.console))) throw Error("Browser refused the PDF preview: " + JSON.stringify(diagnostic));
        await page.screenshot({ path: shotPath(tag, `${device}-${c.lang}`, "pdf") });
        await page.keyboard.press("Escape");
        if (!process.env.RETAKE) {
        await page.locator('[data-reply-preview="4"]').click(); await page.locator('.pv-panel [role="alert"]').waitFor();
        await page.screenshot({ path: shotPath(tag, `${device}-${c.lang}`, "missing") });
        }
        if (errors.length) throw Error(errors.join("\n"));
      }
      results.push({ device, before, errors });
    } finally { await ctx.close(); }
  }
} finally { await fx.close(); rmSync(project, { recursive: true, force: true }); writeFileSync(join(process.env.OUT!, `${tag}.json`), JSON.stringify(results, null, 2) + "\n"); }
