import { namedPages } from "./store.js";
import { t } from "./i18n.js";

// Left sidebar: navigation (static, in index.html) and the named pages.
// Dates are picked in the journal's week strip and its calendar dropdown.
export function renderSidebar(ctx) {
  const { state } = ctx;

  const box = document.querySelector(".side-pages");
  const pages = namedPages().sort((a, b) => a.title.localeCompare(b.title));
  box.replaceChildren();
  if (!pages.length) return;
  const h = document.createElement("h3");
  h.textContent = t("tab.pages");
  box.append(h);
  for (const p of pages) {
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = p.title;
    a.className = state.tab === "page" && state.page === p.id ? "active" : "";
    a.onclick = (e) => { e.preventDefault(); ctx.openPage(p.id); };
    box.append(a);
  }
}
