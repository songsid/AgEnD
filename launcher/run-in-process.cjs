"use strict";
// Loaded only when the running Node is the selected one — a Node new enough to parse `import()`; older Nodes never
// load this file, so their parse of the launcher stays clean. process.argv[1] becomes the inner entry, as when the
// CLI is run directly (service install, completion and restart read it).
var url = require("url");

module.exports = function runInProcess(entry) {
  process.argv[1] = entry;
  return import(url.pathToFileURL(entry).href).catch(function (err) {
    process.stderr.write(String((err && err.stack) || err) + "\n");
    process.exit(1);
  });
};
