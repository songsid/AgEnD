# M-3897: retire or withdraw earlier requests before the first turn-on

These are real-app captures of Settings → Access & security from this checkout, on the shared smoke fixture (`scripts/manual/smoke-fixture`): an in-process dashboard with no fleet started.

- **The server's answer.** Only `GET /api/settings/request-context` answers, with the view the controller gives before the first turn-on on a fleet holding:
  - an earlier ticket with no readable delivery record (Retire);
  - an earlier queued delivery (Withdraw);
  - an earlier delivery that ended uncertain (named, no action);
  - a Go back offer still open.
- **Shots:** the section, and the Retire confirmation, which says the consequence and that Go back ends.
- **Variants:** desk light en and phone dark zh-TW.
- **Regenerate:**

  ```sh
  PW_DIR=<dir with playwright-core> CHROME=<chromium> REPO=$PWD OUT=<dir> npx tsx scripts/manual/smoke/smoke-m3897-retire.mts
  ```

The version badge in the header is the fixture's own.
