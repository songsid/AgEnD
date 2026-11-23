import type {HostAlertKind,HostAlertRule} from '../../host-monitoring-alert-policy.js';
const minute=60_000,GiB=1024**3;
export const DEFAULTS:Readonly<Record<HostAlertKind,Readonly<HostAlertRule>>>={
  cpu: { kind:'cpu', direction:'above', warning:90, urgent:98, clear:80, warningMs:5*minute, urgentMs:10*minute, clearMs:5*minute, warningSamples:1, urgentSamples:1, intervalMs:30_000 },
  memory: { criticalOnly:false, kind:'memory', direction:'above', warning:1, urgent:2, clear:0, warningMs:2*minute, urgentMs:minute, clearMs:2*minute, warningSamples:1, urgentSamples:1, intervalMs:30_000 },
  filesystem: { kind:'filesystem', direction:'above', warning:85, urgent:95, clear:80, warningMs:0, urgentMs:0, clearMs:10*minute, warningSamples:2, urgentSamples:2, intervalMs:minute },
  'backing-drive': { kind:'backing-drive', direction:'below', warning:60*GiB, urgent:30*GiB, clear:65*GiB, warningMs:0, urgentMs:0, clearMs:10*minute, warningSamples:2, urgentSamples:1, intervalMs:minute },
  inodes: { kind:'inodes', direction:'above', warning:85, urgent:95, clear:80, warningMs:0, urgentMs:0, clearMs:10*minute, warningSamples:2, urgentSamples:2, intervalMs:minute },
};
