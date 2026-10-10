# Upstream CLI precheck

The first, mechanical step of the daily upstream-CLI watch (decision ffb8104e).
1. `~/.agend/scripts/check-cli-versions.sh` reports a backend CLI whose newest upstream release has not been audited.
2. This precheck compares that release with the last audited one: the text AgEnD's detectors match on, statically.
3. Its last line is the verdict:
   - **MAJOR** goes to a full live audit (dev-claude or Fable).
   - **NONE** or **MINOR** is marked audited (`check-cli-versions.sh --mark-audited`), with the output kept as the record.

It never runs a CLI, never starts tmux and never touches the network.
- Archives are read in memory, member by member; nothing is extracted, and nothing is written.
- `precheck.py` imports only standard-library modules that read files and parse text. `tests/cli-upstream-precheck.test.ts` holds the exact import list.

## What haiku runs

For backend `<cli>` (one of `claude`, `codex`, `opencode`, `muse`, `kiro-cli`, `grok`, `agy`), with `<old>` the last audited version and `<new>` the upstream one:

```sh
S=<a fresh scratch dir>
~/.agend/scripts/check-cli-versions.sh --download <cli> <old> "$S/old"
~/.agend/scripts/check-cli-versions.sh --download <cli> <new> "$S/new"
python3 -I scripts/manual/cli-upstream-precheck/precheck.py <cli> "$S/old" "$S/new" > "$S/precheck.txt"
tail -n 20 "$S/precheck.txt"
```

Run it from the AgEnD repo root.
- **Inputs:** either one may be a native binary, an npm `.tgz`, a `.tar.gz`, a `.zip`, a gzip file, or a directory holding any of these.
  - Every format `--download` produces is covered: claude, grok and muse as a binary; codex and opencode as an npm tgz; kiro-cli and agy as a `.tar.gz`.
- **No old version:** when `--download` cannot fetch the old one (agy's download always gives the latest), use the host install instead, e.g. `~/.local/bin/agy`.
- **Run time:** about 1 to 3 minutes per pair; a package of several hundred MB takes longest.

## Reading the output

The verdict is the last line: `PRECHECK: MAJOR`, `PRECHECK: MINOR` or `PRECHECK: NONE`. The lines just above it, `REASON: …`, say why. Copy both into the report as they are; do not re-judge them.

The sections above them hold the evidence:

| section | means |
|---|---|
| `literals in the old artifact: N of M` | how many of the backend's detector literals the old release contains (the rest are AgEnD's own words, or text this CLI never had) |
| `MISSING` | in the old release, not in the new: **a detector would stop matching** → MAJOR |
| `COUNT CHANGED` | still present, a different number of times: usually prose churn → MINOR |
| `APPEARED` | absent before, present now → MINOR |
| `NEW PROMPT-LIKE STRINGS near a known detector literal` | a new "Do you want…?", "Press … to", "Yes, and…", "Allow …?", "(y/n)", retry or rate-limit string within 600 bytes of a detector literal: a new or changed dialog on that surface → MAJOR |
| `NEW PROMPT-LIKE STRINGS elsewhere` | the same kind of string, away from every detector literal → MINOR |
| `PROMPT-LIKE STRINGS gone` | for the auditor; not part of the verdict |

Each literal line shows `[surface] old -> new "text" (file:line declaration)`.
- **Surfaces:** dialog, approval, trust, onboarding, resume, error, idle-busy, input-box, exit, other.
- **Where to look:** the file and declaration are where AgEnD matches that text. The line is where it was when the manifest was last built.

A MAJOR verdict also comes from:
- **Too little text found:** fewer than 3 of the backend's literals in the old release. The check cannot see the CLI's text, perhaps because it is compressed or encoded.
- **A failed run:** a path that does not exist, or an unknown backend. The verdict line is then still printed, after a `REASON: the precheck could not run`.

## Limits

- **Compressed or encoded text** inside a native binary is not decoded. Gzip files and archive members are. A CLI whose text is hidden this way shows up as the coverage MAJOR above, never as a silent NONE.
- **Text forms counted:** each literal as UTF-8, as UTF-16LE (some JS engines store strings that way) and in its JSON-escaped form (minified bundles).
- **Prompt-like strings** are compared with minified names inside `${…}` blanked out. Trailing 1–2 character tokens are dropped, because a string table's next-entry header can be a printable byte. This keeps renames between builds from looking new.
- **What this does not cover:** file formats AgEnD reads (session journals, rollouts, databases), and behaviour (when a dialog appears, what a key does). The live audit covers those; this is only a gate for it.

## The manifest

`manifest.json` lists every detector literal per backend, generated from `src/` with the TypeScript parser.
- **What it reads:** `sources.json` names the files and declarations.
- **What it keeps:** string literals, template parts, and the literal text runs of regexes, including `new RegExp("…")`.
- **What it leaves out:**
  - the fields of a dialog/error entry that hold AgEnD's own words (`description`, `message`, …);
  - the arguments of `t()`, logger calls and Error constructors;
  - the declarations `sources.json` excludes (command builders, config writers, CLI help parsers).

When a detector changes in `src/`, rebuild it:

```sh
npx tsx scripts/manual/cli-upstream-precheck/build-manifest.ts           # rewrites manifest.json
npx tsx scripts/manual/cli-upstream-precheck/build-manifest.ts --check   # exit 1 when it is stale
```

`tests/cli-upstream-precheck.test.ts` fails when `manifest.json` no longer matches the source, so a detector literal cannot be added or changed without the manifest. A new detector file or declaration has to be added to `sources.json`. The test does not compare line numbers; they move with any edit above them.
