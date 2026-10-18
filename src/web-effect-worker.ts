/** #1629: trusted bootstrap sources; uploaded JS runs only in a dedicated Worker, never a DOM realm. */
export const EFFECT_MAX_BYTES = 1024 * 1024;
export const EFFECT_MAX_PIXELS = 8 * 1024 * 1024;

// Shared by the trusted document and Worker. Closed signals only; no content-bearing fields are read.
export const EFFECT_SIGNAL_CHECK = String.raw`
function signal(d, instance) {
  if (!d || Object.getPrototypeOf(d) !== Object.prototype || d.v !== 1 || !Number.isFinite(d.ts) || d.ts < 0) return false;
  var keys = {state:['state'],reply:[],mention:[],theme:['mode'],env:['width','height','dpr','quality'],pointer:['kind','x','y','buttons']};
  if (!Object.prototype.hasOwnProperty.call(keys,d.type)) return false;
  var exact = ['v','type','ts'].concat(keys[d.type]);
  if (['state','reply','mention'].indexOf(d.type) >= 0 && Object.prototype.hasOwnProperty.call(d,'instance')) {
    if (typeof instance !== 'string' || d.instance !== instance) return false;
    exact.push('instance');
  }
  if (d.type === 'pointer') for (var key of ['dx','dy']) if (Object.prototype.hasOwnProperty.call(d,key)) {
    if (!Number.isFinite(d[key]) || Math.abs(d[key]) > 10000) return false;
    exact.push(key);
  }
  if (Object.keys(d).sort().join(',') !== exact.sort().join(',')) return false;
  switch (d.type) {
    case 'state': return ['idle','working','needs_you','stopped'].indexOf(d.state) >= 0;
    case 'reply': case 'mention': return true;
    case 'theme': return ['light','dark'].indexOf(d.mode) >= 0;
    case 'env': return Number.isInteger(d.width) && d.width >= 1 && d.width <= 4096 && Number.isInteger(d.height) && d.height >= 1 && d.height <= 4096 && d.width*d.height <= 8388608 && Number.isFinite(d.dpr) && d.dpr >= 0.5 && d.dpr <= 3 && ['normal','low'].indexOf(d.quality) >= 0;
    case 'pointer': return ['move','down','up','click','wheel'].indexOf(d.kind) >= 0 && Number.isFinite(d.x) && d.x >= 0 && d.x <= 4096 && Number.isFinite(d.y) && d.y >= 0 && d.y <= 4096 && Number.isInteger(d.buttons) && d.buttons >= 0 && d.buttons <= 31;
  }
  return false;
}
`;

/** The private port never reaches user callbacks, including through poisoned native getters/schedulers. */
export function effectWorkerSource(): string {
  return `"use strict";
(function () {
  ${EFFECT_SIGNAL_CHECK}
  var defer = self.setTimeout.bind(self), load = self.importScripts.bind(self), end = self.close.bind(self), now = performance.now.bind(performance);
  var read = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data').get);
  var raf = typeof self.requestAnimationFrame === 'function' ? self.requestAnimationFrame.bind(self) : null;
  var initialized = false;
  function init(event) {
    if (initialized) return;
    var d = read(event);
    if (!d || !d.port || !d.canvas || typeof d.codeUrl !== 'string') return;
    initialized = true;
    self.removeEventListener('message',init);
    var port = d.port, post = port.postMessage.bind(port), callbacks = Object.create(null), ready = false;
    var assets = Object.create(null);
    d.assets.forEach(function (asset) { assets[asset.name] = asset.bitmap; });
    var api = Object.freeze({
      canvas: d.canvas,
      params: Object.freeze(d.params),
      asset: function (name) { return Object.prototype.hasOwnProperty.call(assets,name) ? assets[name] : undefined; },
      on: function (kind,fn) {
        if (['state','reply','mention','theme','env','pointer'].indexOf(kind) < 0 || typeof fn !== 'function') return;
        if (!callbacks[kind]) callbacks[kind] = [];
        if (callbacks[kind].length < 32) callbacks[kind].push(fn);
      },
      frame: function (fn) {
        if (typeof fn !== 'function') return;
        if (raf) { try { return raf(fn); } catch (_) {} }
        return defer(function () { fn(now()); },16);
      },
      ready: function () { if (!ready) { ready = true; post({type:'ready'}); } }
    });
    Object.defineProperty(self,'agend',{value:api,writable:false,configurable:false});
    // Defence in depth against nested workers; termination and host budgets remain required.
    ['Worker','SharedWorker','importScripts','RTCPeerConnection','webkitRTCPeerConnection'].forEach(function (key) {
      try { Object.defineProperty(self,key,{value:undefined,writable:false,configurable:false}); } catch (_) {}
    });
    port.addEventListener('message',function (event) {
      var payload = read(event);
      if (!signal(payload,d.instance)) return;
      defer(function () {
        var listeners = (callbacks[payload.type] || []).slice();
        listeners.forEach(function (fn) { try { fn(payload); } catch (_) {} });
      },0);
    });
    port.start();
    // Separate script/global: never concatenate user code into a trusted lexical scope.
    defer(function () { try { load(d.codeUrl); } catch (_) { end(); } },0);
  }
  self.addEventListener('message',init);
})();`;
}

