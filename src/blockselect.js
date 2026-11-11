import { Plugin, Selection, SelectionRange, TextSelection, NodeSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { Fragment, Slice } from "prosemirror-model";
import { closeHistory } from "prosemirror-history";
import { schema } from "./schema.js";

// Selecting blocks, as Logseq does: there is no selection of text across
// blocks. A selection whose ends are in two blocks (dragged with the mouse,
// Shift-click, Shift-↑↓, ⌘A twice) takes in whole blocks instead: every block
// from the one it started in to the one it ends in, each with its children.
// Escape on a line selects its block. The selected blocks are drawn tinted,
// with no text selection on them; Backspace removes them, ⌘C / ⌘X copy them
// as an outline, Enter goes back to editing, ↑↓ move to the block above /
// below (Shift: the selection grows), and they are dragged together by any
// of their bullets.

const T = schema.nodes;

// the block a position is in (its line, a formula in it): its pos
export function blockAt(doc, pos) {
  const $p = doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type === T.block) return $p.before(d);
  // between blocks: the one after (else the one before)
  const after = $p.nodeAfter?.type === T.block ? pos : null;
  return after ?? ($p.nodeBefore?.type === T.block ? pos - $p.nodeBefore.nodeSize : null);
}

// blocks from the one at a to the one at b (either order), in document
// order: the "rows" of a selection, each a pos
function rowsBetween(doc, a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b), out = [];
  doc.nodesBetween(lo, hi + 1, (n, p) => {
    if (n.type !== T.block) return false;
    if (p >= lo && p <= hi) out.push(p);
    return true;
  });
  return out;
}

// of rows, those whose parent is not among them: what moves, is copied or
// removed (each with its children)
function rootsOf(doc, rows) {
  const set = new Set(rows), out = [];
  for (const p of rows) {
    const $p = doc.resolve(p);
    if ($p.depth === 0 || !set.has($p.before($p.depth))) out.push(p);
  }
  return out;
}

// anchor and head are positions in text (where the selection's ends were
// when it was made): the browser's own selection is left as it is, only not
// drawn. The blocks are worked out from them.
export class BlockSelection extends Selection {
  constructor($anchor, $head) {
    const doc = $anchor.doc;
    const a = blockAt(doc, $anchor.pos), h = blockAt(doc, $head.pos);
    const rows = rowsBetween(doc, a, h);
    const roots = rootsOf(doc, rows);
    const ranges = roots.map((p) => new SelectionRange(doc.resolve(p), doc.resolve(p + doc.nodeAt(p).nodeSize)));
    super($anchor, $head, ranges);
    this.anchorBlock = a;
    this.headBlock = h;
    this.rows = rows;
    this.roots = roots;
  }

  get from() { return this.ranges[0].$from.pos; }
  get to() { return this.ranges[this.ranges.length - 1].$to.pos; }
  get $from() { return this.ranges[0].$from; }
  get $to() { return this.ranges[this.ranges.length - 1].$to; }

  map(doc, mapping) {
    const a = mapping.mapResult(this.anchor), h = mapping.mapResult(this.head);
    if (a.deleted || h.deleted) return Selection.near(doc.resolve(mapping.map(this.head)));
    return BlockSelection.between(doc, a.pos, h.pos);
  }

  eq(other) {
    return other instanceof BlockSelection && other.anchor === this.anchor && other.head === this.head;
  }

  // the blocks, as a slice of whole blocks (for the clipboard)
  content() {
    const doc = this.$anchor.doc;
    return new Slice(Fragment.fromArray(this.roots.map((p) => doc.nodeAt(p))), 0, 0);
  }

  // Backspace, ⌘X, anything typed over them: the blocks go, the caret at the
  // end of the line before them. When that is every block, the first stays,
  // emptied (its id and the rest kept: a task item's one block is the task).
  replace(tr, content = Slice.empty) {
    const doc = tr.doc;
    const first = this.roots[0];
    for (const p of [...this.roots].reverse()) {
      const at = tr.mapping.map(p);
      tr.delete(at, at + doc.nodeAt(p).nodeSize);
    }
    if (tr.doc.childCount === 0) tr.insert(0, T.block.create(doc.firstChild.attrs, T.line.create()));
    if (content.size) tr.replace(tr.mapping.map(first), tr.mapping.map(first), content);
    const at = Math.min(tr.mapping.map(first), tr.doc.content.size);
    tr.setSelection(Selection.near(tr.doc.resolve(at), -1));
  }

  replaceWith(tr, node) { this.replace(tr, new Slice(Fragment.from(node), 0, 0)); }

  toJSON() { return { type: "block", anchor: this.anchor, head: this.head }; }
  static fromJSON(doc, json) { return BlockSelection.between(doc, json.anchor, json.head); }

  // anchor and head as text positions near the given ones
  static between(doc, anchor, head) {
    const $a = TextSelection.near(doc.resolve(anchor), anchor <= head ? 1 : -1).$head;
    const $h = TextSelection.near(doc.resolve(head), head < anchor ? 1 : -1).$head;
    return new BlockSelection($a, $h);
  }

  // the blocks at a and b (block positions), from the start of the one's
  // line to the end of the other's
  static blocks(doc, a, b) {
    const start = (p) => p + 2, end = (p) => p + 1 + doc.nodeAt(p).firstChild.nodeSize - 1;
    return a <= b ? new BlockSelection(doc.resolve(start(a)), doc.resolve(end(b))) : new BlockSelection(doc.resolve(end(a)), doc.resolve(start(b)));
  }

  getBookmark() { return new BlockBookmark(this.anchor, this.head); }
}
BlockSelection.prototype.visible = false;
Selection.jsonID("block", BlockSelection);

