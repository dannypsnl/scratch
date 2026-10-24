import { Plugin, TextSelection, NodeSelection } from "prosemirror-state";
import { Fragment } from "prosemirror-model";
import { schema, isMathContainer } from "./schema.js";
import { structSpec, SYMBOLS, SHORTHANDS } from "./specs.js";
import { scriptPartner } from "./stack.js";

// Inside a formula every caret move is computed from the model, never left to
// the browser: contenteditable caret behaviour around nested inline spans is
// exactly what makes formula editing feel broken.

const T = schema.nodes;

export function mathDepth($pos) {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type === T.math) return d;
  return -1;
}
export const inMath = ($pos) => mathDepth($pos) > 0;

// Inline things the browser cannot place a caret around reliably: formulas
// and atoms (links, tags, block refs, images). Beside one of them, moving,
// typing and deleting are done here, never by contenteditable.
export const isSpecialInline = (n) => !!n && !n.isText && n.isInline;
export const besideSpecial = ($p) => isSpecialInline($p.nodeBefore) || isSpecialInline($p.nodeAfter);

// Tags are drawn at the end of the block's row, not in the line: as far as
// the caret is concerned they have no width, so moves pass over them.
export const isTag = (n) => !!n && n.type === T.link && n.attrs.tag;
export function skipTags(doc, pos, dir) {
  for (;;) {
    const $p = doc.resolve(pos);
    const n = dir > 0 ? $p.nodeAfter : $p.nodeBefore;
    if (!isTag(n)) return pos;
    pos += dir * n.nodeSize;
  }
}

const isScript = (n) => n.type === T.sub || n.type === T.sup;

const caret = (state, dispatch, pos) => {
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)).setMeta(navGuard, true).scrollIntoView());
  return true;
};

// WebKit canonicalises a caret placed just after a formula into the end of
// the formula's last text, and ProseMirror then reads that back as a new
// selection: the caret is pulled straight back in. After a move made here,
// selection changes that come from the DOM (not a click) are ignored for a
// moment, so the model position wins.
export const navGuard = new Plugin({
  state: {
    init: () => 0,
    apply: (tr, last) => (tr.getMeta(navGuard) ? Date.now() : last),
  },
  filterTransaction(tr, state) {
    if (tr.docChanged || !tr.selectionSet || tr.getMeta(navGuard) || tr.getMeta("pointer")) return true;
    return Date.now() - navGuard.getState(state) > 300;
  },
});

// ---------- selection shape ----------

// Every selection is put in shape here, whichever way it was made (keys, a
// drag, the browser's own word selection): a function of the document and
// the raw ends alone.
// - Both ends in one container: an end inside a formula, or inside a
//   structure, grows to take in the whole of it.
// - No caret between a stacked script pair (x^2_i between 2 and i): drawn at
//   the same spot as the start of the stack, it goes before the stack.
export function shapeSelection(doc, anchor, head) {
  if (anchor === head) {
    const $h = doc.resolve(head);
    if (!isMathContainer($h.parent.type) || !$h.nodeBefore || !$h.nodeAfter) return null;
    const i = $h.index();
    return scriptPartner($h.parent, i - 1) === i ? [head - $h.nodeBefore.nodeSize, head - $h.nodeBefore.nodeSize] : null;
  }
  const $a = doc.resolve(anchor), $h = doc.resolve(head);
  let d = $a.sharedDepth(head);
  while (d > 0 && !(isMathContainer($a.node(d).type) || $a.node(d).isTextblock)) d--;
  if (d === 0) return null; // across blocks
  let a = anchor, h = head;
  if ($a.depth > d) a = anchor < head ? $a.before(d + 1) : $a.after(d + 1);
  if ($h.depth > d) h = head < anchor ? $h.before(d + 1) : $h.after(d + 1);
  return a === anchor && h === head ? null : [a, h];
}

