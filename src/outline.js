import { Plugin, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { Fragment } from "prosemirror-model";
import { schema, lookup } from "./schema.js";
import { hooks } from "./editor.js";
import { newId } from "./outline-io.js";
import { openDeadlinePicker } from "./deadline.js";
import { today, md } from "./dates.js";
import { fieldsForBlock } from "./store.js";
import { openValueEditor, displayValue } from "./fields.js";
import { t } from "./i18n.js";

// Outline editing: Enter / Tab / Shift-Tab / Backspace between blocks,
// task state cycling, and the per-block id every block carries.

const T = schema.nodes;
export const STATES = [null, "todo", "doing", "done"];
export const nextState = (s) => STATES[(STATES.indexOf(s) + 1) % STATES.length];

function blockDepth($p) {
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type === T.block) return d;
  return -1;
}

// Enter: split the line into a new block. A block with children gets the new
// block as its first child; an empty nested block outdents instead.
export const splitBlock = (state, dispatch) => split(state, dispatch, false);

// In a task item the root block is the whole document: Enter on its line opens
// a first child instead of a sibling the list would not show.
export const splitRootAsChild = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type === T.codeblock && $from.depth === 2) return split(state, dispatch, true);
  if ($from.parent.type !== T.line || $from.depth !== 2) return false;
  if ($from.parentOffset === 0 && $from.parent.content.size > 0) return true;
  return split(state, dispatch, true);
};

