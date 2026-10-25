import { backlinks } from "./store.js";
import { taskItem, pageLabel } from "./taskitem.js";
import { hooks } from "./editor.js";
import { t } from "./i18n.js";

// "This page links to": every page linked from the page's own content, once,
// in order of first appearance. Recomputed as the page is edited.
export function renderOutgoing(container, page, doc) {
  const seen = new Set();
  doc.descendants((n) => {
    if (n.type.name === "link" && n.attrs.page !== page) seen.add(n.attrs.page);
    if (n.type.name === "block") for (const p of n.attrs.tags) if (p !== page) seen.add(p);
    return true;
  });
  const key = [...seen].join("|");
  if (container.dataset.key === key) return; // unchanged: keep the DOM
  container.dataset.key = key;
  container.className = "outgoing";
  container.replaceChildren();
  if (!seen.size) return;
  const h = document.createElement("span");
  h.className = "label";
  h.textContent = t("outgoing.title");
  container.append(h);
  for (const id of seen) {
    const a = document.createElement("a");
    a.href = "#";
    a.className = "chip";
    a.textContent = id.startsWith("?") ? id.slice(1) : pageLabel(id);
    a.onclick = (e) => { e.preventDefault(); hooks.openPage(id); };
    container.append(a);
  }
}

// "Linked references": blocks on other pages whose line links here, grouped
// by page, each editable in place. Blocks on this page are left out — they
// are already in the editor above, and two editors on one block would race.
export function renderBacklinks(container, page, ctx) {
  const refs = backlinks(page).filter((b) => b.page !== page);
  container.className = "backlinks";
  container.replaceChildren();
  container.hidden = !refs.length; // nothing links here: no section at all
  if (!refs.length) return;
  const h = document.createElement("h3");
  h.innerHTML = `${t("backlinks.title")}<span class="count">${refs.length}</span>`;
  container.append(h);
  const itemCtx = { ...ctx, rerender: () => {} };
  const pages = [...new Set(refs.map((b) => b.page))];
  for (const p of pages) {
    const sec = document.createElement("section");
    sec.className = "group";
    const a = document.createElement("a");
    a.href = "#";
    a.className = "chip source";
    a.textContent = pageLabel(p);
    a.onclick = (e) => { e.preventDefault(); ctx.openPage(p); };
    sec.append(a);
    for (const b of refs.filter((r) => r.page === p)) sec.append(taskItem(b, itemCtx, [], { showPage: false }));
    container.append(sec);
  }
}