export const selectionShape = new Plugin({
  appendTransaction(trs, _old, state) {
    if (!trs.some((tr) => tr.selectionSet || tr.docChanged)) return null;
    const sel = state.selection;
    if (!(sel instanceof TextSelection)) return null;
    const shaped = shapeSelection(state.doc, sel.anchor, sel.head);
    return shaped && state.tr.setSelection(TextSelection.create(state.doc, ...shaped)).setMeta(navGuard, true);
  },
});

// ---------- Left / Right ----------

function stepRight($p) {
  const n = $p.nodeAfter;
  if (n) {
    if (n.type === T.struct) return $p.pos + 2; // into first slot
    if (n.type === T.sup || n.type === T.sub) return $p.pos + 1;
    return $p.pos + 1; // one char of text, or a sym atom
  }
  const parent = $p.parent;
  if (parent.type === T.slot) {
    const d = $p.depth;
    const struct = $p.node(d - 1);
    return $p.index(d - 1) < struct.childCount - 1 ? $p.after() + 1 : $p.after(d - 1);
  }
  if (isScript(parent)) {
    const d = $p.depth;
    const idx = $p.index(d - 1);
    if (scriptPartner($p.node(d - 1), idx) === idx + 1) return $p.after() + 1; // into stacked partner
  }
  return $p.after(); // out of math / sup / sub
}

function stepLeft($p) {
  const n = $p.nodeBefore;
  if (n) {
    if (n.type === T.struct) return $p.pos - 2; // into end of last slot
    return $p.pos - 1;
  }
  if ($p.parent.type === T.slot) {
    const d = $p.depth;
    return $p.index(d - 1) > 0 ? $p.before() - 1 : $p.before(d - 1);
  }
  if (isScript($p.parent)) {
    const d = $p.depth;
    const idx = $p.index(d - 1);
    if (scriptPartner($p.node(d - 1), idx) === idx - 1) return $p.before() - 1;
  }
  return $p.before();
}

export const horizontal = (dir) => (state, dispatch) => {
  const sel = state.selection;
  if (sel instanceof NodeSelection && inMath(sel.$from)) return caret(state, dispatch, dir > 0 ? sel.to : sel.from);
  if (!sel.empty) {
    if (!inMath(sel.$from) && !inMath(sel.$to)) return false;
    return caret(state, dispatch, dir > 0 ? sel.to : sel.from);
  }
  const $p = sel.$head;
  if (!isMathContainer($p.parent.type)) {
    // plain text: take over beside a formula (stepping in, and stepping
    // away, where the DOM caret cannot be trusted; see navGuard)
    if (dir > 0 && $p.nodeAfter?.type === T.math) return caret(state, dispatch, $p.pos + 1);
    if (dir < 0 && $p.nodeBefore?.type === T.math) return caret(state, dispatch, $p.pos - 1);
    if (!besideSpecial($p)) return false;
    const from = skipTags(state.doc, $p.pos, dir);
    const $f = state.doc.resolve(from);
    const n = dir > 0 ? $f.nodeAfter : $f.nodeBefore;
    if (!n) return from === $p.pos ? false : caret(state, dispatch, from); // line edge: the browser goes on to the next line
    if (n.type === T.math) return caret(state, dispatch, from + dir); // into the formula
    return caret(state, dispatch, skipTags(state.doc, from + dir * (n.isText ? 1 : n.nodeSize), dir));
  }
  return caret(state, dispatch, dir > 0 ? stepRight($p) : stepLeft($p));
};

// ---------- Up / Down ----------

// Caret positions directly inside a container node starting at contentStart.
function positionsIn(node, contentStart) {
  const out = [contentStart];
  let pos = contentStart;
  node.forEach((child) => {
    if (child.isText) for (let k = 0; k < child.text.length; k++) out.push(++pos);
    else out.push((pos += child.nodeSize));
  });
  return out;
}

