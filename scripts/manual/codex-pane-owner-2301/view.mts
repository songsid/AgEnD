/** Recorded Codex0.167.0 footer in the real View shell; web-only fixture, private tmux, no backend CLI/model/account. */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const repo = process.env.REPO!,
  out = process.env.OUT!;
const home = mkdtempSync(join(tmpdir(), "codex-view2301-"));
process.env.HOME = home;
process.env.CODEX_HOME = join(home, "codex");
process.env.PATH = "/usr/bin:/bin";
process.env.AGEND_TMUX_BIN = "/usr/bin/tmux"; // explicit audited utility override in this scratch source rig
const { bootFixture } = await import(
  repo + "/scripts/manual/smoke-fixture/index.mts"
);
const fx = await bootFixture({ port: 48962, instances: 3, classic: false });
fx.fm.startCliEnvProbeWorker = () => ({
  promise: Promise.resolve(null),
  stopped: Promise.resolve(),
  terminate() {},
});
const { getTmuxSocketName } = await import(repo + "/src/paths.ts");
const { getTmuxSession } = await import(repo + "/src/config.ts");
const socket = getTmuxSocketName(),
  session = getTmuxSession();
if (!socket) throw Error("private socket required");
const { tmuxArgs } = await import(repo + "/src/tmux-binary.ts");
const tmux = (...args: string[]) => execFileSync("/usr/bin/tmux", tmuxArgs(args), { encoding: "utf8" });
const name = fx.instances.find((i: any) => i.backend === "codex")!.name;
const frames = join(repo, "tests/fixtures/codex-pane-owner-2301"),
  selected = join(home, "selected.txt");
writeFileSync(selected, readFileSync(join(frames, "before-ready.pane.txt")));
const render = join(home, "render.py");
writeFileSync(
  render,
  `from pathlib import Path\nimport sys,time\np=Path(sys.argv[1]);last=None\nwhile True:\n s=p.read_text()\n if s!=last:sys.stdout.write('\\033[H\\033[2J'+s);sys.stdout.flush();last=s\n time.sleep(.03)\n`,
);
mkdirSync(out, { recursive: true });
const receipts: any[] = [];
try {
  tmux(
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    "120",
    "-y",
    "24",
    "python3",
    render,
    selected,
  );
  const id = tmux(
    "display-message",
    "-p",
    "-t",
    session,
    "#{window_id}",
  ).trim();
  mkdirSync(join(fx.dir, "instances", name), { recursive: true });
  writeFileSync(join(fx.dir, "instances", name, "window-id"), id);
  for (const device of ["desk", "phone"] as const) {
    const { page, ctx, csp } = await fx.page({
      device,
      theme: "dark",
      lang: "zh-TW",
    });
    try {
      await page.goto(fx.base + "/view/" + encodeURIComponent(name));
      await page.waitForSelector(".v-pre");
      if (device === "phone") await page.locator(".hd-text").click(); // normal View control: Fit → S for readable phone evidence
      for (const [state, file] of [
        ["before", "before-ready.pane.txt"],
        ["after", "after-ready-120.pane.txt"],
        ["narrow", "after-ready-45.pane.txt"],
      ]) {
        tmux(
          "resize-window",
          "-t",
          session,
          "-x",
          state === "narrow" ? "45" : "120",
          "-y",
          "24",
        );
        writeFileSync(selected, readFileSync(join(frames, file)));
        await page.waitForFunction(
          ({ state }) => {
            const text = document.querySelector(".v-pre")?.textContent || "";
            return state === "before"
              ? text.includes("Context 100% left") &&
                  !text.includes("01a1c81a-")
              : state === "after"
                ? text.includes("01a1c81a-35be-7fc0-9a6d-f53f7d6c4c07") &&
                  text.includes("Context 100% left")
                : text.includes("01a1c81a-35be-") &&
                  !text.includes("Context 100% left");
          },
          { state },
        );
        await page.screenshot({
          path: join(out, `${device}-zh-TW-${state}.png`),
          fullPage: true,
        });
        receipts.push({
          device,
          state,
          fontSize: await page
            .locator(".v-pre")
            .evaluate((el: any) => getComputedStyle(el).fontSize),
          noOverflow: await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          csp: await csp(),
        });
      }
    } finally {
      await ctx.close();
    }
  }
  writeFileSync(
    join(out, "view-receipt.json"),
    JSON.stringify(
      {
        scope: "real shell + unmodified recorded panes; no live CLI",
        receipts,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  try {
    tmux("kill-server");
  } catch {}
  fx.fm.stopCliEnvProbes();
  await fx.close();
  rmSync(home, { recursive: true, force: true });
}