function literal(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** No HTML input exists. The document realm contains only this shim and its single canvas. */
export function buildCanvasEffectShim(bootId: string, origins: readonly string[], sameListener = false): string {
  const source = String.raw`(function () {
  "use strict";
  ${EFFECT_SIGNAL_CHECK}
  var BOOT=${literal(bootId)}, ORIGINS=${sameListener ? "[new URL(window.location.href).origin]" : literal([...origins])}, MAX=${EFFECT_MAX_BYTES}, PIXELS=${EFFECT_MAX_PIXELS};
  var WORKER=${literal(effectWorkerSource())};
  var done=false, active=true, worker=null, host=null, link=null, urls=[], bitmaps=[], deadline=null, expires=null;
  var defer=window.setTimeout.bind(window), cancel=window.clearTimeout.bind(window), now=performance.now.bind(performance);
  var read=Function.prototype.call.bind(Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data').get);
  function plain(d) { return !!d && Object.getPrototypeOf(d) === Object.prototype; }
  function bytes(s) { try { return new TextEncoder().encode(s).length; } catch (_) { return Infinity; } }
  function stop() {
    if (!active) return;
    active=false;
    if (deadline !== null) cancel(deadline);
    if (worker) worker.terminate();
    if (host) host.close();
    if (link) link.close();
    urls.forEach(function (url) { URL.revokeObjectURL(url); });
    bitmaps.forEach(function (bitmap) { try { bitmap.close(); } catch (_) {} });
  }
  window.addEventListener('pagehide',stop,{once:true});
  async function render(event) {
    if (done || !active || event.source !== window.parent || event.origin === 'null' || ORIGINS.indexOf(event.origin) < 0) return;
    var d=read(event);
    if (!plain(d) || Object.keys(d).sort().join(',') !== 'assets,ch,code,dpr,height,instance,params,type,v,width' || d.v !== 1 || d.type !== 'render') return;
    if (typeof d.ch !== 'string' || !/^[0-9a-f]{16,64}$/.test(d.ch) || typeof d.code !== 'string' || bytes(d.code) > MAX) return;
    if (d.instance !== null && (typeof d.instance !== 'string' || d.instance.length < 1 || d.instance.length > 128)) return;
    if (!signal({v:1,type:'env',ts:0,width:d.width,height:d.height,dpr:d.dpr,quality:'normal'},d.instance)) return;
    if (!plain(d.params) || Object.keys(d.params).length > 16 || !Array.isArray(d.assets) || d.assets.length > 16) return;
    var names=new Set();
    if (!Object.keys(d.params).every(function (key) {
      var value=d.params[key];
      return /^[a-z][a-z0-9_]{0,31}$/.test(key) && (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 128);
    })) return;
    var size=bytes(d.code)+bytes(JSON.stringify(d.params));
    if (Object.keys(d.assets).length !== d.assets.length) return;
    if (!d.assets.every(function (asset) {
      if (!plain(asset) || Object.keys(asset).sort().join(',') !== 'bytes,mime,name' || typeof asset.name !== 'string' || !/^assets\/[a-z0-9][a-z0-9_-]{0,63}\.(png|jpe?g|webp|gif)$/.test(asset.name) || names.has(asset.name)) return false;
      if (['image/png','image/jpeg','image/webp','image/gif'].indexOf(asset.mime) < 0 || !(asset.bytes instanceof Uint8Array)) return false;
      names.add(asset.name);size+=asset.bytes.byteLength;return true;
    }) || size > MAX) return;
    if (!event.ports || event.ports.length !== 1) return;
    var port=event.ports[0];
    if (!port || typeof port.postMessage !== 'function' || typeof port.addEventListener !== 'function' || typeof port.start !== 'function' || typeof port.close !== 'function') return;
    done=true;host=port;window.removeEventListener('message',render);
    expires=now()+10000;deadline=defer(stop,10000);
    try {
      if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function' || typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== 'function') { stop();return; }
      var assets=[], pixels=0;
      for (var asset of d.assets) {
        var bitmap=await createImageBitmap(new Blob([asset.bytes],{type:asset.mime}));
        if (!active || now() >= expires) { bitmap.close();stop();return; }
        bitmaps.push(bitmap);
        if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 4096 || bitmap.height > 4096 || bitmap.width*bitmap.height > PIXELS) { stop();return; }
        pixels+=bitmap.width*bitmap.height;if(pixels > PIXELS) { stop();return; }
        assets.push({name:asset.name,bitmap:bitmap});
      }
      if (!active || now() >= expires) { stop();return; }
      var canvas=document.querySelector('canvas');canvas.width=d.width;canvas.height=d.height;
      var offscreen=canvas.transferControlToOffscreen();
      var codeUrl=URL.createObjectURL(new Blob([d.code],{type:'text/javascript'}));urls.push(codeUrl);
      var workerUrl=URL.createObjectURL(new Blob([WORKER],{type:'text/javascript'}));urls.push(workerUrl);
      worker=new Worker(workerUrl);var channel=new MessageChannel();link=channel.port1;
      var ready=false, post=port.postMessage.bind(port);
      // No diagnostic, cost, pong, command or error message is forwarded to the host.
      link.addEventListener('message',function (event) {
        var value=read(event);
        if (active && !ready && now() >= expires) { stop();return; }
        if (!active || ready || !plain(value) || Object.keys(value).join(',') !== 'type' || value.type !== 'ready') return;
        ready=true;cancel(deadline);deadline=null;post({type:'ready'});
      });link.start();
      worker.addEventListener('error',stop);worker.addEventListener('messageerror',stop);
      port.addEventListener('message',function (event) { var payload=read(event);if (active && signal(payload,d.instance)) link.postMessage(payload); });port.start();
      worker.postMessage({port:channel.port2,canvas:offscreen,assets:assets,params:d.params,instance:d.instance,codeUrl:codeUrl},[channel.port2,offscreen].concat(bitmaps));
    } catch (_) { stop(); }
  }
  window.addEventListener('message',render);
  window.parent.postMessage({v:1,type:'ready',ch:null,boot:BOOT},'*');
})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Effect</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}</style></head><body><canvas></canvas><script>${source}</script></body></html>`;
}
