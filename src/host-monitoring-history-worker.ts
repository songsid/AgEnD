import {parentPort,workerData} from 'node:worker_threads';
import {HostHistoryStore} from './host-monitoring-history-store.js';
import {HostAlertReserve} from './host-monitoring-alert-store.js';
const data=workerData as {path:string;control:SharedArrayBuffer};
const enabled=new Int32Array(data.control),port=parentPort!;
let store:HostHistoryStore|null=null,incidents:HostAlertReserve|null=null;
function reason(error:unknown):string {const text=(error as Error)?.message;return typeof text==='string'&&/^(?:history|incident)_[a-z_]+$/.test(text)?text:'history_io_failed';}
function close(){try{store?.close();incidents?.close();}finally{store=null;incidents=null;port.close();}}
function active(){if(Atomics.load(enabled,0)!==1)throw Error('incident_disabled');}
if(Atomics.load(enabled,0)!==1)port.close();
else try {
  port.on('message',message=>{
    if(message?.op==='close'||Atomics.load(enabled,0)!==1){close();return;}
    if(!Number.isSafeInteger(message?.id))return;
    try{
      // Low-water blocks SQLite writes, not the bounded incident reserve. Off fences both.
      if(message.op==='incident-read'||message.op==='incident-save'){
        if(!incidents){incidents=new HostAlertReserve(data.path,{beforeHeader:active});incidents.open();}
        active();
        const value=message.op==='incident-read'?incidents.snapshot():incidents.commit(message.sequence,message.document);
        active();port.postMessage({id:message.id,ok:true,value});return;
      }
      if(message.op==='append'&&Atomics.load(enabled,1)!==1){port.postMessage({id:message.id,ok:false,reason:'history_low_space'});return;}
      if(message.op==='append')store??=new HostHistoryStore(data.path);
      if(!store){port.postMessage({id:message.id,ok:false,reason:'history_unavailable'});return;}
      const value=message.op==='append'?store.append(message.points,message.now):message.op==='query'?store.query(message.range,message.series,message.now):null;
      port.postMessage({id:message.id,ok:value!==null,value});
    }catch(error){port.postMessage({id:message.id,ok:false,reason:reason(error)});}
  });
  port.postMessage({op:'ready'});
}catch(error){port.postMessage({op:'failed',reason:reason(error)});close();}
