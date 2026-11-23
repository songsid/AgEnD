// Presentation dispatch only; each platform owns its wording and meaning.
import {help as darwin} from './host-monitoring-darwin.js';
import {help as linux} from './host-monitoring-linux.js';
import {help as wsl} from './host-monitoring-wsl.js';
import {register,t} from '/assets/app-i18n.js';
register('hostPlatformHelp',{en:{unavailable:'Unavailable',memory:'Memory',unknown:'Platform-specific information is unavailable until the platform is identified.'},'zh-TW':{unavailable:'無法取得',memory:'記憶體',unknown:'辨識平台後才能顯示該平台的說明。'}});
export function monitoringHelp(platform,key,...args){const own=platform==='darwin'?darwin:platform==='wsl'?wsl:platform==='linux'?linux:null;return own?own(key,...args):t('hostPlatformHelp.'+(['settings','memory','overall'].includes(key)?'unknown':key==='chart'?'memory':'unavailable'));}
