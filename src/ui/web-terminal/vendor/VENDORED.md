# Vendored browser assets for the web terminal

These files are copied verbatim from the official npm tarballs (`npm pack`) and
served by AgEnD itself (`/t/<sid>/assets/*`). They are **not** install-time
dependencies: the CSP of the terminal page forbids every external origin, so
the fleet must ship them. All three packages are MIT licensed (see LICENSE.*).

| file | package | version | tarball sha512 (npm `dist.integrity`) |
|---|---|---|---|
| xterm.js, xterm.css | @xterm/xterm | 6.0.0 | sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg== |
| addon-fit.js | @xterm/addon-fit | 0.11.0 | sha512-jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g== |
| addon-web-links.js | @xterm/addon-web-links | 0.12.0 | sha512-4Smom3RPyVp7ZMYOYDoC/9eGJJJqYhnPLGGqJ6wOBfB8VxPViJNSKdgRYb8NpaM6YSelEKbA2SStD7lGyqaobw== |

The only local edit: the trailing `//# sourceMappingURL=…` line was removed
from all three .js files (no source maps are shipped). To refresh:

```
npm pack @xterm/xterm@<v> @xterm/addon-fit@<v> @xterm/addon-web-links@<v>
tar xzf …; cp package/lib/*.js package/css/xterm.css package/LICENSE here
```

then update this table with the new versions and `npm view <pkg> dist.integrity`.
