import { TextSelection, Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { getPage, savePage, titleOf, renamePage, namedPages, backlinks, findPage, createPage, deletePage, isDate, onRemote } from "./store.js";
import { createEditor } from "./editor.js";
import { emptyDoc } from "./outline-io.js";
import { renderBacklinks, renderOutgoing } from "./backlinks.js";
import { renderPageTable } from "./pagetable.js";
import { t } from "./i18n.js";

// Shared by journal days and named pages: the outline editor, its export
// the linked references underneath.

function replaceDoc(view, next) {
  const { state } = view;
  if (state.doc.eq(next)) return;
  // remember the caret as (block id, offset in its line)
  const $h = state.selection.$head;
  let id = null, offset = 0;
  for (let d = $h.depth; d > 0; d--) {
    if ($h.node(d).type.name === "block") { id = $h.node(d).attrs.id; offset = $h.pos - $h.start(d) - 1; break; }
  }
  const tr = state.tr.replaceWith(0, state.doc.content.size, next.content).setMeta("remote", true).setMeta("addToHistory", false);
  let caret = null;
  tr.doc.descendants((n, pos) => {
    if (caret === null && n.type.name === "block" && n.attrs.id === id) caret = pos + 2 + Math.min(offset, n.firstChild.nodeSize - 2);
    return caret === null;
  });
  if (caret !== null) tr.setSelection(TextSelection.near(tr.doc.resolve(caret)));
  view.dispatch(tr);
}

// The block just arrived at (from search or a block reference), marked for a
// moment: meta with its position, or null to clear.
const flashKey = new PluginKey("flash");
const flash = new Plugin({
  key: flashKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const at = tr.getMeta(flashKey);
      if (at === undefined) return set.map(tr.mapping, tr.doc);
      return at === null ? DecorationSet.empty : DecorationSet.create(tr.doc, [Decoration.node(at, at + tr.doc.nodeAt(at).nodeSize, { class: "pm-flash" })]);
    },
  },
  props: { decorations: (s) => flashKey.getState(s) },
});

// A delete button that asks once more before acting.
export function deleteButton(onDelete) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "page-del";
  b.textContent = t("pages.delete");
  let armed = false;
  b.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (armed) return onDelete();
    armed = true;
    b.textContent = t("pages.confirmDelete");
    b.classList.add("armed");
  };
  b.onblur = () => { armed = false; b.textContent = t("pages.delete"); b.classList.remove("armed"); };
  return b;
}

// root must contain .editor and .backlinks.
// options.table: linked blocks as a table (named pages) instead of the
// grouped list (journal days); options.focus: put the caret in the editor.
export function mountOutline(root, page, ctx, { table = false, focus = true } = {}) {
  const renderLinked = table ? renderPageTable : renderBacklinks;
  const view = createEditor(root.querySelector(".editor"), getPage(page) ?? emptyDoc(), {
    plugins: [flash],
    onUpdate(v, _prev, tr) {
      if (tr.docChanged && !tr.getMeta("remote")) savePage(page, v.state.doc);
      if (tr.docChanged) renderOutgoing(outgoingEl, page, v.state.doc);
    },
  });
  ctx.track(view);
  const backlinksEl = root.querySelector(".backlinks");
  const outgoingEl = document.createElement("div");
  backlinksEl.after(outgoingEl);
  renderOutgoing(outgoingEl, page, view.state.doc);
  renderLinked(backlinksEl, page, ctx);

  // another device changed this page: swap the content in, keep the caret
  // on the same block; backlinks may have changed from any page
  const off = onRemote((changed) => {
    if (changed.has(page)) replaceDoc(view, getPage(page) ?? emptyDoc());
    if (!backlinksEl.contains(document.activeElement)) renderLinked(backlinksEl, page, ctx);
  });
  ctx.track({ destroy: off });

  // arriving from search or a block reference: the caret at the end of that
  // block's line, folded blocks around it opened, the block in the middle of
  // the window and marked for a moment
  let at = null;
  if (ctx.state.focusBlock) {
    view.state.doc.descendants((n, pos) => {
      if (at === null && n.type.name === "block" && n.attrs.id === ctx.state.focusBlock) at = pos;
      return at === null;
    });
    ctx.state.focusBlock = null;
  }
  if (at !== null) {
    const tr = view.state.tr;
    const $at = tr.doc.resolve(at);
    for (let d = $at.depth; d > 0; d--) {
      const n = $at.node(d);
      if (n.attrs.folded) tr.setNodeMarkup($at.before(d), null, { ...n.attrs, folded: false });
    }
    tr.setSelection(TextSelection.create(tr.doc, at + tr.doc.nodeAt(at).firstChild.nodeSize));
    view.dispatch(tr.setMeta(flashKey, at).setMeta("addToHistory", false));
    view.nodeDOM(at)?.scrollIntoView({ block: "center" });
    setTimeout(() => { if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(flashKey, null)); }, 1600);
  }
  if (focus || at !== null) view.focus();
  window.view = view; // for poking at it from devtools
  return view;
}

export function renderPage(root, ctx) {
  const page = ctx.state.page;
  // the table leads; the page's own notes sit below it (an empty page shows
  // one empty bullet, which is invitation enough)
  const doc = getPage(page);
  const hasNotes = doc && !(doc.childCount === 1 && doc.firstChild.childCount === 1 && doc.firstChild.firstChild.content.size === 0);
  root.innerHTML = `
    <div class="journal">
      <section class="page named-page">
        <div class="page-head"><input class="page-title" spellcheck="false"></div>
        <div class="editor"></div>
        <section class="backlinks"></section>
      </section>
    </div>`;
  const title = root.querySelector(".page-title");
  title.value = titleOf(page);
  root.querySelector(".page-head").append(deleteButton(() => {
    deletePage(page);
    ctx.state.tab = "pages";
    ctx.render();
  }));
  title.onchange = () => {
    const t = title.value.trim();
    const other = findPage(t);
    if (!t || (other && other !== page)) { title.value = titleOf(page); return; } // no empty or duplicate titles
    renamePage(page, t);
  };
  title.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } };
  mountOutline(root, page, ctx, { table: true, focus: hasNotes });
}

export function renderPages(root, ctx) {
  const pages = namedPages()
    .map((p) => ({ ...p, refs: backlinks(p.id).filter((b) => b.page !== p.id).length }))
    .sort((a, b) => a.title.localeCompare(b.title));
  root.innerHTML = `
    <div class="pages">
      <input class="new-page" placeholder="${t("pages.new")}">
      <ul class="page-list"></ul>
    </div>`;
  const input = root.querySelector(".new-page");
  input.onkeydown = (e) => {
    if (e.key !== "Enter" || !input.value.trim()) return;
    const t = input.value.trim();
    ctx.openPage(findPage(t) ?? (isDate(t) ? t : createPage(t)));
  };
  const list = root.querySelector(".page-list");
  for (const p of pages) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = p.title;
    a.onclick = (e) => { e.preventDefault(); ctx.openPage(p.id); };
    const n = document.createElement("span");
    n.className = "count";
    n.textContent = p.refs;
    n.title = t("pages.refCount");
    li.append(a, deleteButton(() => { deletePage(p.id); ctx.render(); }), n);
    list.append(li);
  }
  if (!pages.length) list.innerHTML = `<li class="empty">${t("pages.empty")}</li>`;
  input.focus();
}
