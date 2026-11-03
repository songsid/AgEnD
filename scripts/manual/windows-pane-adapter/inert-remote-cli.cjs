/** Fixed acceptance fixture; selected only through a scratch PATH, never installed as a coding CLI. */
if(process.argv.includes('--version')){process.stdout.write('codex-cli 0.165.0');process.exit(0);}
const {spawn}=require('node:child_process'),{createInterface}=require('node:readline');
process.stdin.setRawMode(true);process.stdout.write('\x1b[2J\x1b[HREMOTE_READY\r\n');
let writes=0;process.stdin.on('data',()=>process.stdout.write('WRITES '+(++writes)+'\r\n'));
const setting=name=>process.argv.slice(2).find(value=>new RegExp('^mcp_servers\\.agend_[a-f0-9]+\\.'+name+'=').test(value));
const command=setting('command'),args=setting('args');
if(command&&args){
 const child=spawn(JSON.parse(command.slice(command.indexOf('=')+1)),JSON.parse(args.slice(args.indexOf('=')+1)),{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();
 const lines=createInterface({input:child.stdout});const send=(id,method,params)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 lines.on('line',line=>{try{const value=JSON.parse(line);if(value.error)throw Error('Fixture MCP refused');
  if(value.id===1)send(2,'tools/list',{});
  else if(value.id===2){if(value.result.tools.length!==1||value.result.tools[0].name!=='reply')throw Error('Fixture menu differs');send(3,'tools/call',{name:'reply',arguments:{text:'REMOTE_INERT_REPLY_OK'}});}
  else if(value.id===3){if(value.result.isError)throw Error('Fixture result differs');process.stdout.write('MCP_CANARY_DONE\r\n');}
 }catch{process.stdout.write('MCP_FIXTURE_FAILED\r\n');}});
 send(1,'initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'private-inert-proof',version:'1'}});
}
