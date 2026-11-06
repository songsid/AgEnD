"use strict";
/** Read only root-level plist entries; comments and environment keys never select a manager domain. */
function sessionType(definition) {
  if (typeof definition !== "string") return undefined;
  var text = definition.replace(/<!--[\s\S]*?-->/g, ""), depth = 0, values = [];
  var token = /<(\/?)(dict|array)\b[^>]*>|<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g, match;
  while ((match = token.exec(text))) {
    if (match[2]) depth += match[1] ? -1 : 1;
    else if (depth === 1 && match[3] === "LimitLoadToSessionType") values.push(match[4]);
  }
  if (values.length > 1) throw Error("Ambiguous launchd session type; no domain was selected");
  return values[0] === "Background" ? "Background" : undefined;
}
module.exports = { sessionType: sessionType };
