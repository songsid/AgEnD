# Development Setup

Notes for working on AgEnD itself. For using AgEnD, see [features](features.md) and
the [CLI reference](cli.md).

## Point `gh` at the right repo

`origin` is `songsid/AgEnD` and `upstream` is `suzuke/AgEnD`. The `gh` CLI resolves
its default repo from the remote set, not from `origin`, so it can land on `upstream`
and fail in a way that reads like a git problem:

```
pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be
blank, No commits between main and <your-branch>, Head ref must be a branch
```

The branch is pushed and fine — `gh` is just asking the wrong repo. Fix it once per
clone:

```bash
gh repo set-default songsid/AgEnD
```

Or pass `--repo songsid/AgEnD` on every invocation.

## Rebuild native modules after a Node version change

`better-sqlite3` is a native addon compiled against a specific Node ABI. Switching
Node versions (nvm, a system upgrade) leaves it built for the old one, and **every
SQLite-backed test fails at once** — well over a hundred — with:

```
The module '.../better_sqlite3.node' was compiled against a different Node.js
version using NODE_MODULE_VERSION 115. This version of Node.js requires
NODE_MODULE_VERSION 127.
```

```bash
npm rebuild better-sqlite3
```

Worth recognising on sight: a sudden mass failure across unrelated suites is this,
not a regression you just introduced.

## Tests

```bash
npm test              # vitest, watch
npm test -- --run     # single pass
npx vitest run tests/some-file.test.ts
```

Two things `vitest.config.ts` handles for you, both of which used to be able to kill
a running production fleet from a test run:

- **`AGEND_HOME`** is set to a fresh temp directory per run. Without it,
  `getAgendHome()` falls back to the real `~/.agend`, and a `FleetManager` built in a
  test reads the live `instances/<name>/daemon.pid`.
- **`NOTIFY_SOCKET`** is blanked. Inherited from systemd, `FleetManager.stopAll()`'s
  `sdNotify("STOPPING=1")` would tell systemd to stop the real unit — a path that
  bypasses `AGEND_HOME` isolation entirely.

`tests/test-isolation.test.ts` asserts both are in effect, so a config regression
fails loudly instead of silently.

`dist/**` is excluded from collection. `npm run build` copies compiled test files
there, and running those stale copies both inflates the test count and invites a
confusing "dist fails but src passes" report once source moves on.

## Verifying before a PR

```bash
npx tsc --noEmit
npm run build
npm test -- --run
```

`tsc --noEmit` and `npm run build` never construct a `FleetManager`, so they are safe
regardless of the above.
