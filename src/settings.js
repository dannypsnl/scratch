import { getMeta, saveMeta } from "./store.js";
import { t, setLang, defaultLang, LANGUAGES } from "./i18n.js";

// Appearance settings (⌘,). Kept in the local meta record: a per-device
// preference, not part of the synced notebook.

const THEMES = [
  { id: "auto", bg: "linear-gradient(90deg, #ffffff 50%, #1c1c1e 50%)", ink: ["#1f1f1f", "#8a8a8a", "#3a5a8c"] },
  { id: "ink", bg: "#ffffff", ink: ["#1f1f1f", "#8a8a8a", "#3a5a8c"] },
  { id: "paper", bg: "#f7f3ea", ink: ["#2b2620", "#8b8274", "#9a3b2e"] },
  { id: "dark", bg: "#1c1c1e", ink: ["#e6e6e6", "#8e8e93", "#8fa8cf"] },
];

const current = () => ({ theme: "ink", cjkGap: true, lang: defaultLang(), ...getMeta().appearance });

// onLanguage: re-render the views when the interface language changes
let onLanguage = () => {};
export function applySettings(rerender) {
  if (rerender) onLanguage = rerender;
  const s = current();
  setLang(s.lang);
  document.documentElement.dataset.theme = s.theme;
  document.documentElement.classList.toggle("no-cjk-gap", !s.cjkGap);
}

function update(patch) {
  saveMeta({ appearance: { ...current(), ...patch } });
  applySettings();
  if (patch.lang) onLanguage();
}

export function toggleSettings() {
  const open = document.querySelector(".settings-backdrop");
  if (open) return open.remove();
  const back = document.createElement("div");
  back.className = "settings-backdrop";
  back.innerHTML = `
    <div class="settings" role="dialog" aria-label="${t("settings.title")}">
      <h2>${t("settings.title")}</h2>
      <h3>${t("settings.theme")}</h3>
      <div class="themes"></div>
      <h3>${t("settings.language")}</h3>
      <div class="langs"></div>
      <h3>${t("settings.layout")}</h3>
      <label class="check"><input type="checkbox" class="cjk"> ${t("settings.cjk")}</label>
    </div>`;
  const themes = back.querySelector(".themes");
  const draw = () => {
    const s = current();
    themes.replaceChildren(...THEMES.map((th) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "theme-card" + (s.theme === th.id ? " active" : "");
      b.innerHTML = `<span class="swatch" style="background:${th.bg}">${th.ink
        .map((c, i) => `<i style="background:${c};width:${[70, 45, 30][i]}%"></i>`).join("")}</span><span class="name">${t("theme." + th.id)}</span>`;
      b.onclick = () => { update({ theme: th.id }); draw(); };
      return b;
    }));
  };
  draw();
  const langs = back.querySelector(".langs");
  for (const l of LANGUAGES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lang" + (current().lang === l.id ? " active" : "");
    b.textContent = l.name;
    // the panel itself is in the old language: reopen it in the new one
    b.onclick = () => { update({ lang: l.id }); back.remove(); toggleSettings(); };
    langs.append(b);
  }
  const cjk = back.querySelector(".cjk");
  cjk.checked = current().cjkGap;
  cjk.onchange = () => update({ cjkGap: cjk.checked });
  back.onmousedown = (e) => { if (e.target === back) back.remove(); };
  document.body.append(back);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "," && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleSettings(); }
  else if (e.key === "Escape") document.querySelector(".settings-backdrop")?.remove();
});
