# Web smokes on a realistic fixture

Real-browser smokes for the web dashboard. They run against one shared, deliberately stressful fixture
(`../smoke-fixture/`) instead of a toy fleet:
- 60 instances with long Latin and long CJK names, display names and teams, every backend, and some crashed, stopped
  and paused;
- ClassicBot rooms;
- generated pictures at real sizes: tall, wide, tiny, huge and transparent, plus one over the avatar cap;
- CJK text at the caps: a 60-grapheme tagline and a 280-grapheme bio;
- widgets at their item cap;
- a mod near the size cap with eight effects;
- a long owner CSS sheet;
- long plan and profile names;
- emoji sequences a font may draw unjoined.

They use no account and no network, and never start a fleet. Each smoke builds a `FleetManager` in a scratch
`AGEND_HOME`, stubs the lifecycle, serves the dashboard and its preview origin on its own ports, signs in with a login
code, and drives Chromium through playwright-core.

**Port ownership:** both ports (`HP`, `HP+1`) must be free, or the boot is refused. The fleet's own health and preview
servers must be bound to them before any page opens, so a smoke never talks to a listener it didn't start, a live
fleet included. The EADDRINUSE takeover is disabled.

**Cleanup:** `fx.close()` releases the browser, both listeners and the scratch home. Each step runs on its own, and
calling it twice is harmless. It also runs on an uncaught error, a rejection, SIGINT or SIGTERM, which then exit 1.
`fixture-controls.mts` checks all of this.

## Run

```sh
PW_DIR=~/.cache/agend-smoke/pw MATRIX=quick scripts/manual/smoke/run.sh                # every smoke, 2 at a time
PW_DIR=~/.cache/agend-smoke/pw MATRIX=full  scripts/manual/smoke/run.sh smoke-1936.mts  # one smoke
```

**Settings:**
- `PW_DIR`: a directory whose `node_modules` has playwright-core.
- `CHROME`: optional; a Chrome to launch instead of playwright-core's own Chromium (`npx playwright-core install chromium` in `PW_DIR`).
- `OUT`: where the logs and screenshots go (default `/tmp/smoke-out`).
- `MATRIX` picks the cases:
  - `full`: desk 1366 and phone 390 × light and dark × en and zh-TW;
  - `quick`: `desk-light-en,phone-dark-zh-TW`;
  - a comma-separated list of case names.

**Memory:** each smoke runs in a `systemd-run --user --scope -p MemoryMax=$MEM` scope (default 3G), `JOBS` at a
time (default 2). The script refuses to start below 6 GB available. Anything an instance runs lives inside the fleet's
cgroup, so an unbounded browser job can take the whole fleet down. `smoke-chat-switch` always runs alone, because it
times renders. `run.sh` exits non-zero when any smoke fails: its own failure, a timeout (124), an OOM kill (137) or
systemd-run itself. Every log is kept.

To run one smoke by hand:

```sh
REPO=$PWD OUT=/tmp/o MATRIX=quick HP=48600 FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-mod-effects.mts
```

Shots land in `$OUT/<smoke>/<case>-<shot>.png`, with a `result.json` next to them. Every smoke records CSP
violations and page errors.

## Writing one

```ts
import { bootFixture, matrix, caseName, shotPath, labelOf, seedPerson, seedCards } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48700) });
await seedCards(fx, [fx.instances[4].name]);
for (const c of matrix()) {
  const { ctx, page, csp } = await fx.page(c);   // theme + language are host prefs; every case starts from clean prefs
  await page.goto(`${fx.base}/ui/fleet/org`);
  await page.screenshot({ path: shotPath("my-smoke", c, "org") });
  await ctx.close();
}
await fx.close(); process.exit(0);
```

### Seeders (`seed.mts`)

| seeder | what it adds |
|---|---|
| `fx.seedTheme(name, theme)` | a theme, with card text checked by the product's own canonical rules and read back. Throws on a refusal. `ThemeStore.setTheme` alone doesn't validate |
| `seedPerson` | the person |
| `seedAvatars` | avatars |
| `seedCards` | portrait, banner, and tagline/bio at their caps |
| `seedIdentityColors` | identity colours |
| `seedWidgets` | `chat_header` at its item cap, and `details` |
| `seedChat` | messages with CJK tables, code blocks and served pictures |
| `seedUsage` | three providers, one with a long plan |
| `ownerCss(bytes)` | an owner CSS sheet of the given size |
| `addSnowEffect` | a drawing canvas-worker effect |
| `bigMod` | a mod near its size cap |

## From defaults (fleet decision a78ebdc5)

