import { spawn } from 'node:child_process';
const files = [
 'tests/signin-unified-s118.test.ts','tests/signin-per-admin-totp-3486.test.ts','tests/signin-entry-s118.test.ts',
 'tests/settings-access-overview-s120.test.ts','tests/public-link-close-s120.test.ts','tests/create-host-account-132.test.ts',
 'tests/signin-end-notice-2825.test.ts','tests/zh-admin-word-2820.test.ts','tests/usage-fable-card-2815.test.ts',
 'tests/web-chat-c1.test.ts','tests/web-chat-quote-2789.test.ts',
 'tests/wake-saved-config.test.ts','tests/native-pane-instance-lifecycle-2950.test.ts',
 'tests/codex-receipt-latency-3578.test.ts','tests/delivery-forwards-1756.test.ts',
 'tests/claude-cold-resume-retry-2322.test.ts','tests/claude-cold-resume-startup-1435.test.ts',
 'tests/claude-file-send-card-2317.test.ts','tests/claude-file-send-card-2322.test.ts','tests/native-pane-file-send-2317.test.ts',
 'tests/muse-1.4.15-audit.test.ts','tests/cli-upstream-precheck.test.ts'
];
const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run',...files,'--maxWorkers=2','--reporter=default','--reporter=json','--outputFile='+process.env.OUT+'/vitest.json'],{cwd:process.env.REPO,env:process.env,stdio:'inherit'});
child.once('error',e=>{console.error(e);process.exitCode=1});
child.once('exit',code=>{process.exitCode=code??1});
