# Windows Runtime build assets (#2965 N8/N9)

The old asset builder hashed a path, then reopened it with `copyFile`. A replacement between those operations could ship bytes that were never verified. It now reads a bounded regular file through one descriptor, checks `dev`, `ino`, size, mode, `mtimeNs` and `ctimeNs` before/after reading and against the path, then verifies and writes that same buffer. A post-verification replacement cannot change the output; a replacement or same-inode rewrite during the read refuses. Windows PE architecture, N-API marker and the eight native SHA-256 pins remain unchanged.

Contributors previously installed all of node-pty 1.1.0 (about 15 MB compressed / 64 MB extracted) and ran its node-gyp install hook on Linux merely to collect Windows prebuilds. The development dependency now points to `vendor/node-pty`: the existing Windows JS closure, eight x64/ARM64 files, typings and licenses, about 3.5 MB. Its local install manifest has no lifecycle scripts or build dependencies. The exact upstream manifest remains `upstream-package.json`; the builder ships that original manifest. All existing Runtime assets and the resulting fixed-input ZIP remain byte-for-byte identical. The vendor README records official npm integrity, extraction rules and file hashes. No native ARM64 execution is claimed.

## Contributor paths

Normal `npm ci` no longer compiles node-pty. Other native dependencies, including better-sqlite3, keep their existing requirements. A compiler-free build-only path is:

```sh
npm ci --ignore-scripts
npm run build
npm run build:runtime
```

This builds the Windows archive without Python, make or a C++ compiler. It does not prepare better-sqlite3 for fleet execution or database tests. Use the ordinary dependency setup for those. No CI install or guard is disabled by this change. An isolated normal install of the local node-pty dependency, with lifecycle scripts enabled, also requires no compiler.

## Evidence and reproduction

`tests/runtime-build-assets-2965.test.ts` swaps real files between verification and output, checks same-size/restored-mtime replacement and same-inode rewrite, and retains a stable-file control. Packaging tests check the local dependency, all eight pins, licenses, original manifest and asset output.

For a full Runtime ZIP comparison, run from the repository root after building:

```sh
mkdir -p .artifacts/n7-n9
npm pack node-pty@1.1.0 --ignore-scripts --pack-destination .artifacts/n7-n9 --json > .artifacts/n7-n9/upstream-pack.json
node scripts/manual/runtime-assets-2965.mjs
```

The smoke verifies the official tarball integrity, reconstructs the old builder's unchanged node-pty assets, and compares all output bytes and both Runtime ZIP SHA-256 values with a fixed fixture version. The xterm assets and Runtime program modules are the same inputs on both sides. Run only on an owned checkout; no provider, account, Runtime process or Windows host is contacted.

N7 custom-profile ACL is a separate change. N8's historical PATH-selected staging interpreter concern is not claimed fixed by this build-copy change. No system Node installation is changed. Rollback restores the old development dependency and builder; there is no data or protocol migration.
