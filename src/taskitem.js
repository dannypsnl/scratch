import { Fragment } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import { keymap } from "prosemirror-keymap";
import { splitRootAsChild, singleRoot } from "./outline.js";
import { schema } from "./schema.js";
import { createEditor } from "./editor.js";
import { getBlock, replaceBlock, titleOf } from "./store.js";

// One block (a task, a backlink), editable in place wherever it is listed.
// Edits write straight back to the block on its page. Children are folded by
// default; unfolding edits them too.

// A page is named the same everywhere: the title its links show.
export const pageLabel = (page) => titleOf(page);

const T = schema.nodes;

// What decides where a task is listed. Only a change here re-renders the list;
// ordinary editing (typing, new plain blocks) must not, or the caret is lost.
const signature = (doc) => {
  let s = "";
  doc.descendants((n) => {
    if (n.type !== T.block) return false;
    if (n.attrs.task || n.attrs.deadline) s += `${n.attrs.id}:${n.attrs.task}:${n.attrs.deadline};`;
    return true;
  });
  return s;
};

// Unfolded items stay unfolded across re-renders.
const unfolded = new Set();

// item: { id, page, node, trail }
// ctx: { track(view), rerender(focusId), openPage(id) }; labels: extra tags
export function taskItem(task, ctx, labels = [], { showPage = true } = {}) {
  const el = document.createElement("div");
  el.className = "task-item";
  el.dataset.id = task.id;

  const fold = document.createElement("button");
  fold.className = "fold";
  const editor = document.createElement("div");
  editor.className = "task-editor";
  const meta = document.createElement("div");
  meta.className = "task-meta";

  if (showPage) {
    const page = document.createElement("a");
    page.href = "#";
    page.className = "chip";
    page.textContent = pageLabel(task.page);
    page.onclick = (e) => { e.preventDefault(); ctx.openPage(task.page); };
    meta.append(page);
  }
  for (const l of labels) {
    const s = document.createElement("span");
    s.className = "tag " + (l.cls ?? "");
    s.textContent = l.text;
    meta.append(s);
  }
  if (task.trail.length) {
    const t = document.createElement("span");
    t.className = "trail";
    t.textContent = task.trail.join(" › ");
    meta.append(t);
  }
  el.append(fold, editor, meta);

  let folded = !unfolded.has(task.id);
  let view = null;
  function mount(caretInFirstChild = false) {
    const node = getBlock(task.id) ?? task.node;
    const hasChildren = node.childCount > 1;
    fold.textContent = hasChildren ? (folded ? "▸" : "▾") : "";
    fold.disabled = !hasChildren;
    view?.destroy();
    const block = folded ? node.copy(Fragment.from(node.firstChild)) : node;
    view = createEditor(editor, T.doc.create(null, block), {
      plugins: [keymap({ Enter: splitRootAsChild }), singleRoot],
      onUpdate(v, prev, tr) {
        if (!tr.docChanged) return;
        replaceBlock(task.id, [v.state.doc.firstChild], { folded });
        if (signature(prev.doc) !== signature(v.state.doc)) setTimeout(() => ctx.rerender(task.id));
        else if (folded && v.state.doc.firstChild.childCount > 1) {
          // a child was just added to a folded task: unfold to show it
          folded = false;
          unfolded.add(task.id);
          setTimeout(() => mount(true));
        }
      },
    });
    ctx.track(view);
    if (caretInFirstChild) {
      const at = 1 + view.state.doc.firstChild.firstChild.nodeSize + 2;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
      view.focus();
    }
  }
  fold.onclick = () => {
    folded = !folded;
    if (folded) unfolded.delete(task.id); else unfolded.add(task.id);
    mount();
  };
  mount();
  el.focusEditor = () => view.focus();
  return el;
}
