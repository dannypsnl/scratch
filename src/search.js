import { serializeMath } from "./latex.js";
import { compileFilter } from "./filter.js";

// Search across every page: titles, block text, tags and links, formulas
// (by their LaTeX and by the plain text inside them). No DOM and no store:
// the caller hands over the pages, so the same index serves the app's search
// box (searchbox.js) and anything else that reads the notes.
//
//   const s = createSearch({ pages: () => [[id, doc], …], title: (id) => "…" });
//   s.query("拓樸 -draft")  // -> { groups: [{ page, title, titleHit, blocks: [{ id, text, tex, hits }] }], total, more }
//
// Query terms are those of filter.js: plain words match text (case
// ignored), a leading "-" negates, and key:value terms (tag:, link:,
// status:, has:, deadline: …) work on blocks as they do in task views. At
// least one term must be positive. A block matches when all terms hold for
// its own line; a page's title the same way.

// One block as searched and shown. `text` is its line as read, a formula
// written as its LaTeX (`tex` holds those spans as [from, to]); plain words
// are matched against `item.text`, lowercased: the text plus each formula's
// plain content.
function entry(block, page, pageTitle) {
  const line = block.firstChild;
  let text = "", plain = "";
  const tex = [], links = [];
  if (line.type.name === "codeblock") text = line.textContent.replace(/\s*\n\s*/g, " ");
  else line.forEach((n) => {
    switch (n.type.name) {
      case "text": text += n.text; break;
      case "link":
        links.push(n.attrs.page);
        text += pageTitle(n.attrs.page);
        break;
      case "math": {
        const src = serializeMath(n.content);
        tex.push([text.length, text.length + src.length]);
        text += src;
        plain += " " + n.textContent;
        break;
      }
      case "image": text += n.attrs.alt; break;
    }
  });
  const { id, task, deadline, tags } = block.attrs;
  for (const p of tags) {
    links.push(p);
    text += (text ? " #" : "#") + pageTitle(p);
  }
  // what filter.js reads
  const item = { text: (text + plain).toLowerCase(), links: links.map(pageTitle), task, deadline, date: isDate(page) ? page : null };
  return { id, text, tex, item };
}

// Every block of a page in document order.
function indexDoc(doc, page, pageTitle) {
  const out = [];
  const walk = (b) => {
    out.push(entry(b, page, pageTitle));
    b.forEach((c, _, i) => { if (i > 0) walk(c); });
  };
  doc.forEach(walk);
  return out;
}

const isDate = (id) => /^\d{4}-\d\d-\d\d$/.test(id);

// The words to mark in what is shown: positive plain words, and the page
// named by a tag: or link: term.
export function highlightTerms(q) {
  return q.trim().split(/\s+/).filter((w) => w && !w.startsWith("-")).flatMap((w) => {
    const m = /^(\w+):(.+)$/.exec(w);
    if (!m) return [w.toLowerCase()];
    return m[1] === "tag" || m[1] === "link" ? [m[2].toLowerCase()] : [];
  });
}

// [from, to] ranges of `text` where any of `words` occurs, merged.
export function hitRanges(text, words) {
  const low = text.toLowerCase(), out = [];
  for (const w of words) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) out.push([i, i + w.length]);
  out.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

// pages(): [[id, doc]] for every page; title(id): its title as shown.
// Pages are reindexed only when their doc changes (docs are immutable, so
// identity says it) or when any title does (links show titles).
export function createSearch({ pages, title }) {
  const cache = new Map(); // page -> { doc, blocks }
  let titles = "";

  function refresh() {
    const list = [...pages()];
    const sig = list.map(([id]) => id + "\u0000" + title(id)).join("\u0001");
    if (sig !== titles) { cache.clear(); titles = sig; }
    const seen = new Set();
    for (const [id, doc] of list) {
      seen.add(id);
      if (cache.get(id)?.doc !== doc) cache.set(id, { doc, blocks: indexDoc(doc, id, title) });
    }
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
  }

  // limit: at most this many blocks in all
  function query(q, { limit = 200 } = {}) {
    const terms = q.trim().split(/\s+/).filter(Boolean);
    if (!terms.some((w) => !w.startsWith("-"))) return { groups: [], total: 0, more: 0 };
    refresh();
    const match = compileFilter(q);
    const words = highlightTerms(q);
    const groups = [];
    let total = 0;
    for (const [page, { blocks }] of cache) {
      const name = title(page);
      // a journal day is found by its ISO date as well as its heading
      const titleHit = match({ text: (isDate(page) ? `${name} ${page}` : name).toLowerCase(), links: [] });
      const hits = [];
      for (const b of blocks) if (b.item.text && match(b.item)) hits.push(b);
      if (!titleHit && !hits.length) continue;
      total += hits.length;
      groups.push({ page, title: name, titleHit, hits });
    }
    // pages named so first, then the most hits; journal days newest first
    groups.sort((a, b) => b.titleHit - a.titleHit || b.hits.length - a.hits.length ||
      (isDate(a.page) && isDate(b.page) ? b.page.localeCompare(a.page) : isDate(a.page) - isDate(b.page) || a.title.localeCompare(b.title)));
    let room = limit;
    const out = groups.map((g) => {
      const shown = g.hits.slice(0, Math.max(room, 0));
      room -= shown.length;
      return {
        page: g.page, title: g.title, titleHit: g.titleHit,
        titleHits: hitRanges(g.title, words),
        blocks: shown.map((b) => ({ id: b.id, text: b.text, tex: b.tex, hits: hitRanges(b.text, words) })),
      };
    }).filter((g) => g.titleHit || g.blocks.length);
    return { groups: out, total, more: Math.max(total - limit, 0) };
  }

  return { query };
}
