/** Testable stdio entry; the installed command calls the same serve function. */
import { getAgendHome } from "../paths.js";
import { requestOwnerApp } from "./control.js";
import { serveOwnerApp } from "./stdio.js";
await serveOwnerApp((operation, input) => requestOwnerApp(getAgendHome(), operation, input));
