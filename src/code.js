import { TextSelection, Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { schema } from "./schema.js";
import { newId } from "./outline-io.js";
import { inMath } from "./nav.js";

// Inline code is typed as it reads: ` is a backtick until the next one
// closes `…` into code (the text between, in the same plain run), and while
// the caret is at it, it is drawn so, its backticks around it. The caret at either edge is just
// inside or just outside a backtick, which is what the next character typed
// becomes: by itself it is outside (the mark is not inclusive), ← → step
// between the two before moving on, and ` just inside the end steps out.
// A bracket typed on a selection in code (inline, or a code block) wraps
// it, still selected.

const T = schema.nodes;
const CODE = schema.marks.code;
const isCode = (n) => !!n?.marks.some((m) => m.type === CODE);
const hasCode = (marks) => marks.some((m) => m.type === CODE);

// The marks the next character typed gets.
export const marksAt = (state) => state.storedMarks ?? state.selection.$head.marks();
// A selection within one line that is all inline code.
function codeSelected(state) {
  const { from, to, $from, $to, empty } = state.selection;
  if (empty || !$from.sameParent($to)) return false;
  let ok = true;
  state.doc.nodesBetween(from, to, (n) => { if (n.isInline && (!n.isText || !isCode(n))) ok = false; });
  return ok;
}
// In inline code, or in a code block: plain text, no formulas, links or tags.
export const inCode = (state) => state.selection.$head.parent.type === T.codeblock || hasCode(marksAt(state)) || codeSelected(state);

// The run of inline code the position is in or beside: { from, to }.
export function codeRun($p) {
  if ($p.textOffset) {
    const n = $p.parent.child($p.index());
    if (!isCode(n)) return null;
    const from = $p.pos - $p.textOffset;
    return { from, to: from + n.nodeSize };
  }
  if (isCode($p.nodeBefore)) return { from: $p.pos - $p.nodeBefore.nodeSize, to: $p.pos };
  if (isCode($p.nodeAfter)) return { from: $p.pos, to: $p.pos + $p.nodeAfter.nodeSize };
  return null;
}

// The inline code the caret is in or beside reads as typed, its backticks
// drawn; the rest is drawn as code.
export const codeRaw = new Plugin({
  props: {
    decorations(state) {
      const run = codeRun(state.selection.$head);
      return run && DecorationSet.create(state.doc, [Decoration.inline(run.from, run.to, { class: "code-raw" })]);
    },
  },
});

const go = (state, dispatch, pos, marks) => {
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)).setStoredMarks(marks).scrollIntoView());
  return true;
};

// ← → at the edge of inline code: between just inside and just outside its
// backtick before moving on, the same stops both ways.
export const codeStep = (dir) => (state, dispatch) => {
  const sel = state.selection;
  if (!sel.empty || sel.$head.parent.type === T.codeblock) return false;
  const $p = sel.$head;
  const inside = hasCode(marksAt(state));
  const before = isCode($p.nodeBefore), after = isCode($p.nodeAfter);
  const set = (marks) => { if (dispatch) dispatch(state.tr.setStoredMarks(marks)); return true; };
  if (before !== after && inside === (dir > 0 ? before : after)) return set(inside ? [] : [CODE.create()]); // across the backtick
  // a step in it, or onto its edge, is taken here: the browser's own move
  // reaches the model a moment later, and a quick next key skipped a stop
  const next = $p.pos + dir;
  if (!(dir > 0 ? $p.nodeAfter : $p.nodeBefore)?.isText) return false;
  const run = codeRun(state.doc.resolve(next));
  if (!run && !codeRun($p)) return false;
  // (onto an edge from inside it, still inside; from outside, outside)
  const edge = run && (next === run.from || next === run.to);
  return go(state, dispatch, next, edge ? (inside ? [CODE.create()] : []) : null);
};

// Backspace or Delete over a backtick drawn around inline code: it goes,
// and the code is plain text again, its other backtick a character in it.
export const codeDelete = (dir) => (state, dispatch) => {
  const sel = state.selection;
  if (!sel.empty || sel.$head.parent.type === T.codeblock) return false;
  const $p = sel.$head;
  const inside = hasCode(marksAt(state));
  const before = isCode($p.nodeBefore), after = isCode($p.nodeAfter);
  const run = codeRun($p);
  // a character of it: the caret stays inside (at an edge too)
  if (inside && (dir < 0 ? before : after)) {
    const at = dir < 0 ? $p.pos - 1 : $p.pos;
    if (dispatch) dispatch(state.tr.delete(at, at + 1).setStoredMarks(run.to - run.from > 1 ? [CODE.create()] : []).scrollIntoView());
    return true;
  }
  // (the backtick on the side it deletes: the closing one just outside the
  // end or just inside it, the opening one just inside the start or outside)
  if (before === after || (dir < 0 ? before === inside : after === inside)) return false;
  if (!dispatch) return true;
  const text = state.doc.textBetween(run.from, run.to);
  const tr = state.tr.replaceWith(run.from, run.to, schema.text(before ? "`" + text : text + "`"));
  dispatch(tr.setSelection(TextSelection.create(tr.doc, before ? run.to + 1 : run.from)).setStoredMarks([]).scrollIntoView());
  return true;
};

