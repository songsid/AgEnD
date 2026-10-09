#!/usr/bin/env node
"use strict";
// The `agend-agent` bin (#1450): selects AgEnD's Node, then runs dist/agent-cli.js on it.
require("./launch.cjs")("dist/agent-cli.js", __dirname);