function split(state, dispatch, asChild) {
  const { $from, $to } = state.selection;
  if ($from.parent.type === T.codeblock) return codeEnter(state, dispatch, asChild);
  if ($from.parent.type !== T.line || !$from.sameParent($to)) return false;
  // a line that is just ```lang turns into a code block
  const fence = /^```(\S*)$/.exec($from.parent.textContent);
  if (fence && $from.parent.childCount === 1 && $from.parent.firstChild.isText) {
    if (dispatch) {
      const tr = state.tr.replaceWith($from.before(), $from.after(), T.codeblock.create({ lang: fence[1] }));
      dispatch(tr.setSelection(TextSelection.create(tr.doc, $from.before() + 1)).scrollIntoView());
    }
    return true;
  }
  const d = $from.depth - 1;
  const block = $from.node(d);
  if (!asChild && $from.parent.content.size === 0 && block.childCount === 1 && d > 1) return outdent(state, dispatch);
  if (!dispatch) return true;
  const tr = state.tr.deleteSelection();
  const $p = tr.selection.$from;
  if (!asChild && $p.parentOffset === 0 && $p.parent.content.size > 0) {
    // at the start of a non-empty line: open an empty block above, keep the caret
    tr.insert($p.before(d), T.block.create({ id: newId() }, T.line.create()));
    dispatch(tr.scrollIntoView());
    return true;
  }
  const rest = $p.parent.content.cut($p.parentOffset);
  const cut = $p.end() - $p.pos;
  // a folded block's children are hidden: the new block goes beside it
  const intoChildren = asChild || ($p.node(d).childCount > 1 && !$p.node(d).attrs.folded);
  const at = (intoChildren ? $p.after() : $p.after(d)) - cut;
  tr.delete($p.pos, $p.end());
  tr.insert(at, T.block.create({ id: newId() }, T.line.create(null, rest)));
  dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView());
  return true;
}

// Enter in a code block is a line break; on an empty last line it leaves the
// block (dropping that line) and opens the next one.
function codeEnter(state, dispatch, asChild) {
  const { $from, $to } = state.selection;
  const atEnd = $to.pos === $from.end() && $from.parent.textContent.endsWith("\n") && $from.sameParent($to) && $from.pos === $to.pos;
  if (!atEnd) {
    if (dispatch) dispatch(state.tr.insertText("\n").scrollIntoView());
    return true;
  }
  if (!dispatch) return true;
  const d = $from.depth - 1;
  const tr = state.tr.delete($from.pos - 1, $from.pos);
  const $p = tr.doc.resolve($from.pos - 1);
  const block = $p.node(d);
  const intoChildren = asChild || (block.childCount > 1 && !block.attrs.folded);
  const at = intoChildren ? $p.after() : $p.after(d);
  tr.insert(at, T.block.create({ id: newId() }, T.line.create()));
  dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView());
  return true;
}

// Task items: anything that would leave a second top-level block is refused.
export const singleRoot = new Plugin({
  filterTransaction: (tr) => !tr.docChanged || tr.doc.childCount === 1,
});

// Tab: become the last child of the previous sibling.
export const indent = (state, dispatch) => {
  const { $from, from } = state.selection;
  const d = blockDepth($from);
  if (d < 0) return false;
  if ($from.index(d - 1) === 0) return true;
  if (dispatch) {
    const start = $from.before(d), end = $from.after(d);
    const tr = state.tr.delete(start, end).insert(start - 1, $from.node(d));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, from - 1)).scrollIntoView());
  }
  return true;
};

// Shift-Tab: become the next sibling of the parent block.
export const outdent = (state, dispatch) => {
  const { $from, from } = state.selection;
  const d = blockDepth($from);
  if (d < 2) return d > 0;
  if (dispatch) {
    const start = $from.before(d), end = $from.after(d);
    const at = $from.after(d - 1) - (end - start);
    const tr = state.tr.delete(start, end).insert(at, $from.node(d));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, at + (from - start))).scrollIntoView());
  }
  return true;
};

// Mod-Shift-Enter: a new empty top-level block after the current one's
// top-level ancestor (and all of its children), from any depth.
export const newTopBlock = (state, dispatch) => {
  const { $from } = state.selection;
  if (blockDepth($from) < 1) return false;
  if (dispatch) {
    const at = $from.after(1);
    const tr = state.tr.insert(at, T.block.create({ id: newId() }, T.line.create()));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView());
  }
  return true;
};

// Backspace at the start of a line: append it to the previous line; its
// children take its place.
export const joinBackward = (state, dispatch) => {
  const sel = state.selection;
  // at the start of a code block: an empty one turns back into a line,
  // anything else stays put
  if (sel.empty && sel.$from.parent.type === T.codeblock && sel.$from.parentOffset === 0) {
    if (dispatch && !sel.$from.parent.content.size) {
      const $p = sel.$from;
      const tr = state.tr.replaceWith($p.before(), $p.after(), T.line.create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, $p.before() + 1)));
    }
    return true;
  }
  if (!sel.empty || sel.$from.parent.type !== T.line || sel.$from.parentOffset !== 0) return false;
  const $p = sel.$from;
  const d = $p.depth - 1;
  const start = $p.before(d), end = $p.after(d);
  const prev = TextSelection.findFrom(state.doc.resolve(start), -1, true);
  if (!prev) return true;
  // the line above is an empty block of its own (no text, no children, no
  // task): it goes, and this block stays as it is, children and all
  const $q = prev.$from, above = $q.node($q.depth - 1);
  if ($q.parent.type === T.line && !$q.parent.content.size && above.type === T.block && above.childCount === 1 && !above.attrs.task && !above.attrs.deadline) {
    if (dispatch) dispatch(state.tr.delete($q.before($q.depth - 1), $q.after($q.depth - 1)).scrollIntoView());
    return true;
  }
  if (dispatch) {
    const block = $p.node(d);
    const children = block.content.cut(block.firstChild.nodeSize);
    const tr = state.tr.replaceWith(start, end, children).insert(prev.from, $p.parent.content);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, prev.from)).scrollIntoView());
  }
  return true;
};

// Fold / unfold the block at the caret (⌘↑ / ⌘↓), or toggle one by position
// (the fold arrow). Only blocks with children fold.
function caretBlock($p) {
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type === T.block) return { pos: $p.before(d), node: $p.node(d) };
  return null;
}
export const setFold = (folded) => (state, dispatch) => {
  const b = caretBlock(state.selection.$from);
  if (!b || b.node.childCount < 2 || b.node.attrs.folded === folded) return !!b;
  if (dispatch) dispatch(state.tr.setNodeMarkup(b.pos, null, { ...b.node.attrs, folded }));
  return true;
};
export function toggleFoldAt(view, pos) {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type !== T.block || node.childCount < 2) return;
  let tr = view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, folded: !node.attrs.folded });
  // never leave the caret inside the part that just disappeared
  const { from } = tr.selection;
  const childrenStart = pos + 1 + node.firstChild.nodeSize, end = pos + node.nodeSize;
  if (!node.attrs.folded && from > childrenStart && from < end) {
    tr = tr.setSelection(TextSelection.create(tr.doc, childrenStart - 1));
  }
  view.dispatch(tr);
}

// ⌘A: the current line first, the whole page on the second press.
export const selectAll = (state, dispatch) => {
  const { $from, from, to } = state.selection;
  let d = $from.depth; // in a formula the line is further up
  while (d > 0 && $from.node(d).type !== T.line && $from.node(d).type !== T.codeblock) d--;
  if (d > 0) {
    const start = $from.start(d), end = $from.end(d);
    if (from !== start || to !== end) {
      if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, start, end)));
      return true;
    }
  }
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.between(state.doc.resolve(0), state.doc.resolve(state.doc.content.size))));
  return true;
};

// Blocks whose line overlaps the selection, as [pos, node].
export function selectedBlocks(state) {
  const { from, to } = state.selection;
  const out = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type !== T.block) return true;
    const lineEnd = pos + 1 + node.firstChild.nodeSize;
    if (lineEnd > from && pos + 1 <= to) out.push([pos, node]);
    return true;
  });
  return out;
}

export function withTask(attrs, task) {
  return { ...attrs, task, log: [...attrs.log, { state: task ?? "none", at: new Date().toISOString() }] };
}

function setTask(state, dispatch, targets, task) {
  if (dispatch) {
    const tr = state.tr;
    for (const [pos, node] of targets) tr.setNodeMarkup(pos, null, withTask(node.attrs, task));
    dispatch(tr);
  }
  return true;
}

// Cmd-Enter: none -> TODO -> DOING -> DONE -> none, on every selected block.
export const cycleTask = (state, dispatch) => {
  const targets = selectedBlocks(state);
  if (!targets.length) return false;
  return setTask(state, dispatch, targets, nextState(targets[0][1].attrs.task));
};

export function setDeadline(view, positions, deadline) {
  const tr = view.state.tr;
  for (const pos of positions) {
    const node = tr.doc.nodeAt(pos);
    tr.setNodeMarkup(pos, null, { ...node.attrs, deadline });
  }
  view.dispatch(tr);
}

// Every block gets a unique id (new blocks, pasted copies).
export const blockIds = new Plugin({
  appendTransaction(trs, _old, state) {
    if (!trs.some((tr) => tr.docChanged)) return null;
    const seen = new Set();
    let tr = null;
    state.doc.descendants((node, pos) => {
      if (node.type !== T.block) return false;
      if (!node.attrs.id || seen.has(node.attrs.id)) {
        tr ??= state.tr;
        tr.setNodeMarkup(pos, null, { ...node.attrs, id: newId() });
      } else seen.add(node.attrs.id);
      return true;
    });
    return tr;
  },
});

const LABEL = { todo: "TODO", doing: "DOING", done: "DONE" };
const RING = '<circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.6"/>';
const ICON = {
  todo: RING,
  doing: RING + '<path d="M8 4.3a3.7 3.7 0 0 1 0 7.4z" fill="currentColor"/>',
  done: '<circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M5 8.2l2.1 2.1L11 6.3" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
};
export const taskIconHTML = (task) => `<span class="task-icon task-${task}"><svg viewBox="0 0 16 16" aria-hidden="true">${ICON[task]}</svg></span>`;

// Task icon before the line, deadline badge after it. Both sit between the
// block's nodes, outside the line: a non-editable element inside the line
// leaves WebKit no place for the caret next to it (typing just beeps).
export const outlineDecorations = new Plugin({
  props: {
    decorations(state) {
      const decos = [];
      state.doc.descendants((node, pos) => {
        if (node.type !== T.block) return false;
        const { task, deadline } = node.attrs;
        const beforeLine = pos + 1, afterLine = pos + 1 + node.firstChild.nodeSize;
        const blockAt = (view, getPos) => view.state.doc.resolve(getPos()).before();
        if (task) {
          decos.push(Decoration.widget(beforeLine, (view, getPos) => {
            const el = document.createElement("span");
            el.className = `task-icon task-${task}`;
            el.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICON[task]}</svg>`;
            el.title = t("task.toggle", LABEL[task]);
            el.addEventListener("mousedown", (e) => {
              e.preventDefault();
              const p = blockAt(view, getPos);
              const n = view.state.doc.nodeAt(p);
              setTask(view.state, view.dispatch, [[p, n]], nextState(n.attrs.task));
            });
            return el;
          }, { side: -1, key: `task-${task}`, ignoreSelection: true }));
        }
        if (deadline) {
          decos.push(Decoration.widget(afterLine, (view, getPos) => {
            const el = document.createElement("span");
            const overdue = deadline < today() && task !== "done";
            el.className = "deadline" + (overdue ? " overdue" : "");
            el.textContent = t("deadline.badge", md(deadline));
            el.addEventListener("mousedown", (e) => {
              e.preventDefault();
              openDeadlinePicker(view, [blockAt(view, getPos)]);
            });
            return el;
          }, { side: 1, key: `dl-${deadline}-${task}`, ignoreSelection: true }));
        }
        const tags = [];
        node.firstChild.forEach((n) => { if (n.type === T.link && n.attrs.tag) tags.push(n.attrs.page); });
        if (tags.length) {
          decos.push(Decoration.widget(afterLine, (view, getPos) => tagRow(tags, view, getPos), { side: 0, key: `tags-${tags.join("|")}`, ignoreSelection: true, stopEvent: () => true }));
        }
        const fields = fieldsForBlock(node);
        if (fields.length) {
          const key = `props-${fields.map((f) => f.id + f.name + f.type).join("|")}-${JSON.stringify(node.attrs.props)}`;
          decos.push(Decoration.widget(afterLine, (view, getPos) => propRow(fields, node.attrs.props, view, getPos), { side: 1.5, key, ignoreSelection: true, stopEvent: () => true }));
        }
        const video = youtubeId(node.firstChild.textContent);
        if (video) decos.push(Decoration.widget(afterLine, () => youtubePreview(video), { side: 2, key: `yt-${video}`, ignoreSelection: true, stopEvent: () => true }));
        return true;
      });
      return DecorationSet.create(state.doc, decos);
    },
  },
});