function nearestX(view, node, contentStart, x) {
  let best = contentStart, bestD = Infinity;
  for (const p of positionsIn(node, contentStart)) {
    const d = Math.abs(view.coordsAtPos(p).left - x);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// Start of slot `idx` content, for a struct node starting at structPos.
function slotStart(struct, structPos, idx) {
  let pos = structPos + 1;
  for (let k = 0; k < idx; k++) pos += struct.child(k).nodeSize;
  return pos + 1;
}

// Up / Down from plain text. WebKit counts \overset's label as a line of its
// own, so on a line holding one it moves the caret into the label instead of
// to the next line. Here the next line is found by probing further and further
// away until a position on another line turns up; in a formula the caret
// lands on the formula's own row. The column is kept across repeated presses.
let goal = null;

function intoLine(view, dir, scrolled = false) {
  const { state } = view;
  const head = state.selection.head;
  const c = view.coordsAtPos(head);
  const x = goal?.pos === head ? goal.x : c.left;
  const h = c.bottom - c.top;
  for (let k = 1; k <= 6; k++) {
    const y = dir > 0 ? c.bottom + (k * h) / 2 : c.top - (k * h) / 2;
    if (!scrolled && (y < 0 || y > window.innerHeight)) {
      // the next line is off screen: bring it in, then look again
      window.scrollBy(0, y < 0 ? y - 2 * h : y - window.innerHeight + 2 * h);
      return intoLine(view, dir, true);
    }
    const hit = view.posAtCoords({ left: x, top: y });
    if (!hit) break; // past the editor's first or last line
    let $hit = state.doc.resolve(hit.pos);
    if (!$hit.parent.inlineContent) {
      // past the end of a shorter line: the end of that line
      const near = TextSelection.findFrom($hit, -1, true) ?? TextSelection.findFrom($hit, 1, true);
      if (!near) continue;
      $hit = near.$head;
    }
    const d = mathDepth($hit);
    const pos = d > 0 ? nearestX(view, $hit.node(d), $hit.start(d), x) : $hit.pos;
    if (Math.abs(view.coordsAtPos(pos).bottom - c.bottom) < h / 2) continue; // still this line
    caret(state, view.dispatch, pos);
    goal = { pos: view.state.selection.head, x };
    return true;
  }
  // no line that way: to the start / end of this line, as browsers do, rather
  // than letting the browser pick (it takes a raised label for a line)
  const $h = state.selection.$head;
  let d = $h.depth;
  while (d > 0 && !$h.node(d).isTextblock) d--;
  return caret(state, view.dispatch, dir < 0 ? $h.start(d) : $h.end(d));
}

export const vertical = (dir) => (state, dispatch, view) => {
  const sel = state.selection;
  const $p = sel.$head;
  if (!inMath($p)) return view && sel.empty ? intoLine(view, dir) : false;
  if (!view) return true;
  const x = view.coordsAtPos($p.pos).left;
  const go = (node, contentStart) => caret(state, dispatch, nearestX(view, node, contentStart, x));

  // 1. move between rows of the innermost struct that has a row in that direction
  for (let d = $p.depth; d > 0; d--) {
    const here = $p.node(d);
    if (isScript(here)) {
      // sup is above sub: Up from sub / Down from sup switches within the stack
      if ((here.type === T.sub) !== (dir < 0)) continue;
      const parent = $p.node(d - 1), idx = $p.index(d - 1);
      const k = scriptPartner(parent, idx);
      if (k < 0) continue;
      const other = parent.child(k);
      const otherPos = k > idx ? $p.after(d) : $p.before(d) - other.nodeSize;
      return go(other, otherPos + 1);
    }
    if (here.type !== T.slot) continue;
    const struct = $p.node(d - 1);
    const { rows } = structSpec(struct.attrs.name, struct.childCount);
    const idx = $p.index(d - 1);
    const r = rows.findIndex((row) => row.includes(idx)) + dir;
    if (r < 0 || r >= rows.length) continue;
    const target = rows[r][0];
    const structPos = $p.before(d - 1);
    return go(struct.child(target), slotStart(struct, structPos, target));
  }

  // 2. enter an adjacent struct / script from outside
  const adj = [];
  if ($p.nodeBefore) adj.push([$p.nodeBefore, $p.pos - $p.nodeBefore.nodeSize]);
  if ($p.nodeAfter) adj.push([$p.nodeAfter, $p.pos]);
  for (const [n, pos] of adj) {
    if (n.type === T.struct) {
      const { rows } = structSpec(n.attrs.name, n.childCount);
      if (rows.length < 2) continue;
      const target = (dir < 0 ? rows[0] : rows[rows.length - 1])[0];
      return go(n.child(target), slotStart(n, pos, target));
    }
    if ((n.type === T.sup && dir < 0) || (n.type === T.sub && dir > 0)) return go(n, pos + 1);
  }
  // 3. on to the next line; never let the browser move the caret inside a formula
  if (sel.empty) intoLine(view, dir);
  return true;
};

// ---------- Backspace / Delete ----------

// Replace a struct / sup / sub with its contents (slots concatenated).
function unwrap(state, dispatch, node, pos) {
  const parts = [];
  if (node.type === T.struct) node.forEach((slot) => slot.forEach((c) => parts.push(c)));
  else node.forEach((c) => parts.push(c));
  if (dispatch) {
    const tr = state.tr.replaceWith(pos, pos + node.nodeSize, Fragment.fromArray(parts));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, pos)).scrollIntoView());
  }
  return true;
}

