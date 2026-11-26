# M-3814: a fixed preview address, and the 429 notice's link to it

Real-app captures from the owned web fixture (`scripts/manual/smoke-fixture`) in headless Chromium. Nothing here opens a tunnel or talks to Cloudflare. Two answers are stubbed, both at the server's decision points:
- **The 429 page.** This page's preview answer is the public link's "failed: rate-limited" (`fm.previewForUi`), exactly as a fixed link's page gets it. No real link is opened.
- **Check's network.** The address resolves, and `https://<address>/frame` answers with this fixture's own preview-listener boot id. The fixed link counts as open.

The page, the routes, the Settings form (a real save into `fleet.yaml`) and the check's own logic are the real ones.

Script: `scripts/manual/preview-fixed-host-m3814/capture.mts`. It ran at `9c9f1003f` (`src` clean) and passed 53 of 53 checks; `receipt.json` lists each check and each PNG's sha256. Desk light en and phone dark zh-TW.

| Frame | What it shows |
|---|---|
| 1-notice | An agent's HTML card whose preview failed on Cloudflare's limit (429). The note says why, and that downloading the file still opens it. Then comes a blue, underlined link: **Set up a fixed preview address** / 「設定固定的預覽網址」. Download is on the card; there is no Preview to press. In zh, 建立 / 臨時連結 / 下載檔案 stay whole. |
| 2-settings-landed | The link pressed: Settings → Access & security → Sharing, at the fixed address's fields (label and field in view). Right below is **Preview address (optional)**. |
| 2c-no-fixed-hostname (desk) | No fixed public hostname yet (the field cleared, not saved), as on a fleet that uses temporary links. There is no preview field, and one line says previews use a temporary Cloudflare link until the fixed public hostname above is filled in. |
| 2b-route-step | Its one Cloudflare step, numbered 1–5, with Cloudflare's own buttons marked as such: Networking → Tunnels → your tunnel → Routes → Add route → Published application; the Hostname field; the Service URL field `http://127.0.0.1:<preview port>`, which names the fixed hostname's port it must not be; save with Add route. Cloudflare adds the DNS record itself. While the address is empty, **Check preview address** is greyed and says why. |
| 3-saved (desk) | `preview.agend.example.net` typed and saved through the form. `fleet.yaml` has `web.public_link.preview_hostname`. The page stays on Sharing after the reload that redraws the form; before this change it fell back to Overview a moment later. |
| 4-check | **Check preview address**: the address named once above four short ✓ rows. The address is saved, the public link is open, the name is found in DNS, and `https://<name>/frame` comes back with this AgEnD's preview boot id ("It works"). |

## What isn't in the pictures (tests)

- `tests/preview-fixed-host-m3814.test.ts`, the server side:
  - Named mode with `preview_hostname` starts **no** quick tunnel. Without it, today's quick-tunnel preview stays.
  - The fixed link's pages frame `https://<name>/frame` with the local listener's boot id.
  - The preview listener answers that Host, and frames the link's dashboard origin, only while the fixed link is open, never while it is starting or after it closes.
  - The validator refuses the name without a fixed hostname, the dashboard's own name, or a name the dashboard answers to.
  - The check's closed codes, and the route is admin only.
- `tests/preview-fixed-host-settings-m3814.test.ts`, Settings:
  - The field is shown only beside a fixed hostname, with the preview port in the step.
  - What is staged, and the refusals.
  - Check sends the address the page shows, and the server answers "save first" for an unsaved one.
  - The Sharing tab is kept across the reload.
  - Both languages.
- `tests/preview-fixed-host-notice-m3814.test.ts` and `tests/task-card-files-ui.test.ts`: the link in the chat card, the side panel and the task-board file card. It shows for this reason only, and never on a guest's page.
