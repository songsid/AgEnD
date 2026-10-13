// #1753 probe helper: carry one session from config dir A to B with the production code. Args: <sid> <cwd> <from> <to>.
import { carryClaudeConversation } from "../../../src/backend/claude-carry.ts";
const [sid, work, from, to] = process.argv.slice(2);
console.log(JSON.stringify(await carryClaudeConversation({ sessionId: sid, workingDirectory: work, fromConfigDir: from, toConfigDir: to })));