const selectNode = (state, dispatch, pos) => {
  if (dispatch) dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
  return true;
};

const del = (state, dispatch, from, to) => {
  if (dispatch) dispatch(state.tr.delete(from, to).scrollIntoView());
  return true;
};

const isStructural = (n) => n.type === T.struct || n.type === T.sup || n.type === T.sub;

export const backspace = (state, dispatch) => {
  const sel = state.selection;
  if (!sel.empty) return false; // default deleteSelection
  const $p = sel.$head;
  // right after a shorthand turned into a symbol, or "/" into a fraction:
  // give back what was typed
  if (lastShorthand && lastShorthand.doc === state.doc && lastShorthand.at === $p.pos) {
    const { from, to = $p.pos, text, content = Fragment.from(schema.text(text)) } = lastShorthand;
    lastShorthand = null;
    if (dispatch) {
      const tr = state.tr.replaceWith(from, to, content);
      dispatch(tr.setSelection(TextSelection.create(tr.doc, from + content.size)).scrollIntoView());
    }
    return true;
  }
  if (!isMathContainer($p.parent.type)) {
    if ($p.nodeBefore?.type === T.math) return selectNode(state, dispatch, $p.pos - $p.nodeBefore.nodeSize);
    // a tag / link / ref / image goes in one press
    if (isSpecialInline($p.nodeBefore)) return del(state, dispatch, $p.pos - $p.nodeBefore.nodeSize, $p.pos);
    // just before one, the DOM caret may be inside it: delete in the model
    if (isSpecialInline($p.nodeAfter) && $p.nodeBefore?.isText) return del(state, dispatch, $p.pos - 1, $p.pos);
    return false;
  }
  const n = $p.nodeBefore;
  if (n) {
    // first Backspace selects a structure, second deletes it
    if (isStructural(n)) return selectNode(state, dispatch, $p.pos - n.nodeSize);
    return del(state, dispatch, $p.pos - 1, $p.pos);
  }
  const parent = $p.parent;
  const d = $p.depth;
  if (parent.type === T.math) {
    if (parent.childCount === 0) return del(state, dispatch, $p.before(), $p.after());
    return caret(state, dispatch, $p.before());
  }
  if (parent.type === T.slot) {
    if ($p.index(d - 1) > 0) return caret(state, dispatch, $p.before() - 1);
    return unwrap(state, dispatch, $p.node(d - 1), $p.before(d - 1));
  }
  return unwrap(state, dispatch, parent, $p.before()); // sup / sub
};

