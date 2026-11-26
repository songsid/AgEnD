// The kit's entry point (bundled to dist/recover.cjs): run, then exit with main's code.
import { main } from "./recover.js";

process.exitCode = main(process.argv.slice(2));
