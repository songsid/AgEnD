// #1408: the web app's own ES modules, imported by the URLs the server serves them at (vitest.config.ts resolves them
// to src/ui/shared/ and src/ui/). They are plain JS with no types: in tests they are `any`.
declare module "/assets/*";
declare module "/ui/js/*";