export const deleteForward = (state, dispatch) => {
  const sel = state.selection;
  if (!sel.empty) return false;
  const $p = sel.$head;
  if (!isMathContainer($p.parent.type)) {
    if ($p.nodeAfter?.type === T.math) return selectNode(state, dispatch, $p.pos);
    if (isSpecialInline($p.nodeAfter)) return del(state, dispatch, $p.pos, $p.pos + $p.nodeAfter.nodeSize);
    if (isSpecialInline($p.nodeBefore) && $p.nodeAfter?.isText) return del(state, dispatch, $p.pos, $p.pos + 1);
    return false;
  }
  const n = $p.nodeAfter;
  if (n) {
    if (isStructural(n)) return selectNode(state, dispatch, $p.pos);
    return del(state, dispatch, $p.pos, $p.pos + 1);
  }
  if ($p.parent.type === T.math && $p.parent.childCount === 0) return del(state, dispatch, $p.before(), $p.after());
  return true;
};

export const exitMath = (state, dispatch) => {
  const d = mathDepth(state.selection.$head);
  if (d < 0) return false;
  return caret(state, dispatch, state.selection.$head.after(d));
};

// ---------- typing ----------

// Replace the selection with `node` and put the caret `offset` positions into it.
function insertNode(state, dispatch, node, offset) {
  const { from, to } = state.selection;
  if (dispatch) {
    const tr = state.tr.replaceWith(from, to, node);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, from + offset)).scrollIntoView());
  }
  return true;
}

// A selection within one container becomes the struct's main argument
// (\overset's base, a fraction's numerator); the caret then goes to the first
// slot still empty, or after the struct when none is.
export function insertStruct(state, dispatch, name, arity) {
  const { from, to, $from, $to, empty } = state.selection;
  const content = !empty && $from.sameParent($to) ? state.doc.slice(from, to).content : Fragment.empty;
  const main = structSpec(name, arity).wrap ?? 0;
  const slots = Array.from({ length: arity }, (_, k) => T.slot.create(null, k === main ? content : null));
  const node = T.struct.create({ name }, slots);
  let offset = 1, target = node.nodeSize;
  node.forEach((slot) => {
    if (target === node.nodeSize && !slot.content.size) target = offset + 1;
    offset += slot.nodeSize;
  });
  return insertNode(state, dispatch, node, target);
}

// \mathbb{R} and friends: one struct around one letter, caret after it.
export function insertLetterStruct(state, dispatch, name, letter) {
  const node = T.struct.create({ name }, T.slot.create(null, schema.text(letter)));
  return insertNode(state, dispatch, node, node.nodeSize);
}

export function insertSym(state, dispatch, name) {
  return insertNode(state, dispatch, T.sym.create({ name }), 1);
}

// "/" turns the selection, or the token just before the caret, into a numerator.
// `undo` is filled with what Backspace needs to make it a plain "/" again.
function insertFrac(state, dispatch, undo = {}) {
  const sel = state.selection;
  let from = sel.from, to = sel.to, num = Fragment.empty;
  if (!sel.empty && sel.$from.sameParent(sel.$to)) {
    num = state.doc.slice(from, to).content;
  } else if (sel.empty) {
    const before = sel.$head.nodeBefore;
    if (before?.isText) {
      const m = /[A-Za-z0-9]+$/.exec(before.text);
      if (m) from = to - m[0].length;
    } else if (before) {
      from = to - before.nodeSize;
    }
    num = state.doc.slice(from, to).content;
  }
  const numSlot = T.slot.create(null, num);
  const frac = T.struct.create({ name: "frac" }, [numSlot, T.slot.create()]);
  if (dispatch) {
    const tr = state.tr.replaceWith(from, to, frac);
    Object.assign(undo, { from, to: from + frac.nodeSize, content: num.append(Fragment.from(schema.text("/"))) });
    const caretPos = num.size ? from + 1 + numSlot.nodeSize + 1 : from + 2;
    dispatch(tr.setSelection(TextSelection.create(tr.doc, caretPos)).scrollIntoView());
  }
  return true;
}

