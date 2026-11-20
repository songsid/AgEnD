import {parentPort,workerData} from 'node:worker_threads';
import {HostHistoryStore} from './host-monitoring-history-store.js';
const data=workerData as {path:string;control:SharedArrayBuffer};
const enabled=new Int32Array(data.control),port=parentPort!;
let store:HostHistoryStore|null=null;
function reason(error:unknown):string {const text=(error as Error)?.message;return typeof text==='string'&&/^history_[a-z_]+$/.test(text)?text:'history_io_failed';}
function close(){try{store?.close();}finally{store=null;port.close();}}
if(Atomics.load(enabled,0)!==1)port.close();
else try {

  port.on('message',message=>{
    if(message?.op==='close'||Atomics.load(enabled,0)!==1){close();return;}
    if(!Number.isSafeInteger(message?.id))return;
    try{
      // Recheck the shared permission at execution, not only when the parent enqueued it.
      if(message.op==='append'&&Atomics.load(enabled,1)!==1){port.postMessage({id:message.id,ok:false,reason:'history_low_space'});return;}
      if(message.op==='append')store??=new HostHistoryStore(data.path);
      if(!store){port.postMessage({id:message.id,ok:false,reason:'history_unavailable'});return;}
      const value=message.op==='append'?store.append(message.points,message.now):message.op==='query'?store!.query(message.range,message.series,message.now):null;
      port.postMessage({id:message.id,ok:value!==null,value});
    }catch(error){port.postMessage({id:message.id,ok:false,reason:reason(error)});}
  });
  port.postMessage({op:'ready'});
}catch(error){port.postMessage({op:'failed',reason:reason(error)});close();}
