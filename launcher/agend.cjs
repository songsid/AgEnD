#!/usr/bin/env node
"use strict";
// The `agend` bin (#1450): selects AgEnD's Node, then runs dist/cli.js on it.
require("./launch.cjs")("dist/cli.js", __dirname);
