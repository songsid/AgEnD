# Inter (bundled, #1408)

`inter.woff2` is Inter 4.1 by The Inter Project Authors, under the SIL Open Font License 1.1 (`OFL.txt`, copied unchanged from the release).

- Source: `Inter-4.1.zip` from https://github.com/rsms/inter/releases/tag/v4.1 (sha256 `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`), file `InterVariable.ttf`.
- Changed from the original, as the OFL allows for a modified version. The font keeps its name, because Inter declares no Reserved Font Name.
  - The weight axis is kept (100–900).
  - The optical-size axis is fixed at its text size (`opsz=14`).
  - The font is subset to Latin, with the same range as `unicode-range` in `tokens.css`.
  - It is saved as WOFF2. About 44 KB, against 352 KB for the full variable font.
- Chinese and other scripts fall back to the system fonts named in `--font-ui` (PingFang TC → Noto Sans TC → Microsoft JhengHei → the system stack).

Rebuilt with fontTools 4.59 (and `brotli` for WOFF2):

```sh
python3 -m fontTools.varLib.instancer InterVariable.ttf opsz=14 -o inter-opsz14.ttf
pyftsubset inter-opsz14.ttf \
  --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-2193,U+2212,U+2215,U+FEFF,U+FFFD" \
  --layout-features="kern,liga,calt,tnum,case,ccmp,locl,mark,mkmk" \
  --flavor=woff2 --output-file=inter.woff2
```
