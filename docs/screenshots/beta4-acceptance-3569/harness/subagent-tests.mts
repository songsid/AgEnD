import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
const root=process.env.REPO!,out=process.env.OUT!;
const r=spawnSync(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','tests/subagent-async-lifecycle.test.ts','tests/subagent-web.test.ts','tests/subagent-service.test.ts','--reporter=json','--outputFile='+join(out,'vitest.json')],{cwd:root,env:process.env,encoding:'utf8',maxBuffer:8<<20});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||0);
