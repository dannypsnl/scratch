import { keymap } from "prosemirror-keymap";
import { DOMSerializer } from "prosemirror-model";
import { splitRootAsChild, singleRoot } from "./outline.js";
import { schema } from "./schema.js";
import { createEditor } from "./editor.js";
import { replaceBlock, titleOf } from "./store.js";

// One block (a task, a backlink), editable in place wherever it is listed.
// Edits write straight back to the block on its page. The block folds here as
// it does there (click its bullet): one fold state, kept on the block.
//
// A list can hold thousands of these, so the editor is made only once its
// item comes near the window: until then the item shows the block drawn
// plainly (about as tall). The first items of a render get theirs at once,
// so what is on screen never shows the plain drawing.

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

// item: { id, page, node, trail }
// ctx: { track(view), rerender(focusId), openPage(id) }; labels: extra tags
export function taskItem(task, ctx, labels = [], { showPage = true } = {}) {
  const el = document.createElement("div");
  el.className = "task-item";
  el.dataset.id = task.id;

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
  el.append(editor, meta);

  let view = null;
  const mount = () => {
    if (view) return view;
    observer?.unobserve(el);
    mounts.delete(el);
    editor.replaceChildren();
    view = createEditor(editor, T.doc.create(null, task.node), {
      plugins: [keymap({ Enter: splitRootAsChild }), singleRoot],
      onUpdate(v, prev, tr) {
        if (!tr.docChanged) return;
        replaceBlock(task.id, [v.state.doc.firstChild]);
        if (signature(prev.doc) !== signature(v.state.doc)) setTimeout(() => ctx.rerender(task.id));
      },
    });
    ctx.track(view);
    return view;
  };
  if (takeEager()) mount();
  else {
    editor.append(plain(task.node));
    mounts.set(el, mount);
    observer.observe(el);
    // taken out of the page before it came near: no editor, nothing watched
    ctx.track({ destroy: () => { observer.unobserve(el); mounts.delete(el); } });
  }
  el.focusEditor = () => mount().focus();
  return el;
}

// The block as the editor draws it, without the editor.
let serializer = null;
function plain(node) {
  serializer ??= DOMSerializer.fromSchema(schema);
  const box = document.createElement("div");
  box.className = "ProseMirror task-plain";
  box.append(serializer.serializeNode(node));
  return box;
}

const mounts = new WeakMap(); // item -> its mount()
const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting && e.target.isConnected) mounts.get(e.target)?.();
}, { rootMargin: "1000px 0px" });

// Items made in one go (one render) mount their editors at once, up to EAGER.
const EAGER = 40;
let eager = 0, counting = false;
function takeEager() {
  if (!observer) return true;
  if (!counting) {
    counting = true;
    eager = EAGER;
    queueMicrotask(() => { counting = false; });
  }
  return eager-- > 0;
}
