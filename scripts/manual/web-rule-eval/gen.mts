// #1939 web-rule eval: write a worker's MCP fleet instructions from a checkout (`tsx gen.mts <repo> <out.txt>`), so one
// run can compare the rule before and after a change. Demo instance name only.
const repo = process.argv[2], out = process.argv[3];
const { buildFleetInstructions } = await import(repo + "/src/instructions.ts");
const { writeFileSync } = await import("node:fs");
writeFileSync(out, buildFleetInstructions({ instanceName: "m365-demo", workingDirectory: "/work/m365-demo" }));
