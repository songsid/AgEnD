import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe,expect,it,vi} from 'vitest';
import yaml from 'js-yaml';
import {FleetManager} from '../src/fleet-manager.js';
import {NativeHostMonitoring} from '../src/host-monitoring-platform.js';
describe('monitoring Fleet lifecycle integration',()=>{
 it('load alone is inert; startup pins false, committed save starts and disables hot',async()=>{
  vi.useFakeTimers();const root=mkdtempSync(join(tmpdir(),'monitor-fleet-')),path=join(root,'fleet.yaml');
  writeFileSync(path,'instances: {}\nunknown_extension: keep-me\n');
  const host=vi.spyOn(NativeHostMonitoring.prototype,'host').mockReturnValue({cpu:{value:null},memory:{value:null}});
  const disks=vi.spyOn(NativeHostMonitoring.prototype,'disks').mockReturnValue({result:Promise.resolve({volumes:[]}),stopped:Promise.resolve(),cancel(){}});
  let fm:any;
  try{
   fm=new FleetManager(root);fm.loadConfig(path);expect(readFileSync(path,'utf8')).not.toContain('monitoring:');expect(fm.hostMonitoringAvailable()).toBe(false);expect(host).not.toHaveBeenCalled();
   fm.startHostMonitoringRuntime();expect(yaml.load(readFileSync(path,'utf8'))).toMatchObject({monitoring:{enabled:false,agent_footprint:false},unknown_extension:'keep-me'});
   expect(fm.hostMonitoringAvailable()).toBe(true);expect(host).not.toHaveBeenCalled();
   fm.fleetConfig.monitoring.enabled=true;fm.saveFleetConfig([{path:['monitoring','enabled'],value:true}]);expect(host).toHaveBeenCalledTimes(1);expect(disks).toHaveBeenCalledTimes(1);
   fm.fleetConfig.monitoring.enabled=false;fm.saveFleetConfig([{path:['monitoring','enabled'],value:false}]);await Promise.resolve();expect(fm.hostHealthSnapshot().enabled).toBe(false);
   expect(yaml.load(readFileSync(path,'utf8'))).toMatchObject({monitoring:{enabled:false,agent_footprint:false}});
  }finally{fm?.hostMonitor?.stop();vi.restoreAllMocks();vi.useRealTimers();rmSync(root,{recursive:true,force:true});}
 });
});
