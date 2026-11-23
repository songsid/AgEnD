/** Compatibility entry point: platform selection only; collectors own all OS semantics. */
import type {HostMonitoringProvider} from './host-monitoring.js';
import {detectMonitoringPlatform} from './host-monitoring-defaults.js';
import {DarwinHostMonitoring} from './host-monitoring/darwin/collector.js';
import {LinuxHostMonitoring} from './host-monitoring/linux/collector.js';
import {WslHostMonitoring} from './host-monitoring/wsl/collector.js';
import type {NativeMonitorOptions} from './host-monitoring/transport.js';
export {MONITOR_OUTPUT_BYTES,MONITOR_MOUNT_BYTES,MONITOR_DEADLINE_MS,runMonitorCommand,readMonitorKernelFile} from './host-monitoring/transport.js';
export type {MonitorRunner,MonitorCommand} from './host-monitoring/transport.js';
export {MonitorCpu} from './host-monitoring/linux/interpretation.js';
export {parseMonitorMounts,monitorMountFor,parseMonitorDf} from './host-monitoring/wsl/interpretation.js';
export type {MonitorMount} from './host-monitoring/wsl/interpretation.js';
export {parseApfsContainer} from './host-monitoring/darwin/interpretation.js';
export {WSL_BACKING_DRIVE_SCRIPT} from './host-monitoring/wsl/collector.js';
export class NativeHostMonitoring implements HostMonitoringProvider{
 private readonly provider:HostMonitoringProvider;
 readonly platform:HostMonitoringProvider['platform'];
 constructor(options:NativeMonitorOptions){const platform=options.platform??detectMonitoringPlatform();this.provider=platform==='darwin'?new DarwinHostMonitoring(options):platform==='wsl'?new WslHostMonitoring(options):new LinuxHostMonitoring(options);this.platform=this.provider.platform;}
 host(){return this.provider.host();}
 disks(){return this.provider.disks();}
 stop(){return this.provider.stop();}
}
