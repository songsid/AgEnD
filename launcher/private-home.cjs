"use strict";
// Shared by the compiled CLI and the target-version installer. Keep syntax usable by old npm's Node.
var fs = require("fs");
var path = require("path");

function checkedPath(dir, io, missingAllowed, message) {
  var absolute = path.resolve(dir), parent = path.parse(absolute).root;
  var pieces = absolute.slice(parent.length).split(path.sep).filter(Boolean), info;
  for (var i = 0; i < pieces.length; i++) {
    parent = path.join(parent, pieces[i]);
    try { info = io.lstatSync(parent); }
    catch (error) { if (missingAllowed && error.code === "ENOENT") return null; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(message);
  }
  return info || io.lstatSync(absolute);
}

/** Create privately; repair only an owned real home, never chmod by pathname or through a symlink. */
function ensurePrivateHome(dir, options) {
  var opts = options || {}, io = opts.fs || fs;
  var uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  var label = opts.label || "AgEnD";
  var message = label + " requires an owned real AGEND_HOME without group/other write permission.";
  checkedPath(dir, io, opts.create !== false, message);
  if (opts.create !== false) io.mkdirSync(dir, { recursive: true, mode: 448 }); // 0700; umask cannot add permissions
  var before = checkedPath(dir, io, false, message);
  // Native Windows has no Unix uid/mode contract. The Windows installer runs this policy inside WSL.
  if (uid === null) return;
  if (before.uid !== uid) throw new Error(message);
  var fd = io.openSync(dir, io.constants.O_RDONLY | io.constants.O_DIRECTORY | io.constants.O_NOFOLLOW);
  try {
    if (opts.afterOpen) opts.afterOpen(); // test seam: replacement at the check/change boundary
    var info = io.fstatSync(fd), current = checkedPath(dir, io, false, message);
    if (!info.isDirectory() || info.uid !== uid || current.dev !== info.dev || current.ino !== info.ino) throw new Error(message);
    if (info.mode & 18) { // 0022: repair affected 0775/0777 homes; existing non-writable roots keep their mode
      io.fchmodSync(fd, 448);
      if ((io.fstatSync(fd).mode & 511) !== 448) throw new Error(message);
      (opts.log || function (line) { console.warn(line); })("AgEnD: tightened owned AGEND_HOME permissions to 0700.");
    }
  } finally { io.closeSync(fd); }
}

module.exports = { ensurePrivateHome: ensurePrivateHome };
