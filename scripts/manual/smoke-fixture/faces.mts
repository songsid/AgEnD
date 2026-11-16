// Agents' faces for phone-drawer smokes (M-3209, M-3211). The fixture's agents have no pictures, so a smoke that only
// sees letter avatars misses what a real fleet shows (#4008 squashed pictures and its smoke never saw one).
//   withFaces(ctx, names)  before navigating: serves /ui/img/avatar/<name> as a round coloured face (SVG)
//   faces(page, names)     after mounting: names 0–5 a picture, 6 an emoji, 7 on a letter — as the status frame
//                          would carry them; it stays so across later status frames
//   density(page, value)   the agent list's density ("detailed" | "compact") for the page's layout (M-3252: a phone's drawer
//                          and a desk's sidebar keep their own), a synced pref: clear both with clearDensity
//   clearDensity(fx)       put the pref back unset, so the next freshPage starts from the defaults

const FACE = (hue: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 60% 55%)"/>`
  + `<circle cx="22" cy="26" r="6" fill="#fff"/><circle cx="42" cy="26" r="6" fill="#fff"/><path d="M18 42 q14 12 28 0" stroke="#fff" stroke-width="5" fill="none"/></svg>`;

export async function withFaces(ctx: any, names: string[]): Promise<void> {
  await ctx.route("**/ui/img/avatar/**", (route: any) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() || "");
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: FACE((Math.max(0, names.indexOf(name)) * 47) % 360) });
  });
}

export function faces(page: any, names: string[]): Promise<void> {
  return page.evaluate(async (all: string[]) => {
    const m = await import("/assets/app-store.js");
    const face = (it: any) => {
      const i = all.indexOf(it.name);
      if (i >= 0 && i < 6) return { ...it, avatar: { kind: "image", src: `/ui/img/avatar/${encodeURIComponent(it.name)}?v=faces` } };
      if (i === 6) return { ...it, avatar: { kind: "emoji", text: "🦊" } };
      return it;
    };
    const store = m.appStore as any;
    if (!store.__faces) {
      const set = store.set.bind(store);
      store.set = (patch: any) => set((s: any) => {
        const n = typeof patch === "function" ? patch(s) : { ...s, ...patch };
        return n === s || !Array.isArray(n.instances) ? n : { ...n, instances: n.instances.map(face) };
      });
      store.__faces = true;
    }
    store.set((s: any) => ({ ...s }));
  }, names);
}

export function density(page: any, value: "detailed" | "compact"): Promise<void> {
  return page.evaluate(async (v: string) => { const m = await import("/assets/instance-nav.js"); m.setSidebarDensity(v); }, value);
}

export function clearDensity(fx: any): void {
  // M-3252: the desktop sidebar's and the phone drawer's (setSidebarDensity writes the one for the page's layout).
  fx.fm.webPrefs.writeForViewer("operator", new Map<string, unknown>([["nav.density", null], ["nav.densityPhone", null]]));
}