`fx.page()` seeds what a new person never has: it skips the tour and first-run, sets prefs, and signs in with an
owner-less code. Every user-visible feature also needs a **from-defaults** smoke:
- a fresh profile with nothing seeded, driven only through visible UI;
- it passes only if the user sees the feature, or the UI names the blocking reason with a link that fixes it;
- the blocked state is a tested state: screenshot it and assert its message.

```ts
import { bootFixture, freshPage, mounted, openPublicLink, shotPath } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48700) });
// Loopback, nothing seeded, signed in as a synthetic account of its own; reduced motion; a phone.
const a = await freshPage(fx, { device: "phone", theme: "dark", lang: "en" }, { reducedMotion: true });
if (!(await mounted(a.page)) || a.errors.length) throw new Error("did not mount");   // a.errors: from before the first navigation
// A real non-localhost origin: the page is on http://dashboard.lan.example:<port> (location, secure context, storage).
const b = await freshPage(fx, { device: "desk", theme: "light", lang: "en" }, { origin: "lan" });
// The temporary public link, real end to end inside the product.
const link = await openPublicLink(fx);
const c = await link.publicPage({ device: "phone", theme: "light", lang: "en" });
await link.close();
```

- **Accounts.** Each `freshPage` signs in as a new synthetic Discord account (`demoAccount()`), so its session is bound
  to that account like a real DM code. `{ account: "operator" }` is the owner-less `agend web` case, used only on
  purpose.
- **Prefs.** Before each case, what that viewer would read must be empty: `WebPrefsStore.readForViewer`, the host's prefs
  plus that person's. The public link's viewer reads the host's only.
  - **A new account doesn't isolate the host.** Host-wide settings (`preview.optIn`, `fx.show`, `theme`, `lang`, …) reach
    every account, so a consent another case gave, or an earlier `fx.page()` run, is not a default state.
  - **Refused, never cleaned or rewritten.** A polluted store refuses, and so does one that can't be read. Run
    from-defaults cases on a fixture of their own (or before anything writes prefs).
- **Errors.** `errors` collects page errors and console errors from before the first navigation. The sign-in page's own
  `/auth/session` 401 before signing in is kept apart in `expected`.
- **Mounted.** `mounted(page)` waits for the app's visible navigation (the sidebar, or the phone's tab bar) with a
  control in it. The empty `#app` the page ships with doesn't count.
- **Fault injection.** `beforeNavigate(ctx, page)` runs before the first navigation, for negative controls.

**What is not real, exactly** — everything else the browser does goes through the product:
- **the sign-in code's delivery:** it's issued directly to the synthetic account, as its DM would carry it;
- **the name `dashboard.lan.example`:** the fixture's Chromium resolves it to 127.0.0.1 (`--host-resolver-rules`), and
  the harness adds it to `web.allowed_hosts`;
