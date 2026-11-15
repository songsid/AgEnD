import {readFile} from 'node:fs/promises';import {spawn} from 'node:child_process';import {win32,join} from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
const s=JSON.parse(await readFile('.artifacts/m4012-matched-fixed/state.json','utf8'));
assert.equal(await readFile(join(s.root,'.m4012-owned'),'utf8'),s.tag);
const {nativeCliEnvironment}=await import(pathToFileURL(join(s.compiled,'windows-cli-worker.js')));
const child=spawn(s.node,[win32.join(s.nativeRoot,'native-runner.mjs'),'host',s.nativeRoot,s.scope,s.windowsCode],{shell:false,stdio:['pipe','pipe','pipe'],env:nativeCliEnvironment()});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.on('close',code=>{console.log(JSON.stringify({hostExited:true,exitCode:code}));process.exitCode=code??1;process.stdin.destroy();});
