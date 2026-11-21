// Presentation only: these helpers cannot sample, open history or turn monitoring on.
export const HOST_RANGES = ["1h", "24h", "7d", "30d"];
export const numberOrNull = (value, maximum = Number.MAX_SAFE_INTEGER) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
export function metricState(metric, interval, now = Date.now()) {
  if (metric?.status !== "ok") return metric?.status === "stale" ? "stale" : "unavailable";
  return numberOrNull(metric.sampledAt) === null || now - metric.sampledAt >= interval * 2 ? "stale" : "ok";
}
export function displayBytes(value) {
  const n = numberOrNull(value);if (n === null) return null;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  return `${Math.round(n / 1024)} KiB`;
}
export function storageRows(snapshot) {
  return (Array.isArray(snapshot?.disks?.value?.volumes) ? snapshot.disks.value.volumes : []).slice(0,8)
    .filter(v => v && /^[a-f0-9]{16}$/.test(v.id) && Array.isArray(v.roles))
    .sort((a,b) => (numberOrNull(a.availableBytes) ?? Infinity) - (numberOrNull(b.availableBytes) ?? Infinity));
}
export function historySeries(snapshot) {
  return ["cpu.used", "memory.available", "memory.pressure", "swap.free", ...storageRows(snapshot).flatMap(v => [`disk.${v.id}.available`, `disk.${v.id}.used`])];
}
/** Null gaps break lines; even a damaged response cannot draw more than240 points. */
export function chartData(input) {
  const buckets = Array.isArray(input) ? input.slice(0,240) : [];
  const valid = b => b && numberOrNull(b.average) !== null && numberOrNull(b.min) !== null && numberOrNull(b.max) !== null && numberOrNull(b.count) > 0;
  const values=buckets.filter(valid), min=values.length?Math.min(...values.map(b=>b.min)):null,max=values.length?Math.max(...values.map(b=>b.max)):null;
  const ceiling=max===null?1:Math.max(1,max),segments=[];let points=[];
  for(let i=0;i<buckets.length;i++) {
    const b=buckets[i];if(!valid(b)){if(points.length)segments.push(points.join(' '));points=[];continue;}
    points.push(`${(i*600/Math.max(1,buckets.length-1)).toFixed(2)},${(100-Math.min(100,b.average/ceiling*100)).toFixed(2)}`);
  }
  if(points.length)segments.push(points.join(' '));
  const dots=segments.filter(s=>!s.includes(' ')).map(s=>{const [x,y]=s.split(',').map(Number);return{x,y};});
  return {segments,dots,min,max,covered:values.length,total:buckets.length};
}

export function sampleCoverage(snapshot,now=Date.now()) {
 const volumes=storageRows(snapshot),missingBacking=snapshot?.platform==='wsl'&&!volumes.some(v=>v.roles.includes('wsl-backing'));
 const cpu=metricState(snapshot?.cpu,30000,now)==='ok'&&numberOrNull(snapshot?.cpu?.value?.usedPercent,100)!==null;
 const memory=metricState(snapshot?.memory,30000,now)==='ok'&&(numberOrNull(snapshot?.memory?.value?.availableBytes)!==null||['normal','elevated','critical'].includes(snapshot?.memory?.value?.pressure));
 return {covered:Number(cpu)+Number(memory)+(metricState(snapshot?.disks,60000,now)==='ok'?volumes.filter(v=>numberOrNull(v.availableBytes)!==null).length:0),total:2+volumes.length+Number(missingBacking)};
}
