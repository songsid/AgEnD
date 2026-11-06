// Lazy-owned copy survives an open shell with cached i18n modules. No new shared exports are required.
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
register("installedBuild", {
  en: { alphaShort: "α", source: "Source build", modified: "modified", unknown: "changes unknown", detail: "Package {0}; source {1}" },
  "zh-TW": { alphaShort: "α", source: "原始碼建置", modified: "含未提交變更", unknown: "變更狀態不明", detail: "套件 {0}；原始碼 {1}" },
});
const copy = (key, ...args) => t(`installedBuild.${key}`, ...args);
const releases = "https://github.com/songsid/AgEnD/releases";
export function SettingsBuildVersion({ version, build }) {
  const [narrow, setNarrow] = useState(() => globalThis.matchMedia?.("(max-width: 899px)").matches ?? false);
  useEffect(() => {
    const media = globalThis.matchMedia?.("(max-width: 899px)"); if (!media) return;
    const sync = () => setNarrow(media.matches); media.addEventListener("change", sync); sync();
    return () => media.removeEventListener("change", sync);
  }, []);
  if (!version) return null;
  const source = build?.version === version ? build.source : null;
  const valid = source && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.commit)
    && ["alpha", "source", "release"].includes(source.channel)
    && (source.modified === null || typeof source.modified === "boolean");
  const released = valid && source.channel === "release" && source.ref === `v${version}`;
  const alpha = valid && source.channel === "alpha" && /^release\/\d+\.\d+\.\d+-alpha$/.test(source.ref);
  const stamped = valid && (!released || source.modified === true);
  const status = source?.modified === true ? copy("modified") : source?.modified === null ? copy("unknown") : "";
  const label = stamped ? `${released ? `v${version}` : alpha ? source.ref.slice(8) : copy("source")} · ${source.commit.slice(0, 12)}${status ? ` (${status})` : ""}` : `v${version}`;
  const href = stamped ? `https://github.com/songsid/AgEnD/commit/${source.commit}`
    : version.includes("-") ? `${releases}/latest` : `${releases}/tag/v${version}`;
  const detail = valid ? `${label}; ${copy("detail", version, source.commit)}` : undefined;
  // The existing phone header has only a small version slot. No new shared CSS is needed in a cached shell.
  const shown = alpha && stamped && narrow ? `${copy("alphaShort")}·${source.commit.slice(0, 7)}` : label;
  return html`<a class="pill ver" href=${href} target="_blank" rel="noopener"
    ref=${el => { if (el) el.style.paddingInline = alpha && narrow ? "2px" : ""; }}
    title=${detail} aria-label=${detail}>${shown}</a>`;
}