// ---------- fields ----------

// The fields a tagged block offers, under its line: filled ones as chips,
// empty ones dashed. Click to pick or type a value.
function propRow(fields, props, view, getPos) {
  const row = document.createElement("span");
  row.className = "prop-row";
  row.contentEditable = "false";
  for (const f of fields) {
    const chip = document.createElement("button");
    chip.type = "button";
    const shown = displayValue(f, props?.[f.id]);
    chip.className = "prop" + (shown === null ? " empty" : "");
    chip.innerHTML = `<span class="pname"></span><span class="pval"></span>`;
    chip.firstChild.textContent = f.name;
    chip.lastChild.textContent = shown ?? t("fields.empty");
    chip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      openValueEditor(chip, f, props?.[f.id], (v) => {
        const blockPos = view.state.doc.resolve(getPos()).before();
        const node = view.state.doc.nodeAt(blockPos);
        const next = { ...node.attrs.props };
        if (v === null || v === "") delete next[f.id];
        else next[f.id] = v;
        view.dispatch(view.state.tr.setNodeMarkup(blockPos, null, { ...node.attrs, props: next }));
      });
    });
    row.append(chip);
  }
  return row;
}

// ---------- tags ----------

// A tag link draws itself hidden in the line (style.css); its block's row
// shows them all here, right-aligned, in order. Each chip opens its page;
// its × removes that tag from the line.
function tagRow(pages, view, getPos) {
  const row = document.createElement("span");
  row.className = "tag-row";
  row.contentEditable = "false";
  pages.forEach((page, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const name = document.createElement("a");
    name.textContent = "#" + lookup.title(page);
    name.addEventListener("mousedown", (e) => { e.preventDefault(); hooks.openPage(page); });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chip-x";
    remove.textContent = "×";
    remove.addEventListener("mousedown", (e) => {
      e.preventDefault();
      // the i-th tag in this block's line
      const blockPos = view.state.doc.resolve(getPos()).before();
      const line = view.state.doc.nodeAt(blockPos).firstChild;
      let pos = blockPos + 2, seen = 0, at = null;
      line.forEach((n) => {
        if (at === null && n.type === T.link && n.attrs.tag && seen++ === i) at = pos;
        pos += n.nodeSize;
      });
      if (at !== null) view.dispatch(view.state.tr.delete(at, at + 1));
    });
    chip.append(name, remove);
    row.append(chip);
  });
  return row;
}

// ---------- YouTube ----------

// The first YouTube address in a block's line, as a video id.
export function youtubeId(text) {
  const m = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^\s]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(text);
  return m ? m[1] : null;
}

// The player itself, below the line. The widget keeps its key while the
// block is edited, so typing does not reload the video.
function youtubePreview(id) {
  const box = document.createElement("div");
  box.className = "yt-preview";
  box.contentEditable = "false";
  const frame = document.createElement("iframe");
  frame.src = `https://www.youtube-nocookie.com/embed/${id}`;
  frame.loading = "lazy";
  frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  frame.allowFullscreen = true;
  frame.title = "YouTube";
  box.append(frame);
  return box;
}
