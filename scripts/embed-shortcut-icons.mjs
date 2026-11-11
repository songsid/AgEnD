#!/usr/bin/env node
// M-2885: write the Windows installer's embedded shortcut icons (website/public/install-agend.ps1, between the
// ">>> shortcut icons" and "<<< shortcut icons" lines) from templates/icons/*.ico (scripts/build-shortcut-icons.py).
// The standalone installer has no package to read them from, so it carries the bytes; tests/shortcut-icons-2885.test.ts
// checks the block decodes to exactly the committed files. Run after rebuilding the icons.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const INSTALLER = join(ROOT, "website", "public", "install-agend.ps1");
export const ICON_NAMES = ["agend.ico", "agend-restart.ico"];
const OPEN = "# >>> shortcut icons";
const CLOSE = "# <<< shortcut icons";

export function iconBlock(read = name => readFileSync(join(ROOT, "templates", "icons", name))) {
  return [
    `${OPEN}（M-2885：桌面捷徑的圖示，由 scripts/embed-shortcut-icons.mjs 從 templates/icons 寫入；不要手改）`,
    "$AGEND_ICONS = @{",
    ...ICON_NAMES.map(name => `  '${name}' = [Convert]::FromBase64String('${read(name).toString("base64")}')`),
    "}",
    CLOSE,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = readFileSync(INSTALLER, "utf8");
  const start = text.indexOf(OPEN), end = text.indexOf(CLOSE);
  if (start < 0 || end < start) throw new Error(`missing the "${OPEN}" … "${CLOSE}" block in ${INSTALLER}`);
  writeFileSync(INSTALLER, text.slice(0, start) + iconBlock() + text.slice(end + CLOSE.length));
  console.log("embedded", ICON_NAMES.join(", "));
}
