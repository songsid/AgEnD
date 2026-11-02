// Machine inventory is a fast central snapshot. Reading it never launches a model or a CLI probe.
import { useEffect } from "/assets/app-html.js";
import { createStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";

const initial = () => ({ data:null, loading:false, error:"", checkedAt:0 });
export function createRuntimeCatalog({ fetcher = (...args) => fetch(...args), now = () => Date.now(), ttlMs = 5000, timeoutMs = 15_000 } = {}) {
  const store = createStore(initial());
  let pending = null, controller = null, generation = 0;
  const load = ({ force = false } = {}) => {
    if (pending) return pending;
    if (!force && store.get().data && now()-store.get().checkedAt < ttlMs) return Promise.resolve(store.get().data);
    const mine = generation, abort = controller = new AbortController();
    const timer = setTimeout(() => abort.abort(),timeoutMs);
    store.set({loading:true,error:""});
    pending = Promise.resolve().then(async () => {
      try {
        const response = await fetcher("/ui/runtimes",{credentials:"same-origin",signal:abort.signal});
        const value = await response.json();
        if (!response.ok) {
          if (mine === generation && [401,403].includes(response.status)) store.set({data:null,checkedAt:0});
          throw new Error(value?.error || `HTTP ${response.status}`);
        }
        if (!value || !Array.isArray(value.machines)) throw new Error("Invalid runtime inventory response");
        if (mine === generation) store.set({data:value,checkedAt:now(),error:""});
        return value;
      } catch(error) {
        if (mine === generation) store.set({error:error?.message || "Runtime inventory unavailable"});
        return null;
      } finally {
        clearTimeout(timer);
        if (mine === generation) { pending = null; controller = null; store.set({loading:false}); }
      }
    });
    return pending;
  };
  return {get:store.get,subscribe:store.subscribe,load,clear(){generation++;controller?.abort();controller=null;pending=null;store.set(initial());}};
}
const catalog = createRuntimeCatalog();
export const forgetRuntimeCatalog = () => catalog.clear();
export function useRuntimeCatalog(enabled = true) {
  const state = useStore(catalog), lease = useLease(`runtime-catalog:${enabled}`);
  useEffect(() => {
    if (!enabled) return;
    void catalog.load();
    const timer = lease.interval(() => { void catalog.load(); },5000);
    return () => lease.clear(timer);
  },[lease,enabled]);
  return {...(enabled ? state : initial()),refresh:() => catalog.load({force:true})};
}
export const instanceMachineId = instance => instance?.machine_id || instance?.machineId || "";
/** Inventory can be viewed offline; only online, installed, supported providers can receive new work. */
export function runtimeCliChoices(machine) {
  return (machine?.inventory?.clis || []).filter(cli => cli.path && cli.supports?.execution !== false && cli.supports?.resume !== false);
}