// `…` closes into inline code: the text since the opening backtick (in the
// same plain run, not empty) becomes code, the caret after it.
export const closesCode = (run) => !!run?.isText && !run.marks.length && /`[^`]+$/.test(run.text);
function closeCode(state, dispatch) {
  const { $head } = state.selection;
  const run = $head.nodeBefore; // already cut at the caret
  if (!closesCode(run)) return false;
  const open = run.text.lastIndexOf("`");
  const from = $head.pos - (run.text.length - open);
  const tr = state.tr.replaceWith(from, $head.pos, schema.text(run.text.slice(open + 1), [CODE.create()]));
  dispatch(tr.setStoredMarks([]).scrollIntoView());
  return true;
}

// An empty block after the code block at $p: its first child when it has
// children on show, else its next sibling; the caret in it.
export function blockAfterCode(tr, $p, asChild) {
  const d = $p.depth - 1, block = $p.node(d);
  const at = asChild || (block.childCount > 1 && !block.attrs.folded) ? $p.after() : $p.after(d);
  tr.insert(at, T.block.create({ id: newId() }, T.line.create()));
  return tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView();
}

// Escape in a code block: to the line after it (a new one when there is none).
export const exitCodeBlock = (state, dispatch) => {
  const $p = state.selection.$from;
  if ($p.parent.type !== T.codeblock) return false;
  if (!dispatch) return true;
  const d = $p.depth - 1, block = $p.node(d);
  const from = block.childCount > 1 && !block.attrs.folded ? $p.after() : $p.after(d);
  const next = TextSelection.findFrom(state.doc.resolve(from), 1, true);
  if (next) dispatch(state.tr.setSelection(next).scrollIntoView());
  else dispatch(blockAfterCode(state.tr, $p, false));
  return true;
};

// ` on a selection within one line: plain text becomes code, the caret
// after it; code becomes plain text, still selected.
function toggleCode(state, dispatch) {
  const { from, to, $from, $to } = state.selection;
  if (!$from.sameParent($to) || !$from.parent.inlineContent || $from.parent.type === T.codeblock || inMath($from)) return false;
  let plain = true, code = true;
  state.doc.nodesBetween(from, to, (n) => {
    if (!n.isInline) return;
    if (!n.isText) plain = code = false;
    else if (isCode(n)) plain = false;
    else code = false;
  });
  if (code) {
    dispatch(state.tr.removeMark(from, to, CODE));
    return true;
  }
  if (!plain) return false;
  const node = schema.text(state.doc.textBetween(from, to), [CODE.create()]);
  const tr = state.tr.replaceWith(from, to, node);
  dispatch(tr.setSelection(TextSelection.create(tr.doc, from + node.nodeSize)).setStoredMarks([]).scrollIntoView());
  return true;
}

// A bracket or quote typed on a selection in code wraps it, which stays
// selected (so another wraps it again).
const PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'" };
function wrapBrackets(state, dispatch, ch) {
  const close = PAIRS[ch];
  const { from, to, $from, $to, empty } = state.selection;
  if (!close || empty || !$from.sameParent($to)) return false;
  const block = $from.parent.type === T.codeblock;
  if (!block && !codeSelected(state)) return false;
  const marks = block ? [] : [CODE.create()];
  const tr = state.tr.insert(to, schema.text(close, marks)).insert(from, schema.text(ch, marks));
  dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1)).scrollIntoView());
  return true;
}

// A character typed in code, or a ` typed anywhere in a line. Returns false
// when it is to be inserted as it is.
export function typeInCode(view, ch) {
  const { state, dispatch } = view;
  const { $head, empty } = state.selection;
  if (ch === "`" && $head.parent.type !== T.codeblock) {
    if (!empty) return toggleCode(state, dispatch);
    if (!hasCode(marksAt(state))) return closeCode(state, dispatch);
    // just inside the closing backtick: out past it
    if (isCode($head.nodeAfter) || !isCode($head.nodeBefore)) return false;
    dispatch(state.tr.setStoredMarks([]));
    return true;
  }
  if (wrapBrackets(state, dispatch, ch)) return true;
  // just inside the closing backtick: still inside after it
  if (!empty || !hasCode(marksAt(state)) || isCode($head.nodeAfter)) return false;
  dispatch(state.tr.insertText(ch).setStoredMarks([CODE.create()]).scrollIntoView());
  return true;
}
