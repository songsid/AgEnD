# S4b isolated CLI acceptance

This rig uses pinned native Claude Code 2.1.316 and Codex 0.166.0 binaries, fake credentials and scripted model replies. Runtime containers have no external network or host mounts. All tmux commands in the owner witness run inside its separate disposable container. No ordinary fleet, real account or host tmux is used.

Build the application and reviewed image explicitly (dependency downloads happen at build time):

```bash
npm run build
mkdir -p .artifacts/hub-s4b-work/image-context/dist/hub/execution
cp dist/hub/execution/sandbox-runner.js .artifacts/hub-s4b-work/image-context/dist/hub/execution/
cp dist/child-process.js .artifacts/hub-s4b-work/image-context/dist/
docker build --iidfile .artifacts/hub-s4b-work/image-config-id \
  -t agend-hub-provider-s4b:local -f scripts/manual/hub-provider/Dockerfile \
  .artifacts/hub-s4b-work/image-context
```

The production factory accepts only the resulting immutable `sha256:...` ID on a local Linux Docker engine, for an amd64 image. Tags, image pulls, remote engines and host-process fallbacks are unavailable. The source Dockerfile is a build recipe; an owner must review the resulting immutable image before explicitly selecting it. Merely building or importing it installs no provider.

```bash
npx tsx scripts/manual/hub-provider/accept.mts
npx tsx scripts/manual/hub-provider/security.mts
npx tsx scripts/manual/hub-provider/lifecycle.mts
npx tsx scripts/manual/hub-provider/crash.mts

docker build -t agend-hub-provider-owner-witness:local \
  -f scripts/manual/hub-provider/Owner.Dockerfile scripts/manual/hub-provider
npx tsx scripts/manual/hub-provider/owner-witness.mts
node scripts/manual/hub-provider/mutate.mjs
```

`IMAGE_ID` overrides the image receipt; `OUT` selects a private artifact directory for each script. The owner-witness image adds tmux solely for an ordinary owner CLI and must never be registered as a restricted provider. Every script removes its own randomly named containers. A failed cleanup is an error; investigate the recorded IDs rather than deleting unrelated containers.

`security.mts` exercises actual signed S1 admission and the real S4 gateway, private SQLite/journals/floors and exact-operation leases. A local fake authority supplies those leases; it does not claim a live directory or complete Hub deployment. It proves two document tools, private-view denial, forced native/custom/foreign tool rejection, local proposal persistence, revocation, answer-release denial, bounded traffic, and cancellation during model/tool work. It inspects actual isolation and probes failed external networking from inside the owned container.

`lifecycle.mts` checks overlapping native sessions for distinct histories, kills the native process in its owned container, and waits for both actual two-minute wall-time bounds. `crash.mts` kills its own controller and checks that the independent runner exits, then removes the stopped owned container metadata. After an abrupt controller death, no daemon is available to remove that metadata immediately; the private tmpfs disappears when the container stops. `owner-witness.mts` preserves private native transcript hashes while a separate restricted question runs with the owner's CLI idle, busy and resumed. Generated private canaries must never enter restricted model requests.

`mutate.mjs` compiles each semantic reversal before requiring a focused assertion failure, restores source in `finally`, and records all logs. Run it without simultaneous source edits or tests. Unit tests use inert Docker/process transports; they do not replace native acceptance.

Member composition supplies `createHubCliProvider({backend,imageId,model,modelBroker,dockerSocket?})`, with `createHubModelBroker({claude?: credential,codex?: credential})`. The model credential remains in the member; only fixed HTTPS Messages/Responses requests leave it. S5 owns local confirmed configuration and provider registration. Without that composition and an explicit owner selection, S4's registry stays empty. The factory's positive result alone does not approve an exposure.

Rollback withdraws exposures, fences current work, awaits service/provider close, and removes the local provider registration. Keep durable journals, version floors and unresolved Needs-you items. Limits: Linux Docker/amd64 only, two pinned CLIs, approved snapshot reads only, no real-account/live-Hub or other-platform claim. Changing versions requires renewed native acceptance.
