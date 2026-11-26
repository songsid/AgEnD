const {execFileSync}=require('node:child_process');const fs=require('node:fs');
const prefix='m3823-node-'+process.pid;const records=[];let failed=false;
const run=(s,...a)=>{try{return {code:0,stdout:execFileSync('tmux',['-L',s,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}}catch(e){return {code:e.status,stderr:String(e.stderr).trim()}}};
for(let i=1;i<=300;i++){
 const s=prefix+'-'+i; const r=run(s,'-f','/dev/null','new-session','-d','-s','s','-x','80','-y','24','sleep 100');records.push({i,start:r});if(r.code){failed=true;break;}
 for(const args of [['new-window','-a','-t','s','-n','agend-login-codex','sleep 100'],['kill-window','-t','s:agend-login-codex'],['list-windows','-t','s','-F','#{window_name}'],['kill-server']]){const t=run(s,...args);if(t.code)throw Error(JSON.stringify({i,args,t}));}
}
run(prefix,'kill-server');fs.writeFileSync('/tmp/m3823/node-fresh.json',JSON.stringify({records,failed},null,2)+'\n');console.log(JSON.stringify({failed,starts:records.length,last:records.at(-1)}));if(failed)process.exitCode=1;
