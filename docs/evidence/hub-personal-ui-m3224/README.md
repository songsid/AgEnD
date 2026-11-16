# Personal-agent owner and administrator controls (M-3224)

This UI slice is stacked on the unregistered host slice, #4058. The standard migration registry still omits
`s3-personal-agents`. Production activation and Windows x64 support claims remain held for the approved proof.
No Windows process, user authentication, model, provider or installer was used by this packet.

## Behavior

- Administration → Manage has an off-by-default personal-agent switch and named person/team allowlist.
- My agents explains the shared folder and the owner's AI account, issues a private 15-minute command only on
  request, and shows the computer's actual CLI checks. Codex unavailability leaves Claude's own status visible.
- Explicit Refresh probes only the current owner's computer and rechecks its binding/generation afterward.
  Polling only reads status. Typed edits survive refresh; Save uses the captured revision and sign-in scope.
- Successful Save removes the consumed setup command. Disconnect asks first and keeps history. Ready, Working
  and Answers when connected use the same controls in EN and zh-TW.

## Headless evidence

Run from the UI worktree with its private Playwright installation:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.artifacts/browser-tools/browsers" \
PW_DIR="$PWD/.artifacts/browser-tools" OUT="$PWD/.artifacts/personal-ui/browser" \
node_modules/.bin/tsx scripts/manual/hub-personal/browser.mts
```

The final run at source `2547c660ea6aa9b398fefc9f11080edaaa2f9c60` passed 26 checks and wrote 10 original PNGs.
It uses the product HTTPS shell and real Hub HTTP, SQLite and audit, with an inert directory and Runtime
inventory/turn. It exercises admin allow, owner enrollment, publication, a direct question and disclosed inert
answer, plus ready/working/offline views. It never runs a CLI or installer. The first capture exposed clipping in
the shell's scroll container; the final capture preserves widths 1366 and 390 and expands height only to include
the entire card. A one-time command token is replaced in the DOM for each screenshot and restored afterward.

All 10 final originals were opened for visual inspection. No clipping, large blank bands, horizontal overflow or
visible enrollment token remained. This proves rendering and the inert Hub journey, not Windows enforcement or
real authentication/model execution. The browser receipt and SHA-to-path map bind the original files. The later handler-only delta at `88a592853`
adds synchronous click claims and shared error Retry; normal card markup is unchanged, so these originals carry.

## Focused validation

- `vitest run tests/hub-personal-ui-m3224.test.ts tests/hub-personal-owner-m3224.test.ts --maxWorkers=2`:
  19/19 before the unchanged parent merge. The command-removal follow-up passes 10/10; final synchronous click claims and matching Retry actions pass 12/12.
- `vitest run tests/hub-compose.test.ts -t 'personal receiver registration seam' --maxWorkers=2`:
  2/2, 135 deselected. The unstarted real factory mounts no personal receiver/feature without an explicit
  migration plan; an injected plan keeps defaults off and creates only the private receiver directory.
- The earlier UI/owner/HTTP/shared-serving packet passes 36/36 in four files. These scopes overlap; they are not
  added together. Parent #4058's owner/turns/member tests retain their separate review evidence.
- Both TypeScript programs (`tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.test.json --noEmit`) exit 0 on the combined final source.
- Six selected reversals are semantic assertion failures: captured-sign-in write, stale-owner response,
  refresh binding/generation fence, same-turn click claim, administrator Retry and search Retry intent. Original files were restored byte-for-byte; logs are under `mutations/`.

## Risk and rollback

The principal remaining dependency is the Windows x64 one-folder/authentication proof and explicit activation.
The UI is invisible without `personal-agents-v1`. Roll back the UI slice to hide the cards while retaining the
source layer and journals; do not hard-downgrade a populated personal schema. The host/model rollback prerequisites
in `docs/design/hub-personal-owner-model.md` continue to apply.