- **for the public link:**
  - the Cloudflare tunnel (TunnelPurposeLane's manager);
  - the cloudflared install (`ensure`) and process (`provider`);
  - PublicWebLink's `permitted`, the Discord-side owner check;
  - FleetManager's `confirmPublicWebLogin`, replaced whole: the General notice is recorded in `link.notices`, not posted;
  - the transport: Playwright terminates `https://demo-smoke-link.trycloudflare.com` in the browser and carries each
    request to the gateway's local port with that Host, instead of Cloudflare's edge, and refuses event streams (the
    public link polls by design).

  The PublicWebLink lifecycle, the gateway (`createPublicWebGateway`), its Host pin, its route list, the origin checks
  and the `__Host-` cookie are the product's own.

`scripts/manual/smoke/smoke-from-defaults-probe.mts` checks the harness itself:
- the loopback, LAN, operator and public cases;
- the location and secure context of each;
- negative controls that must be caught:
  - a boot that throws;
  - a boot that never mounts;
  - a host consent written by another account through the product's write path, refused for a new account and on the
    public link;
  - an unreadable prefs store;
- and a positive control: a separate clean fixture signs in and mounts.

`scripts/manual/smoke/smoke-1939-authorize-defaults.mts` (#1939 "Authorize this browser" and Settings → Web → Web
authority) uses the harness and stubs two more things, both outside the product:
- **the account's Discord DM:** a stub adapter records the Confirm card and its edits; the smoke draws the card on a
  neutral page, shoots it and reads its text back, and taps its buttons through FleetManager's own callback dispatch;
- **the card's five minutes:** the card's monotonic clock is moved forward instead of waited for (`REAL_EXPIRY=1` waits
  the real five minutes for the expiry case). `ONLY=confirm,expiry,…` runs some cases.

The demo connection's fleet-admin list is fleet config the smoke writes, as an operator would.

`scripts/manual/smoke/smoke-2170-web-verified-apply.mts` (#2170 a web-verified admin's own Apply confirms a held
change) builds on the same stubs: two demo Discord connections — the agents' and General's — whose admin lists the smoke
writes; General's adapter records what would be posted there (a chat card or the notice, the notice drawn on a neutral
page and shot). The held change is Settings → Agents → Delete agent, with the lifecycle's stop stubbed as in
`smoke-delete-agent.mts`. The admin lists are two arrays, never one shared: one shared array would be written as a YAML
alias between them (writing through one is #2208's own smoke). `PW_ENGINE=webkit` runs the same cases.

`scripts/manual/smoke/smoke-2208-yaml-shared-nodes.mts` (#2208) writes the operator's own fleet.yaml with two
connections sharing one admin list through `&admins` / `*admins`, then loads it, and puts it back before each case. It
adds a user to one connection through Settings → Connections, and the admin's confirmation is the store's decide (as
in `smoke-delete-agent.mts`). An access edit only writes fleet.yaml and marks a restart as needed, so no adapter
starts. The same smoke on a checkout without the fix fails: the anchor holder's edit also lands on the other
connection, and the alias holder's never applies.

`scripts/manual/smoke/smoke-2122-usage.mts` (#2122 Fleet → Usage) uses the harness with what the product reads made
real: Claude Code transcripts and a Codex rollout in their real shapes (`tests/fixtures/cache-1468`, copied onto recent
days) in a scratch `CLAUDE_CONFIG_DIR` / `CODEX_HOME` set before the fleet boots, never the host's. Each demo instance
gets its own working directory (the fixture's share one, which the report would call "shared"). One instance's rollup
file carries an older day, so the heatmap has never-collected days; that instance joins the fleet only after the empty
case, so the product reads its rollup fresh. A rollout written within the rollout index's 1 s listing cache is seen on
the next pass, so the smoke waits until the product has read every source.
`PW_ENGINE=webkit` runs the same cases in WebKit. Its system libraries come with the Playwright image, so it runs there
with the host's Node (the checkout's native modules are built for it), as your user, on the host network:
`docker run --rm --network host --user $(id -u):$(id -g) -e HOME=/tmp -e PW_ENGINE=webkit -e PW_DIR=/pw -e REPO=$PWD
-e OUT=/out -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -v $PWD:$PWD -v $PW_DIR:/pw:ro -v <node dir>:/node:ro -v <out>:/out
-w $PWD mcr.microsoft.com/playwright:v1.64.1-noble /node/bin/node node_modules/tsx/dist/cli.mjs
scripts/manual/smoke/smoke-2122-usage.mts`. WebKit has no host resolver rules, so its phone case is on loopback. Its own
console lines (a `<select>`'s internal sheet, the viewport meta's interactive-widget) are accepted and printed apart, as
in smoke-ambient; a poll or stream a navigation cancels (and the Settings page's own fetch it cancels, "Load failed")
only within the smoke's own navigations, for those URLs — anywhere else they fail.

`scripts/manual/smoke/smoke-usage-bar-caps.mts` (the usage page's per-row bar) seeds three Claude Code instances the
same way, at 100%, 95% and 5% of the top row. On desk and phone it checks that every bar is drawn at a uniform scale (its
screen matrix scales x and y alike, so the rounded ends stay circles) and that each fill is its share of the track, and
shoots the 100% and 95% bars with a margin. `PW_ENGINE=webkit` runs it in WebKit, as above.

## Pitfalls (each one cost a run)

- **Language** is the host pref `lang` (`fx.page` writes it). `localStorage.agend_lang` alone leaves the page in English.
- **Label locators** must be locale-aware. An English-only locator makes the zh-TW cases silently skip that check, so
  use `labelOf(c, { en, zh })`.
- **`page.waitForFunction` with a string predicate** is compiled in the page, and the dashboard's CSP refuses eval.
  Pass a function.
- **Functions passed to `page.evaluate`** get tsx's `__name` helper, which the page doesn't have. Pass a string
  expression instead for anything with nested arrow functions.
- **Effects need preview opt-in:** `fx.page(c, { storage: { agend_html_preview: "on" }, prefs: { "preview.optIn": true, "fx.show": true } })`.
- **The chat composer is autofocused on open.** A focused editable is a protected-UI barrier, so agent foreground
  effects don't start until you blur it.
- **The ⋯ menu and the Effects dialog are barriers too.** A foreground effect stops while either is open.
- **`FONTCONFIG_FILE=/etc/fonts/fonts.conf`** is needed when the environment is stripped, or Chrome crashes on font
  fallback.
- **Keep Chrome's profile/tmp paths short.** A long path overflows its SingletonSocket and the browser won't start.
- **This host has no colour-emoji font,** so emoji sequences draw unjoined (a family as three people). That's a
  feature for width tests.
