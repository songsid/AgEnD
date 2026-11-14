// Scoped Settings screenshot: real fixture, fake data, no fleet start or vendor CLI.
import { loadavg } from "node:os";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture } from "../../../scripts/manual/smoke-fixture/index.mts";
if (loadavg()[0] > 10) throw new Error("load gate >10");
const fx = await bootFixture({ port: 47960, instances: 12 });
try {
  const { page } = await fx.page({ device: "phone", theme: "dark", lang: "zh-TW" });
  await page.goto(`${fx.base}/settings/preferences`);
  const select = page.locator("#pref-density");
  await select.scrollIntoViewIfNeeded();
  const box = await select.boundingBox();
  if (!box || box.height < 44 || box.width < 44) throw new Error("density control below tap minimum");
  await page.screenshot({ path: join(process.cwd(), "docs/evidence/sidebar-density-3129/phone-preferences-r1.png") });
  writeFileSync("docs/evidence/sidebar-density-3129/settings-control.json", JSON.stringify({ width: box.width, height: box.height, value: await select.inputValue() }, null, 2));
  console.log(JSON.stringify({ width: box.width, height: box.height }));
} finally { await fx.close(); }
