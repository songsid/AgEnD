import {platform,release} from 'node:os';
import type {HostAlertKind} from './host-monitoring-alert-policy.js';
import type {MonitoringPlatform} from './host-monitoring.js';
import {DEFAULTS as darwin} from './host-monitoring/darwin/defaults.js';
import {DEFAULTS as linux} from './host-monitoring/linux/defaults.js';
import {DEFAULTS as wsl} from './host-monitoring/wsl/defaults.js';
/** Launch identity only: no collector, timer, command or settings write. */
export function detectMonitoringPlatform():MonitoringPlatform{return platform()==='darwin'?'darwin':/microsoft/i.test(release())||!!process.env.WSL_DISTRO_NAME?'wsl':'linux';}
const table=(value:MonitoringPlatform)=>value==='darwin'?darwin:value==='wsl'?wsl:linux;
export function hostAlertDefaults(value:MonitoringPlatform=detectMonitoringPlatform()){return structuredClone(table(value));}
export function hostAlertDefaultRule(kind:HostAlertKind,value:MonitoringPlatform=detectMonitoringPlatform()){return{...table(value)[kind]};}