// Handle one typed character while the caret is inside a formula.
// Returns false only when the character should open the command palette.
export function typeInMath(view, ch) {
  const { state, dispatch } = view;
  switch (ch) {
    case "\\": return false;
    case "^": return insertNode(state, dispatch, T.sup.create(), 1);
    case "_": return insertNode(state, dispatch, T.sub.create(), 1);
    case "/": {
      const undo = {};
      insertFrac(state, dispatch, undo);
      lastShorthand = { ...undo, doc: view.state.doc, at: view.state.selection.head };
      return true;
    }
    case "$": return exitMath(state, dispatch);
    case " ": {
      // at the end of a slot or script, Space finishes it: on to the next
      // slot, or out after the box, so the rest is not typed into the base
      const $p = state.selection.$head;
      if (state.selection.empty && $p.parent.type !== T.math && !$p.nodeAfter) caret(state, dispatch, stepRight($p));
      return true;
    }
    default: {
      const tr = state.tr.insertText(ch);
      const undo = shorthands(tr);
      dispatch(tr.scrollIntoView());
      lastShorthand = undo && { ...undo, doc: view.state.doc };
      return true;
    }
  }
}

// Turn a completed shorthand ("->", "<=", …) before the caret into its symbol.
// The tokens are the container's characters and symbols ("\\to") up to the
// caret. Returns what Backspace needs to take the conversion back, or null.
let lastShorthand = null; // { doc, from, at, text } or, for a fraction, { doc, from, to, at, content }
function shorthands(tr) {
  let undo = null;
  for (;;) {
    const $p = tr.selection.$head;
    const toks = [];
    let pos = $p.start();
    $p.parent.forEach((child) => {
      if (pos >= $p.pos) return;
      if (child.isText) for (const c of child.text.slice(0, $p.pos - pos)) toks.push({ tok: c, pos: pos++, text: c });
      else {
        const name = child.type === T.sym ? child.attrs.name : null;
        toks.push({ tok: name && "\\" + name, pos, text: name && lastText(name) });
        pos += child.nodeSize;
      }
    });
    const hit = SHORTHANDS.find(([seq]) => seq.length <= toks.length && seq.every((t, i) => toks[toks.length - seq.length + i].tok === t));
    if (!hit) break;
    const [seq, name] = hit;
    const run = toks.slice(-seq.length);
    if (run.some((t) => !t.text)) break; // a symbol picked from the palette, not typed
    const from = run[0].pos, text = run.map((t) => t.text).join("");
    tr.replaceWith(from, $p.pos, T.sym.create({ name }));
    tr.setSelection(TextSelection.create(tr.doc, from + 1));
    shorthandText.set(name, text);
    undo = { from, at: from + 1, text };
  }
  return undo;
}
// the ASCII a shorthand symbol was typed as, for chained shorthands and undo
const shorthandText = new Map();
const lastText = (name) => shorthandText.get(name) ?? null;

export function insertMath(state, dispatch) {
  return insertNode(state, dispatch, T.math.create(), 1);
}

// ---------- Option / Cmd + Left / Right ----------

// Operators split a container's contents into terms.
const OP_CHARS = new Set("+-*=<>,;");
const OP_SYM = new Set(["bin", "rel"]);

// A relation or binary operator, also one under or over a label: the arrow
// in N \overset{f}{\to} M splits terms just as a bare \to does.
function isOperator(node) {
  if (node.type === T.sym) return OP_SYM.has(SYMBOLS[node.attrs.name]?.cls);
  if (node.type !== T.struct || !["overset", "underset"].includes(node.attrs.name)) return false;
  const base = node.child(1).content;
  return base.childCount === 1 && isOperator(base.firstChild);
}

