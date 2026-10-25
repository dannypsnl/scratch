import { TextSelection } from "prosemirror-state";
import { schema } from "./schema.js";
import { newId } from "./outline-io.js";
import { inMath } from "./nav.js";

// Inline code works like a formula: ` starts it, and then ` or Escape leaves
// it (Enter from inside goes to its end; at its end it is Enter as usual).
// The caret at the edge of a code run is either in or out, which is what the
// next character typed becomes: at its end it is in, at its start out, and
// ← → step between the two before moving on. A bracket typed on a selection
// in code (inline, or a code block) wraps it, still selected.

const T = schema.nodes;
const CODE = schema.marks.code;
const isCode = (n) => !!n?.marks.some((m) => m.type === CODE);
const hasCode = (marks) => marks.some((m) => m.type === CODE);

// The marks the next character typed gets.
export const marksAt = (state) => state.storedMarks ?? state.selection.$head.marks();
// In inline code, or in a code block: plain text, no formulas, links or tags.
export const inCode = (state) => state.selection.$head.parent.type === T.codeblock || hasCode(marksAt(state));

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

const go = (state, dispatch, pos, marks) => {
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)).setStoredMarks(marks).scrollIntoView());
  return true;
};

// Out of the inline code, after its end (` or Escape).
export const leaveCode = (state, dispatch) => {
  const $p = state.selection.$head;
  if ($p.parent.type === T.codeblock || !hasCode(marksAt(state))) return false;
  const run = codeRun($p);
  return go(state, dispatch, run ? run.to : $p.pos, []);
};

// Enter from inside inline code: to its end, still in it. At its end (or
// start) it is left alone, so Enter splits the line as it always does.
export const enterInCode = (state, dispatch) => {
  const { $head, empty } = state.selection;
  if (!empty || $head.parent.type === T.codeblock || !hasCode(marksAt(state))) return false;
  const run = codeRun($head);
  if (!run || $head.pos === run.to || $head.pos === run.from) return false;
  return go(state, dispatch, run.to, null);
};

// ← → at the edge of inline code: between in and out before moving on.
export const codeStep = (dir) => (state, dispatch) => {
  const sel = state.selection;
  if (!sel.empty || sel.$head.parent.type === T.codeblock) return false;
  const $p = sel.$head;
  const inside = hasCode(marksAt(state));
  const before = isCode($p.nodeBefore), after = isCode($p.nodeAfter);
  const set = (marks) => { if (dispatch) dispatch(state.tr.setStoredMarks(marks)); return true; };
  if (dir > 0) {
    if (inside && before && !after) return set([]); // at the end, in: out
    if (!inside && after && !before) return set([CODE.create()]); // before it: in
    return false;
  }
  if (!inside && before && !after) return set(null); // after it: in (where its end is by itself)
  if (inside && after && !before) return set(null); // at the start, in: out
  const run = codeRun($p);
  if (inside && run && $p.pos === run.from + 1) return go(state, dispatch, run.from, [CODE.create()]); // to the start, still in
  return false;
};

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
  if (!block) {
    let ok = true;
    state.doc.nodesBetween(from, to, (n) => { if (n.isInline && (!n.isText || !isCode(n))) ok = false; });
    if (!ok) return false;
  }
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
  if ($head.parent.type === T.codeblock) return wrapBrackets(state, dispatch, ch);
  const inside = hasCode(marksAt(state));
  if (ch === "`") {
    if (!empty) return toggleCode(state, dispatch);
    if (!inside) { dispatch(state.tr.setStoredMarks([CODE.create()])); return true; }
    if (codeRun($head)) return leaveCode(state, dispatch);
    // `` with nothing typed between: a backtick itself
    dispatch(state.tr.replaceSelectionWith(schema.text("`"), false).setStoredMarks([]).scrollIntoView());
    return true;
  }
  return inside && wrapBrackets(state, dispatch, ch);
}
