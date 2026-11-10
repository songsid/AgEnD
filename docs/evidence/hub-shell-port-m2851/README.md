# M-2851: Hub shell gate owns its assigned port

The first attempt of [alpha CI 42838294972](https://github.com/songsid/AgEnD/actions/runs/42838294972/attempts/1), ui-gate job `129906483272`, failed before assertions: `listen EADDRINUSE 127.0.0.1:48748`. The gate chose `48700 + floor(random * 90)` without reserving that port. Its `s3bRig` already owns a separate HTTP listener on port0; the job's gates run sequentially, but that does not make a random TCP port exclusive. The log does not identify which listener held48748.

The HTTPS server now binds **once to port0** and retains that reservation through certificate provisioning and Hub composition. `server.address().port` supplies the actual origin to TLS identity metadata, the HTTP rig and browser navigation. The certificate is configured before the origin is published/used by the browser. Startup failures close the listener and private keys; normal cleanup awaits close. There is no free-port probe/close/rebind, retry loop, widened range, changed assertion or increased deadline. Product source and the workflow are unchanged.

## Reproduction and control

`accept.mjs` runs three distinct, single attempts with one browser/font configuration:

1. Occupy every old port48700–48789 with owned loopback listeners; the unmodified control head exits1 with EADDRINUSE before layout checks.
2. Release them and run the same unmodified control: **170/170** pass.
3. Occupy the same range again and run the committed candidate: **170/170** pass at assigned port40701.

Both complete result maps are identical after removing elapsed seconds. `receipt.json` binds original control `e1b88cd8edd4d6c4656a6dbae8f9c68239025dee`, candidate source, trees, served source inputs, harness digest, Chrome156.0.8078.4, Playwright1.64.1 and the same verified Noto CJK Fontconfig. Protected input trees were clean at execution. The legacy range was entirely owned for this run; an already occupied port would only be recorded, never stopped or modified. All owned reservation close callbacks completed. Fixture private keys are removed, not included in evidence.

This is the existing `GATE=ci` desktop/light/EN + phone/dark/zh-TW matrix, not a fresh GitHub-hosted control or full matrix claim. Screenshots were produced locally; the committed check maps and receipts are the comparison evidence. No UI/product source changed.

Reproduce in an owned checkout, with a detached control at the pinned SHA and its dependencies available:

```sh
REPO=<candidate> CONTROL=<control> OUT=<owned-output> \
CHROME=<installed-chrome> PW_DIR=<directory-with-playwright-core> \
FONTCONFIG_FILE=<verified-fontconfig> node docs/evidence/hub-shell-port-m2851/accept.mjs
```

## Focused checks

`checks.json`: **122/122** in six listener/shell/S3b/TLS/changelog suites, zero skips; test typecheck passes. The four listener controls are rechecked at the committed source. `mutations.json` records **5/5** compiling semantic reversals caught by selected tests: fixed port, incorrect returned port, released reservation, swallowed bind failure and leaked error listener after synchronous refusal. Original files are restored in `finally` by `mutate-listener.py`.

Main was inspected at `6ef9f3f6bdceabedf42e3feaf83c40a8218e3f1e`: its CI workflow has no Hub shell gate step, so no main twin applies. Risk: an OS/resource bind failure now surfaces directly rather than being retried. Roll back with an ordinary script/helper/test revert; no runtime state or configuration changes.