class BlockBookmark {
  constructor(anchor, head) { this.anchor = anchor; this.head = head; }
  map(mapping) { return new BlockBookmark(mapping.map(this.anchor), mapping.map(this.head)); }
  resolve(doc) {
    const a = Math.min(this.anchor, doc.content.size), h = Math.min(this.head, doc.content.size);
    return blockAt(doc, a) === blockAt(doc, h) ? TextSelection.between(doc.resolve(a), doc.resolve(h)) : BlockSelection.between(doc, a, h);
  }
}

// visible blocks (not inside a folded one), in document order
function visibleBlocks(doc) {
  const out = [];
  doc.descendants((n, p) => {
    if (n.type !== T.block) return false;
    out.push(p);
    return !n.attrs.folded;
  });
  return out;
}

// Escape on a line: its block, selected
export const selectBlock = (state, dispatch) => {
  const sel = state.selection;
  if (sel instanceof BlockSelection) return false;
  const b = blockAt(state.doc, sel.head);
  if (b == null) return false;
  if (dispatch) dispatch(state.tr.setSelection(BlockSelection.blocks(state.doc, b, b)));
  return true;
};

// ↑ ↓ over selected blocks: the block above / below is selected instead;
// with Shift, the selection grows (or shrinks) toward it
const step = (dir, extend) => (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof BlockSelection)) return false;
  const all = visibleBlocks(state.doc);
  let i = all.indexOf(sel.headBlock);
  if (i < 0) i = all.findIndex((p) => p > sel.headBlock) - 1;
  // a selection of several: from its first block up, its last down
  if (!extend && sel.anchorBlock !== sel.headBlock) {
    const end = dir < 0 ? sel.rows[0] : sel.rows.filter((p) => all.includes(p)).pop();
    i = all.indexOf(end);
  }
  const next = all[Math.max(0, Math.min(all.length - 1, i + dir))];
  if (dispatch) dispatch(state.tr.setSelection(BlockSelection.blocks(state.doc, extend ? sel.anchorBlock : next, next)).scrollIntoView());
  return true;
};

// Enter / Escape over selected blocks: back to editing, the caret at the end
// of the line selected last
const edit = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof BlockSelection)) return false;
  const line = state.doc.nodeAt(sel.headBlock).firstChild;
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, sel.headBlock + 1 + line.nodeSize - 1)).scrollIntoView());
  return true;
};

const KEYS = {
  ArrowUp: step(-1, false),
  ArrowDown: step(1, false),
  "Shift-ArrowUp": step(-1, true),
  "Shift-ArrowDown": step(1, true),
  Enter: edit,
  Escape: edit,
  // (a step of its own to undo, even right after a drag)
  Backspace: (state, dispatch) => { if (dispatch) dispatch(closeHistory(state.tr.deleteSelection().scrollIntoView())); return true; },
};
KEYS.Delete = KEYS.Backspace;

const keyName = (ev) => (ev.shiftKey ? "Shift-" : "") + ev.key;
const isBlocks = (state) => state.selection instanceof BlockSelection;

export const blockSelection = new Plugin({
  // A selection across blocks becomes one of blocks. One of text that is
  // just an image is the image's: WebKit reads a selected image back from the
  // page (on a focus change, say) as text around it.
  appendTransaction(trs, _old, state) {
    if (!trs.some((tr) => tr.selectionSet || tr.docChanged)) return null;
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || sel.empty) return null;
    if (sel.to - sel.from === 1 && state.doc.nodeAt(sel.from)?.type === T.image) return state.tr.setSelection(NodeSelection.create(state.doc, sel.from));
    if (blockAt(state.doc, sel.anchor) === blockAt(state.doc, sel.head)) return null;
    return state.tr.setSelection(new BlockSelection(sel.$anchor, sel.$head));
  },
  props: {
    // The selected blocks are tinted as one piece: one under the other, only
    // the corners on its outside are rounded (a block indented further than
    // the one beside it has its left corner on that side out too).
    decorations(state) {
      const sel = state.selection;
      if (!(sel instanceof BlockSelection)) return null;
      const { doc } = state, roots = sel.roots;
      const depth = (i) => (i < 0 || i >= roots.length ? Infinity : doc.resolve(roots[i]).depth);
      const R = "var(--sel-radius)";
      return DecorationSet.create(doc, roots.map((p, i) => {
        const first = i === 0, last = i === roots.length - 1, d = depth(i);
        // tl tr br bl; a left corner is out where the block beside it starts further right
        const corners = [first || depth(i - 1) > d, first, last, last || depth(i + 1) > d];
        return Decoration.node(p, p + doc.nodeAt(p).nodeSize, { class: "pm-block-selected", style: `border-radius: ${corners.map((c) => (c ? R : "0")).join(" ")}` });
      }));
    },
    handleKeyDown(view, ev) {
      if (!isBlocks(view.state) || ev.isComposing) return false;
      const run = !ev.metaKey && !ev.ctrlKey && !ev.altKey && KEYS[keyName(ev)];
      if (run) return run(view.state, view.dispatch);
      // ⌘ / Ctrl keys go on (undo, copy, cut, ⌘↵ for tasks); Tab and keys
      // that would type over them do nothing
      if (ev.metaKey || ev.ctrlKey) return false;
      return ev.key.length === 1 || ev.key === "Tab";
    },
    handleKeyPress: (view) => isBlocks(view.state),
    handleTextInput: (view) => isBlocks(view.state),
    handleDOMEvents: {
      beforeinput(view, ev) {
        if (!isBlocks(view.state) || /^(insertFromPaste|deleteByCut|historyUndo|historyRedo)$/.test(ev.inputType)) return false;
        ev.preventDefault();
        return true;
      },
    },
  },
});