// Flat list of caret steps directly inside the container holding $p.
function items($p) {
  const out = [];
  let pos = $p.start();
  $p.parent.forEach((child) => {
    if (child.isText) {
      for (const c of child.text) out.push({ from: pos, to: ++pos, op: OP_CHARS.has(c) });
    } else {
      out.push({ from: pos, to: (pos += child.nodeSize), op: isOperator(child) });
    }
  });
  return out;
}

// Option moves term by term. Each press crosses either a run of operators or
// one term: everything up to the next operator, a structure counting as part
// of the term (it is entered only with Up/Down or plain arrows). At a
// container edge, step out.
export const term = (dir) => (state, dispatch) => {
  const sel = state.selection;
  if (!inMath(sel.$head)) {
    // in plain text a whole formula is one term
    if (!sel.empty) return false;
    const $h = sel.$head;
    if (dir > 0 && $h.nodeAfter?.type === T.math) return caret(state, dispatch, $h.pos + $h.nodeAfter.nodeSize);
    if (dir < 0 && $h.nodeBefore?.type === T.math) return caret(state, dispatch, $h.pos - $h.nodeBefore.nodeSize);
    return false;
  }
  const $p = sel.empty ? sel.$head : state.doc.resolve(dir > 0 ? sel.to : sel.from);
  if (!isMathContainer($p.parent.type)) return false;
  return caret(state, dispatch, termStep($p, dir));
};

function termStep($p, dir) {
  const list = items($p);
  if (dir > 0) {
    let k = list.findIndex((it) => it.from >= $p.pos);
    if (k < 0) return stepRight($p);
    const op = list[k].op;
    while (k < list.length && list[k].op === op) k++;
    return list[k - 1].to;
  }
  let k = list.findLastIndex((it) => it.to <= $p.pos);
  if (k < 0) return stepLeft($p);
  const op = list[k].op;
  while (k >= 0 && list[k].op === op) k--;
  return list[k + 1].from;
}

// Option-Shift: the same steps, extending the selection. Both ends stay in
// one container of the formula; an end inside a structure grows to take in
// the whole structure, and the selection never runs out of the formula.
export const selectTerm = (dir) => (state, dispatch) => {
  const sel = state.selection;
  const $h = sel.$head;
  if (!inMath($h) || !isMathContainer($h.parent.type)) return false;
  const md = mathDepth(state.doc.resolve(sel.anchor));
  if (md < 0 || sel.$anchor.before(md) !== $h.before(mathDepth($h))) return false; // ends in two formulas
  let anchor = sel.anchor;
  let head = termStep($h, dir);
  if (!inMath(state.doc.resolve(head))) head = dir > 0 ? $h.end(md) : $h.start(md);
  const $a = state.doc.resolve(anchor), $t = state.doc.resolve(head);
  let d = $a.sharedDepth(head);
  while (!isMathContainer($a.node(d).type)) d--;
  if ($a.depth > d) anchor = anchor >= head ? $a.after(d + 1) : $a.before(d + 1);
  if ($t.depth > d) head = head < anchor ? $t.before(d + 1) : $t.after(d + 1);
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, anchor, head)).setMeta(navGuard, true).scrollIntoView());
  return true;
};

// Cmd: to the edge of the whole formula; pressed again at the edge, leave it.
export const formula = (dir) => (state, dispatch) => {
  const $h = state.selection.$head;
  const d = mathDepth($h);
  if (d < 0) return false;
  const start = $h.start(d), end = $h.end(d);
  if (dir > 0) return caret(state, dispatch, $h.pos === end && state.selection.empty ? $h.after(d) : end);
  return caret(state, dispatch, $h.pos === start && state.selection.empty ? $h.before(d) : start);
};
