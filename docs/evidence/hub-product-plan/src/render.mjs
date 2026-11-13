import { createRequire } from "node:module"; import { readdirSync } from "node:fs";
const pw = createRequire("/home/han/.cache/a7-main/")("playwright-core"); const b = await pw.chromium.launch({ args: ["--no-sandbox"] });
const p = await (await b.newContext({ viewport: { width: 1240, height: 100 }, deviceScaleFactor: 1.5 })).newPage();
for (const f of readdirSync(".").filter((x) => /^p\d.*\.html$/.test(x))) { await p.goto("file://" + process.cwd() + "/" + f); await p.waitForTimeout(300); await p.screenshot({ path: "../" + f.replace(".html", ".png"), fullPage: true }); console.log(f); }
await b.close();
