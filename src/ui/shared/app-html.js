// #1408: the app's view layer — the vendored Preact (10.29.8) and htm (3.1.1), byte-checked against
// vendor/vendor.json. Templates are tagged literals (html`<div class="x">…</div>`): no JSX, no build step.
// No `style` prop anywhere (the CSP has no 'unsafe-inline' for styles): classes and tokens only.
import { h, render, Fragment, createContext, createRef, cloneElement, toChildArray } from "./preact.module.js";
import htm from "./htm.module.js";

export { h, render, Fragment, createContext, createRef, cloneElement, toChildArray };
export { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useContext, useReducer, useId } from "./preact-hooks.module.js";
export const html = htm.bind(h);
