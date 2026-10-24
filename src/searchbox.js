import { pagesAll, titleOf, isDate } from "./store.js";
import { createSearch } from "./search.js";
import { t } from "./i18n.js";

// The search box (⌘K, or 搜尋 in the sidebar): every page and journal day,
// results as you type, grouped by page. ↑ ↓ move, ↵ opens the page at that
// block, Esc closes. The query stays for the next time it opens.

const search = createSearch({ pages: pagesAll, title: titleOf });
let last = "";

// The text shown for a block: its line, cut to a window around the first
// match when long; formulas (as LaTeX) and matches marked.
const WINDOW = 160;
function snippet(text, tex, hits) {
  let from = 0, to = text.length;
  if (to > WINDOW) {
    from = Math.max(0, (hits[0]?.[0] ?? 0) - 40);
    to = Math.min(text.length, from + WINDOW);
  }
  const cuts = new Set([from, to]);
  for (const [a, b] of [...tex, ...hits]) { cuts.add(Math.min(Math.max(a, from), to)); cuts.add(Math.min(Math.max(b, from), to)); }
  const points = [...cuts].sort((a, b) => a - b);
  const frag = document.createDocumentFragment();
  if (from > 0) frag.append("…");
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k], b = points[k + 1];
    if (a === b) continue;
    let node = document.createTextNode(text.slice(a, b));
    if (hits.some(([x, y]) => x <= a && b <= y)) { const m = document.createElement("mark"); m.append(node); node = m; }
    if (tex.some(([x, y]) => x <= a && b <= y)) { const s = document.createElement("span"); s.className = "tex"; s.append(node); node = s; }
    frag.append(node);
  }
  if (to < text.length) frag.append("…");
  return frag;
}

// open.page(id) and open.block(page, id) navigate.
export function openSearch(open) {
  const existing = document.querySelector(".search-backdrop");
  if (existing) return existing.querySelector("input").select();
  const back = document.createElement("div");
  back.className = "search-backdrop";
  back.innerHTML = `
    <div class="search" role="dialog" aria-label="${t("search.button")}">
      <input class="search-input" placeholder="${t("search.placeholder")}">
      <div class="search-results"></div>
      <div class="search-foot"><span class="search-count"></span><span>${t("search.keys")}</span></div>
    </div>`;
  const input = back.querySelector("input");
  const results = back.querySelector(".search-results");
  const count = back.querySelector(".search-count");
  const before = document.activeElement;
  let items = [], active = 0;

  const close = (refocus) => {
    back.remove();
    if (refocus && before?.isConnected) before.focus();
  };
  const go = (item) => {
    close(false);
    if (item.block) open.block(item.page, item.block);
    else open.page(item.page);
  };
  const setActive = (k) => {
    items[active]?.el.classList.remove("active");
    active = k;
    const it = items[active];
    if (!it) return;
    it.el.classList.add("active");
    it.el.scrollIntoView({ block: "nearest" });
  };

  function render() {
    last = input.value;
    const { groups, total, more } = search.query(input.value);
    items = [];
    results.replaceChildren();
    for (const g of groups) {
      const box = document.createElement("section");
      box.className = "search-group";
      box.dataset.page = g.page;
      const head = document.createElement("div");
      head.className = "search-page" + (isDate(g.page) ? " journal" : "");
      // (the title's pieces in one span: in the flex row each would be an item, gaps between)
      const name = document.createElement("span");
      name.append(snippet(g.title, [], g.titleHits));
      head.append(name);
      if (g.blocks.length) {
        const n = document.createElement("span");
        n.className = "count";
        n.textContent = g.blocks.length;
        head.append(n);
      }
      box.append(head);
      // the page itself is a result only when its title matches
      if (g.titleHit) items.push({ page: g.page, el: head });
      else head.classList.add("plain");
      for (const b of g.blocks) {
        const row = document.createElement("div");
        row.className = "search-hit";
        row.dataset.block = b.id;
        row.append(snippet(b.text, b.tex, b.hits));
        box.append(row);
        items.push({ page: g.page, block: b.id, el: row });
      }
      results.append(box);
    }
    items.forEach((it, k) => {
      it.el.onmousedown = (e) => { e.preventDefault(); go(it); };
      it.el.onmousemove = () => { if (active !== k) setActive(k); };
    });
    count.textContent = !input.value.trim() ? "" : !groups.length ? t("search.empty") : t("search.count", total) + (more ? " · " + t("search.more", more) : "");
    active = 0;
    setActive(0);
  }

  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) setActive((active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[active]) go(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  });
  back.onmousedown = (e) => { if (e.target === back) close(true); };
  document.body.append(back);
  input.value = last;
  render();
  input.select();
}
