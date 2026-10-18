/** #2115: a host-owned Settings action must stay inside the real client/server route table. */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { shellRoute } from "../src/web-shell-routes.js";
const routes = await import("/assets/app-route.js") as {
  SETTINGS_SECTIONS: string[]; settingsPath(section?: string): string; parseRoute(path: string): { panel: string; section: string } | null;
};
function scripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? scripts(join(dir, e.name)) : e.isFile() && e.name.endsWith(".js") ? [join(dir, e.name)] : []);
}
describe("every in-app Settings destination", () => {
  it("resolves every fixed Settings link or helper template in a UI module", () => {
    const seen: string[] = [];
    for (const file of scripts(join(process.cwd(), "src/ui"))) {
      for (const match of readFileSync(file, "utf8").matchAll(/["'`](\/(?:ui\/)?settings[^"'`\s]*)["'`]/g)) {
        const literal = match[1]!;
        // app-route's sole dynamic template is expanded through every supported section, not skipped.
        const paths = literal === "/settings/${section}" ? routes.SETTINGS_SECTIONS.map(routes.settingsPath) : [literal];
        expect(literal.includes("${") && literal !== "/settings/${section}", file).toBe(false);
        for (const path of paths) {
          const pathname = new URL(path, "http://localhost").pathname, label = relative(process.cwd(), file) + ": " + path;
          expect(routes.parseRoute(pathname), label).toMatchObject({ panel: "settings" });
          expect(shellRoute("GET", pathname), label).toMatchObject({ kind: "shell", route: { panel: "settings" } });
          seen.push(relative(process.cwd(), file));
        }
      }
    }
    expect(seen).toContain("src/ui/panel-chat.js");
    expect(seen).toContain("src/ui/chat-effects.js");
    expect(seen).toContain("src/ui/shared/effect-stock-trust.js");
  });
  it("settingsPath covers each supported section and its default", () => {
    for (const section of [undefined, ...routes.SETTINGS_SECTIONS]) {
      const path = routes.settingsPath(section);
      expect(routes.parseRoute(path)).toMatchObject({ panel: "settings", section: section ?? "agents" });
      expect(shellRoute("GET", path)).toMatchObject({ kind: "shell", route: { panel: "settings", section: section ?? "agents" } });
    }
  });
});
