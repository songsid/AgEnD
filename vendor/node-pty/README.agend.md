# Windows build assets for node-pty 1.1.0

This local development dependency avoids running node-gyp on Linux to collect Windows code assets. It is not a Linux PTY implementation. The Runtime's Windows-only adapter and install layout are unchanged.

Source: the official npm `node-pty@1.1.0` tarball, https://registry.npmjs.org/node-pty/-/node-pty-1.1.0.tgz

- npm integrity: `sha512-20JqtutY6JPXTUnL0ij1uad7Qe1baT46lyolh2sSENDd4sTzKZ4nmAFkeAARDKwmlLjPx6XKRlwRUxwjOy+lUg==`
- npm shasum: `161936d45a47751c2e3b694c365e73017417a887`
- Included: the existing Runtime JS closure, typings, license, and its eight already-pinned x64/ARM64 ConPTY files. No C++ sources, node-gyp, Linux native binary, lifecycle scripts, or transitive build dependency.
- `package.json` is a minimal local install manifest. `upstream-package.json` retains the exact upstream manifest; the asset builder ships that original manifest, preserving every existing node-pty Runtime asset byte. `upstream-files.sha256.json` records the extracted files.
- `CONPTY-LICENSE` and `CONPTY-NOTICE.md` are exact copies of the existing reviewed supplements in `templates/runtime-assets/`.

To update: fetch the official tarball without lifecycle scripts, verify npm integrity, extract only the reviewed asset list and typings, retain the upstream manifest, regenerate the file hashes, and separately review any changes to `PANE_NATIVE_SHA256`. Never replace a pin with an unverified local build. These packaging checks do not claim a native ARM64 run.
